import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { EventSource } from 'eventsource'
import JamClient from 'jmap-jam'
import {
  JMAP_URL, JMAP_ACCOUNT_EMAIL, JMAP_PASSWORD, INBOX_ONLY,
  EVENTSOURCE_URL, SESSION_URL,
  RECONNECT_BASE_MS, RECONNECT_MAX_MS,
  GATEWAY_URL, GATEWAY_TOKEN
} from './config.js'

const LOG_PREFIX = '[jmap-plugin]'

// Basic auth header for Stalwart (jmap-jam only exposes bearerToken,
// so we pass a dummy token and override via fetchInit)
const basicAuth = `Basic ${Buffer.from(`${JMAP_ACCOUNT_EMAIL}:${JMAP_PASSWORD}`).toString('base64')}`
const authFetchInit: RequestInit = {
  headers: { Authorization: basicAuth }
}

let jam: JamClient | null = null
let accountId: string | null = null
let eventSource: EventSource | null = null
let lastEmailState: string | null = null
let reconnectAttempts = 0
let connected = false

// --- JMAP Session & Client ---

async function initJmapClient (): Promise<void> {
  // jmap-jam requires bearerToken; we override auth via fetchInit on each call.
  // Pass a placeholder token — the fetchInit Authorization header takes precedence.
  jam = new JamClient({
    bearerToken: 'basic-auth-override',
    sessionUrl: SESSION_URL,
    fetchInit: authFetchInit
  })

  const session = await jam.session
  // Find the primary account for mail capability
  const accounts = session.accounts ?? {}
  for (const [id, acct] of Object.entries(accounts)) {
    if ((acct as any)?.isPersonal) {
      accountId = id
      break
    }
  }
  // Fallback: use the primaryAccounts for mail
  if (!accountId) {
    accountId = (session as any).primaryAccounts?.['urn:ietf:params:jmap:mail'] ?? Object.keys(accounts)[0]
  }

  if (!accountId) {
    throw new Error('No JMAP mail account found')
  }
  console.log(`${LOG_PREFIX} JMAP session established, accountId=${accountId}`)
}

// --- Email Fetching ---

async function fetchNewEmails (sinceState: string): Promise<void> {
  if (!jam || !accountId) return

  try {
    // Get changed email IDs since last known state
    const [changes] = await jam.request(
      ['Email/changes', { accountId, sinceState }],
      { fetchInit: authFetchInit }
    )

    const created: string[] = (changes as any)?.created ?? []
    if (created.length === 0) {
      lastEmailState = (changes as any)?.newState ?? lastEmailState
      return
    }

    // Fetch the new emails
    const [emails] = await jam.request(
      ['Email/get', {
        accountId,
        ids: created,
        properties: ['id', 'subject', 'from', 'to', 'textBody', 'htmlBody',
          'receivedAt', 'messageId', 'inReplyTo', 'references',
          'mailboxIds', 'bodyValues'],
        fetchTextBodyValues: true
      }],
      { fetchInit: authFetchInit }
    )

    const emailList: any[] = (emails as any)?.list ?? []
    lastEmailState = (changes as any)?.newState ?? lastEmailState

    for (const email of emailList) {
      // Optionally filter to inbox only
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

// Cache the inbox mailbox ID
let inboxMailboxId: string | null = null

async function isInInbox (mailboxIds: string[]): Promise<boolean> {
  if (!inboxMailboxId && jam && accountId) {
    const [mailboxes] = await jam.request(
      ['Mailbox/get', { accountId, properties: ['id', 'role'] }],
      { fetchInit: authFetchInit }
    )
    const list: any[] = (mailboxes as any)?.list ?? []
    const inbox = list.find((m: any) => m.role === 'inbox')
    inboxMailboxId = inbox?.id ?? null
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

  // Extract plain text body
  let body = ''
  const textParts: any[] = email.textBody ?? []
  for (const part of textParts) {
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
    '',
    body
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
        message: prompt,
        sessionKey,
        metadata: {
          channel: 'email',
          from: fromAddr,
          subject,
          messageId,
          inReplyTo: email.inReplyTo,
          references: email.references
        }
      })
    })

    if (!res.ok) {
      console.error(`${LOG_PREFIX} Gateway returned ${res.status}: ${await res.text()}`)
      return
    }

    const data = await res.json() as { response?: string }
    if (data.response) {
      await sendReply(email, data.response)
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Gateway dispatch failed:`, err)
  }
}

// --- Outbound Reply ---

async function sendReply (originalEmail: any, replyBody: string): Promise<void> {
  if (!jam || !accountId) return

  const from = originalEmail.from?.[0]
  const replyTo = from?.email
  if (!replyTo) {
    console.error(`${LOG_PREFIX} Cannot reply: no sender address on original email`)
    return
  }

  const subject = originalEmail.subject?.startsWith('Re: ')
    ? originalEmail.subject
    : `Re: ${originalEmail.subject ?? '(no subject)'}`

  const originalMessageId = originalEmail.messageId?.[0]
  const references = [
    ...(originalEmail.references ?? []),
    ...(originalMessageId ? [originalMessageId] : [])
  ]

  try {
    // Step 1: Create the draft email via Email/set
    const [emailResult, emailMeta] = await jam.request(
      ['Email/set', {
        accountId,
        create: {
          draft: {
            from: [{ email: JMAP_ACCOUNT_EMAIL }],
            to: [{ email: replyTo, name: from?.name }],
            subject,
            inReplyTo: originalMessageId ? [originalMessageId] : undefined,
            references: references.length > 0 ? references : undefined,
            textBody: [{ partId: 'body', type: 'text/plain' }],
            bodyValues: { body: { value: replyBody } },
            keywords: { $draft: true, $seen: true },
            mailboxIds: await getDraftsMailboxId()
          }
        }
      }],
      {
        fetchInit: authFetchInit,
        using: ['urn:ietf:params:jmap:mail']
      }
    )

    const created = (emailResult as any)?.created?.draft
    if (!created?.id) {
      console.error(`${LOG_PREFIX} Email/set failed:`, (emailResult as any)?.notCreated)
      return
    }

    const emailId = created.id

    // Step 2: Submit the email via EmailSubmission/set
    const identityId = await getIdentityId()
    const [submitResult] = await jam.request(
      ['EmailSubmission/set', {
        accountId,
        create: {
          send: {
            emailId,
            identityId
          }
        }
      }],
      {
        fetchInit: authFetchInit,
        using: ['urn:ietf:params:jmap:submission']
      }
    )

    const submitted = (submitResult as any)?.created?.send
    if (submitted) {
      console.log(`${LOG_PREFIX} Reply sent to ${replyTo} (subject: ${subject})`)
    } else {
      console.error(`${LOG_PREFIX} EmailSubmission/set failed:`, (submitResult as any)?.notCreated)
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Reply send failed:`, err)
  }
}

// Cache identity and drafts mailbox
let identityId: string | null = null
let draftsMailboxId: Record<string, boolean> | null = null

async function getIdentityId (): Promise<string> {
  if (identityId) return identityId
  if (!jam || !accountId) throw new Error('JMAP client not initialized')

  const [identities] = await jam.request(
    ['Identity/get', { accountId }],
    {
      fetchInit: authFetchInit,
      using: ['urn:ietf:params:jmap:submission']
    }
  )
  const list: any[] = (identities as any)?.list ?? []
  const match = list.find((i: any) => i.email === JMAP_ACCOUNT_EMAIL) ?? list[0]
  if (!match?.id) throw new Error('No JMAP identity found')
  identityId = match.id
  return identityId!
}

async function getDraftsMailboxId (): Promise<Record<string, boolean>> {
  if (draftsMailboxId) return draftsMailboxId
  if (!jam || !accountId) throw new Error('JMAP client not initialized')

  const [mailboxes] = await jam.request(
    ['Mailbox/get', { accountId, properties: ['id', 'role'] }],
    { fetchInit: authFetchInit }
  )
  const list: any[] = (mailboxes as any)?.list ?? []
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
      // Update state from the push
      if (emailState) lastEmailState = emailState
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to parse state event:`, err)
    }
  })

  eventSource.addEventListener('ping', () => {
    // Keep-alive, reset reconnect counter
    reconnectAttempts = 0
  })

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

// --- Get initial email state ---

async function getInitialEmailState (): Promise<void> {
  if (!jam || !accountId) return
  const [result] = await jam.request(
    ['Email/get', { accountId, ids: [], properties: [] }],
    { fetchInit: authFetchInit }
  )
  lastEmailState = (result as any)?.state ?? null
  if (lastEmailState) {
    console.log(`${LOG_PREFIX} Initial email state: ${lastEmailState}`)
  }
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

    // Tool: email_send — allow the agent to send email proactively
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
          ? rawArgs[0]
          : rawArgs[1] ?? {}) as Record<string, string>

        if (!jam || !accountId) {
          return { content: [{ type: 'text', text: 'JMAP client not connected.' }] }
        }

        try {
          const references = args.inReplyTo ? [args.inReplyTo] : undefined
          const emailId = await createAndSubmitEmail(
            args.to, args.subject, args.body, args.inReplyTo, references
          )
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

// Shared email creation + submission logic
async function createAndSubmitEmail (
  to: string, subject: string, body: string,
  inReplyTo?: string, references?: string[]
): Promise<string> {
  if (!jam || !accountId) throw new Error('JMAP client not initialized')

  const [emailResult] = await jam.request(
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
          mailboxIds: await getDraftsMailboxId()
        }
      }
    }],
    {
      fetchInit: authFetchInit,
      using: ['urn:ietf:params:jmap:mail']
    }
  )

  const created = (emailResult as any)?.created?.draft
  if (!created?.id) {
    throw new Error(`Email/set failed: ${JSON.stringify((emailResult as any)?.notCreated)}`)
  }

  const identityId = await getIdentityId()
  const [submitResult] = await jam.request(
    ['EmailSubmission/set', {
      accountId,
      create: {
        send: { emailId: created.id, identityId }
      }
    }],
    {
      fetchInit: authFetchInit,
      using: ['urn:ietf:params:jmap:submission']
    }
  )

  const submitted = (submitResult as any)?.created?.send
  if (!submitted) {
    throw new Error(`EmailSubmission/set failed: ${JSON.stringify((submitResult as any)?.notCreated)}`)
  }

  return created.id
}
