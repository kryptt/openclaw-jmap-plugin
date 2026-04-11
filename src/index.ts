import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { EventSource } from 'eventsource'
import {
  JMAP_URL, JMAP_ACCOUNT_EMAIL, JMAP_PASSWORD, INBOX_ONLY,
  EVENTSOURCE_URL, SESSION_URL,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  GATEWAY_URL, GATEWAY_TOKEN
} from './config.js'

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
    const res = await fetch(`${GATEWAY_URL}/api/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {})
      },
      body: JSON.stringify({
        message: prompt, sessionKey,
        metadata: { channel: 'email', from: fromAddr, subject, messageId,
          inReplyTo: email.inReplyTo, references: email.references }
      })
    })
    if (!res.ok) {
      console.error(`${LOG_PREFIX} Gateway returned ${res.status}: ${await res.text()}`)
      return
    }
    const data = await res.json() as { response?: string }
    if (data.response) await sendReply(email, data.response)
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
      if (emailState) lastEmailState = emailState
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

async function getInitialEmailState (): Promise<void> {
  if (!accountId) return
  const responses = await jmapRequest([['Email/get', { accountId, ids: [], properties: [] }, 's0']])
  const result = responses.find((r: any) => r[0] === 'Email/get')?.[1] ?? {}
  lastEmailState = result.state ?? null
  if (lastEmailState) console.log(`${LOG_PREFIX} Initial email state: ${lastEmailState}`)
}

// --- Plugin Entry ---

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

    console.log(`${LOG_PREFIX} Starting JMAP init...`)
    init().catch((err) => console.error(`${LOG_PREFIX} init failed:`, err))
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
