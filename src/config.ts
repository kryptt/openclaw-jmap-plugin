export const JMAP_URL = process.env.JMAP_URL ?? 'http://stalwart.system:8080'
export const JMAP_ACCOUNT_EMAIL = process.env.JMAP_ACCOUNT_EMAIL ?? 'roci@hr-home.xyz'
export const JMAP_PASSWORD = process.env.ROCI_JMAP_PASSWORD ?? ''
export const INBOX_ONLY = (process.env.JMAP_INBOX_ONLY ?? 'true') === 'true'

// EventSource SSE endpoint for real-time push
export const EVENTSOURCE_URL = `${JMAP_URL}/jmap/eventsource/?types=EmailDelivery&closeafter=no&ping=60`

// JMAP session endpoint
export const SESSION_URL = `${JMAP_URL}/.well-known/jmap`

// Reconnection
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 60000

// Gateway for dispatching agent turns
export const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789'
export const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? ''
