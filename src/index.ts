import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { EventSource } from 'eventsource'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JMAP_URL, JMAP_ACCOUNT_EMAIL, JMAP_PASSWORD, INBOX_ONLY,
  EVENTSOURCE_URL, SESSION_URL,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  GATEWAY_URL, GATEWAY_TOKEN
} from './config.js'

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.jmap-state')

const LOG_PREFIX = '[jmap-plugin]'

// Stalwart authenticates by account name (not email)
const JMAP_USERNAME = JMAP_ACCOUNT_EMAIL.split('@')[0]
const basicAuth = `Basic ${Buffer.from(`${JMAP_USERNAME}:${JMAP_PASSWORD}`).toString('base64')}`
const authHeaders = { Authorization: basicAuth, 'Content-Type': 'application/json' }

let apiUrl: string | null = null
let accountId: string | null = null
let eventSource: EventSource | null = null
let lastEmailState: string | null = null
let reconnectAttempts = 0
let connected = false

// --- Raw JMAP request helper ---

async function jmapRequest (methodCalls: any[], using?: string[]): Promise<any[]> {
  if (!apiUrl) throw new Error('JMAP client not initialized')
  const capabilities = using ?? ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
  const body = JSON.stringify({ using: capabilities, methodCalls })
  const res = await fetch(apiUrl, { method: 'POST', headers: authHeaders, body })
  if (!res.ok) throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as any
  return data.methodResponses ?? []
}

// --- JMAP Session ---

async function initJmapClient (): Promise<void> {
  const sessionRes = await fetch(SESSION_URL, { headers: { Authorization: basicAuth }, redirect: 'follow' })
  if (!sessionRes.ok) {
    throw new Error(`JMAP session fetch failed: ${sessionRes.status} ${await sessionRes.text()}`)
  }
  const session = await sessionRes.json() as any

  apiUrl = session.apiUrl
  // Replace hostname in apiUrl with internal service URL (session returns external hostname)
  if (apiUrl && !apiUrl.startsWith('http://stalwart')) {
    const url = new URL(apiUrl)
    const internal = new URL(JMAP_URL)
    url.protocol = internal.protocol
    url.hostname = internal.hostname
    url.port = internal.port
    apiUrl = url.toString()
  }

  accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'] ?? null
  if (!accountId) {
    const accounts = session.accounts ?? {}
    for (const [id, acct] of Object.entries(accounts)) {
      if ((acct as any)?.isPersonal) { accountId = id; break }
    }
    if (!accountId) accountId = Object.keys(accounts)[0] ?? null
  }

  if (!accountId) throw new Error('No JMAP mail account found')
  console.log(`${LOG_PREFIX} JMAP session established, apiUrl=${apiUrl}, accountId=${accountId}`)
}

// --- Email Fetching ---

async function fetchNewEmails (sinceState: string): Promise<void> {
  if (!accountId) return

  try {
    const responses = await jmapRequest([
      ['Email/changes', { accountId, sinceState }, 'c0']
    ])

    const changes = responses.find((r: any) => r[0] === 'Email/changes')?.[1] ?? {}
    const created: string[] = changes.created ?? []
    lastEmailState = changes.newState ?? lastEmailState
    if (lastEmailState) saveState(lastEmailState)

    if (created.length === 0) return

    const emailResponses = await jmapRequest([
      ['Email/get', {
        accountId,
        ids: created,
        properties: ['id', 'subject', 'from', 'to', 'textBody', 'htmlBody',
          'receivedAt', 'messageId', 'inReplyTo', 'references',
          'mailboxIds', 'bodyValues'],
        fetchTextBodyValues: true
      }, 'e0']
    ])

    const emails = emailResponses.find((r: any) => r[0] === 'Email/get')?.[1] ?? {}
    const emailList: any[] = emails.list ?? []

    for (const email of emailList) {
      if (INBOX_ONLY) {
        const mailboxIds = email.mailboxIds ?? {}
        const inInbox = await isInInbox(Object.keys(mailboxIds))
        if (!inInbox) continue
      }
      await deliverToAgent(email)
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error fetching new emails:`, err)
  }
}

let inboxMailboxId: string | null = null

async function isInInbox (mailboxIds: string[]): Promise<boolean> {
  if (!inboxMailboxId && accountId) {
    const responses = await jmapRequest([
      ['Mailbox/get', { accountId, properties: ['id', 'role'] }, 'm0']
    ])
    const list: any[] = responses.find((r: any) => r[0] === 'Mailbox/get')?.[1]?.list ?? []
    inboxMailboxId = list.find((m: any) => m.role === 'inbox')?.id ?? null
  }
  return inboxMailboxId != null && mailboxIds.includes(inboxMailboxId)
}

// --- Gateway WebSocket ---

let ws: WebSocket | null = null
let wsReady: Promise<void> | null = null
let wsConnected = false
const wsPending = new Map<string, { resolve: (v: string) => void, reject: (e: Error) => void, timeout: ReturnType<typeof setTimeout> }>()
const chatPromises = new Map<string, { resolve: (v: string) => void, reject: (e: Error) => void, timeout: ReturnType<typeof setTimeout>, text: string }>()

function uuid (): string { return crypto.randomUUID() }

function ensureGateway (): Promise<void> {
  if (wsReady && wsConnected) return wsReady
  if (wsReady) return wsReady

  wsReady = new Promise<void>((resolve, reject) => {
    const url = GATEWAY_URL.replace(/^http/, 'ws')
    console.log(`${LOG_PREFIX} Connecting WebSocket to ${url}`)
    const socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      const connectId = uuid()
      socket.send(JSON.stringify({
        type: 'req', id: connectId, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-tui', version: '0.1.0', platform: 'node', mode: 'cli', instanceId: uuid() },
          role: 'operator',
          scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
          caps: ['tool-events'],
          ...(GATEWAY_TOKEN ? { auth: { token: GATEWAY_TOKEN } } : {})
        }
      }))

      const onConnect = (event: MessageEvent): void => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg.id === connectId) {
            socket.removeEventListener('message', onConnect)
            if (msg.error) { reject(new Error(`Gateway connect: ${JSON.stringify(msg.error)}`)); return }
            wsConnected = true; ws = socket
            console.log(`${LOG_PREFIX} Gateway WebSocket connected`)
            resolve()
          }
        } catch {}
      }
      socket.addEventListener('message', onConnect)
      setTimeout(() => { if (!wsConnected) { socket.removeEventListener('message', onConnect); reject(new Error('WS connect timeout')) } }, 10_000)
    })

    socket.addEventListener('message', (event) => {
      if (!wsConnected) return
      try {
        const msg = JSON.parse(String(event.data))
        if (msg.id && wsPending.has(msg.id)) {
          const p = wsPending.get(msg.id)!; wsPending.delete(msg.id); clearTimeout(p.timeout)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result ? JSON.stringify(msg.result) : 'ok')
          return
        }
        // Stream events for chat responses
        if (msg.type === 'event' && msg.event === 'chat') {
          const payload = msg.payload; if (!payload) return
          const content = payload.message?.content
          // Gateway streams cumulative text (full message at each point), not deltas.
          // Replace rather than append to avoid tripling the content.
          if (content && Array.isArray(content)) {
            const fullText = content
              .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join('')
            if (fullText) {
              for (const [, cp] of chatPromises) cp.text = fullText
            }
          }
          if (payload.state === 'final' || payload.state === 'error') {
            for (const [key, cp] of chatPromises) {
              clearTimeout(cp.timeout); chatPromises.delete(key)
              payload.state === 'error' ? cp.reject(new Error(payload.errorMessage ?? 'unknown')) : cp.resolve(cp.text || '(no response)')
              break
            }
          }
        }
      } catch {}
    })

    socket.addEventListener('close', () => {
      wsConnected = false; wsReady = null; ws = null
      for (const [, p] of wsPending) { clearTimeout(p.timeout); p.reject(new Error('WS closed')) }
      wsPending.clear()
      for (const [, cp] of chatPromises) { clearTimeout(cp.timeout); cp.reject(new Error('WS closed')) }
      chatPromises.clear()
    })

    socket.addEventListener('error', (e) => console.error(`${LOG_PREFIX} WS error:`, (e as any).message ?? 'unknown'))
    setTimeout(() => { if (!wsConnected) { socket.close(); reject(new Error('WS timeout')) } }, 15_000)
  })
  return wsReady
}

function sendGatewayRequest (method: string, params: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('WS not connected')); return }
    const id = uuid()
    const timeout = setTimeout(() => { wsPending.delete(id); reject(new Error(`Request timeout: ${method}`)) }, 120_000)
    wsPending.set(id, { resolve, reject, timeout })
    ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

async function gatewayChat (sessionKey: string, prompt: string): Promise<string> {
  await ensureGateway()
  const chatId = uuid()
  const result = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { chatPromises.delete(chatId); reject(new Error('Chat timeout (300s)')) }, 300_000)
    chatPromises.set(chatId, { resolve, reject, timeout, text: '' })
  })
  await sendGatewayRequest('chat.send', { sessionKey, message: prompt, deliver: true, idempotencyKey: uuid() })
  return result
}

// --- Agent Dispatch ---

async function deliverToAgent (email: any): Promise<void> {
  const from = email.from?.[0]
  const fromAddr = from?.email ?? 'unknown'
  const fromName = from?.name ?? fromAddr
  const subject = email.subject ?? '(no subject)'
  const messageId = email.messageId?.[0] ?? email.id

  let body = ''
  for (const part of (email.textBody ?? [])) {
    const val = email.bodyValues?.[part.partId]
    if (val?.value) body += val.value
  }
  if (!body) body = '(empty body)'

  const sessionKey = `email:${messageId}`
  const prompt = [
    `[Email from ${fromName} <${fromAddr}>]`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    email.inReplyTo ? `In-Reply-To: ${email.inReplyTo.join(', ')}` : '',
    '', body
  ].filter(Boolean).join('\n')

  console.log(`${LOG_PREFIX} Delivering email from ${fromAddr}: "${subject}" (session: ${sessionKey})`)

  try {
    const response = await gatewayChat(sessionKey, prompt)
    if (response) await sendReply(email, response)
  } catch (err) {
    console.error(`${LOG_PREFIX} Gateway dispatch failed:`, err)
  }
}

// --- Outbound Reply ---

async function sendReply (originalEmail: any, replyBody: string): Promise<void> {
  if (!accountId) return
  const from = originalEmail.from?.[0]
  const replyTo = from?.email
  if (!replyTo) { console.error(`${LOG_PREFIX} Cannot reply: no sender address`); return }

  const subject = originalEmail.subject?.startsWith('Re: ')
    ? originalEmail.subject : `Re: ${originalEmail.subject ?? '(no subject)'}`
  const originalMessageId = originalEmail.messageId?.[0]
  const references = [...(originalEmail.references ?? []), ...(originalMessageId ? [originalMessageId] : [])]

  try {
    await createAndSubmitEmail(replyTo, subject, replyBody, originalMessageId,
      references.length > 0 ? references : undefined)
    console.log(`${LOG_PREFIX} Reply sent to ${replyTo} (subject: ${subject})`)
  } catch (err) {
    console.error(`${LOG_PREFIX} Reply send failed:`, err)
  }
}

// Cache identity and drafts mailbox
let identityId: string | null = null
let draftsMailboxId: Record<string, boolean> | null = null

async function getIdentityId (): Promise<string> {
  if (identityId) return identityId
  if (!accountId) throw new Error('JMAP client not initialized')
  const responses = await jmapRequest(
    [['Identity/get', { accountId }, 'i0']],
    ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission']
  )
  const list: any[] = responses.find((r: any) => r[0] === 'Identity/get')?.[1]?.list ?? []
  const match = list.find((i: any) => i.email === JMAP_ACCOUNT_EMAIL) ?? list[0]
  if (!match?.id) throw new Error('No JMAP identity found')
  identityId = match.id
  return identityId!
}

async function getDraftsMailboxId (): Promise<Record<string, boolean>> {
  if (draftsMailboxId) return draftsMailboxId
  if (!accountId) throw new Error('JMAP client not initialized')
  const responses = await jmapRequest([['Mailbox/get', { accountId, properties: ['id', 'role'] }, 'm0']])
  const list: any[] = responses.find((r: any) => r[0] === 'Mailbox/get')?.[1]?.list ?? []
  const drafts = list.find((m: any) => m.role === 'drafts')
  if (!drafts?.id) throw new Error('No drafts mailbox found')
  draftsMailboxId = { [drafts.id]: true }
  return draftsMailboxId!
}

// --- EventSource SSE ---

function connectEventSource (): void {
  const url = lastEmailState
    ? `${EVENTSOURCE_URL}&pushState=${encodeURIComponent(lastEmailState)}`
    : EVENTSOURCE_URL

  console.log(`${LOG_PREFIX} Connecting to EventSource: ${url}`)

  eventSource = new EventSource(url, {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), Authorization: basicAuth }
      })
  })

  eventSource.addEventListener('state', (event: MessageEvent) => {
    reconnectAttempts = 0
    try {
      const data = JSON.parse(event.data)
      const emailState = data?.changed?.[accountId ?? '']?.['Email']
      if (emailState && lastEmailState && emailState !== lastEmailState) {
        console.log(`${LOG_PREFIX} Email state changed: ${lastEmailState} -> ${emailState}`)
        fetchNewEmails(lastEmailState).catch((err) =>
          console.error(`${LOG_PREFIX} fetchNewEmails failed:`, err)
        )
      }
      if (emailState) {
        lastEmailState = emailState
        saveState(emailState)
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to parse state event:`, err)
    }
  })

  eventSource.addEventListener('ping', () => { reconnectAttempts = 0 })

  eventSource.onerror = () => {
    console.error(`${LOG_PREFIX} EventSource error, scheduling reconnect`)
    eventSource?.close()
    scheduleReconnect()
  }

  eventSource.onopen = () => {
    connected = true
    reconnectAttempts = 0
    console.log(`${LOG_PREFIX} EventSource connected`)
  }
}

function scheduleReconnect (): void {
  connected = false
  reconnectAttempts++
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS)
  console.log(`${LOG_PREFIX} Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)
  setTimeout(() => connectEventSource(), delay)
}

function loadSavedState (): string | null {
  try {
    return readFileSync(STATE_FILE, 'utf-8').trim() || null
  } catch {
    return null
  }
}

function saveState (state: string): void {
  try {
    writeFileSync(STATE_FILE, state, 'utf-8')
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to save state:`, err)
  }
}

async function getInitialEmailState (): Promise<void> {
  if (!accountId) return

  // Get current server state
  const responses = await jmapRequest([['Email/get', { accountId, ids: [], properties: [] }, 's0']])
  const result = responses.find((r: any) => r[0] === 'Email/get')?.[1] ?? {}
  const serverState = result.state ?? null

  // Load saved state from disk — if we have one, catch up missed emails
  const savedState = loadSavedState()

  if (savedState && serverState && savedState !== serverState) {
    console.log(`${LOG_PREFIX} Catching up: saved state ${savedState} → server state ${serverState}`)
    lastEmailState = savedState
    await fetchNewEmails(savedState)
  } else {
    lastEmailState = serverState
  }

  if (lastEmailState) {
    saveState(lastEmailState)
    console.log(`${LOG_PREFIX} Email state: ${lastEmailState}`)
  }
}

// --- Plugin Entry ---

let initialized = false

export default definePluginEntry({
  id: 'openclaw-jmap-plugin',
  name: 'Email Channel (JMAP)',
  description: 'Receives and replies to email at roci@hr-home.xyz via Stalwart JMAP with real-time SSE push',
  kind: 'integration',

  register (api) {
    const init = async (): Promise<void> => {
      if (!JMAP_PASSWORD) {
        console.warn(`${LOG_PREFIX} ROCI_JMAP_PASSWORD not set, email channel disabled`)
        return
      }
      try {
        await initJmapClient()
        await getInitialEmailState()
        connectEventSource()
        console.log(`${LOG_PREFIX} Email channel active for ${JMAP_ACCOUNT_EMAIL}`)
      } catch (err) {
        console.error(`${LOG_PREFIX} Initialization failed:`, err)
      }
    }

    api.registerTool({
      name: 'email_send',
      label: 'Send Email',
      description: 'Send an email from roci@hr-home.xyz.\n\n' +
        'Parameters:\n' +
        '  to: recipient email address\n' +
        '  subject: email subject line\n' +
        '  body: plain text email body\n' +
        '  inReplyTo: (optional) Message-ID to reply to for threading',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Plain text body' },
          inReplyTo: { type: 'string', description: 'Message-ID for threading (optional)' }
        },
        required: ['to', 'subject', 'body']
      },
      async execute (...rawArgs: any[]) {
        const args = (typeof rawArgs[0] === 'object' && rawArgs[0] !== null
          ? rawArgs[0] : rawArgs[1] ?? {}) as Record<string, string>
        if (!accountId) return { content: [{ type: 'text', text: 'JMAP client not connected.' }] }
        try {
          await createAndSubmitEmail(args.to, args.subject, args.body, args.inReplyTo,
            args.inReplyTo ? [args.inReplyTo] : undefined)
          return { content: [{ type: 'text', text: `Email sent to ${args.to} (subject: ${args.subject})` }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `Send failed: ${err}` }] }
        }
      }
    })

    if (initialized) return
    initialized = true

    console.log(`${LOG_PREFIX} Starting JMAP init...`)
    init().catch((err) => { initialized = false; console.error(`${LOG_PREFIX} init failed:`, err) })
    console.log(`${LOG_PREFIX} Email Channel registered: 1 tool (email_send) + SSE push`)
  }
})

async function createAndSubmitEmail (
  to: string, subject: string, body: string,
  inReplyTo?: string, references?: string[]
): Promise<void> {
  if (!accountId) throw new Error('JMAP client not initialized')
  const draftsId = await getDraftsMailboxId()
  const identId = await getIdentityId()

  // Create draft + submit in one JMAP request
  const responses = await jmapRequest([
    ['Email/set', {
      accountId,
      create: {
        draft: {
          from: [{ email: JMAP_ACCOUNT_EMAIL }],
          to: [{ email: to }],
          subject,
          inReplyTo: inReplyTo ? [inReplyTo] : undefined,
          references: references && references.length > 0 ? references : undefined,
          textBody: [{ partId: 'body', type: 'text/plain' }],
          bodyValues: { body: { value: body } },
          keywords: { $draft: true, $seen: true },
          mailboxIds: draftsId
        }
      }
    }, 'e0'],
    ['EmailSubmission/set', {
      accountId,
      create: {
        send: { emailId: '#draft', identityId: identId }
      }
    }, 's0']
  ], ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'])

  const emailResult = responses.find((r: any) => r[0] === 'Email/set')?.[1] ?? {}
  if (!emailResult.created?.draft?.id) {
    throw new Error(`Email/set failed: ${JSON.stringify(emailResult.notCreated)}`)
  }
  const submitResult = responses.find((r: any) => r[0] === 'EmailSubmission/set')?.[1] ?? {}
  if (!submitResult.created?.send) {
    throw new Error(`EmailSubmission/set failed: ${JSON.stringify(submitResult.notCreated)}`)
  }
}
