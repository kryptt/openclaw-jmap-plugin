import { describe, it, expect } from 'vitest'

describe('config defaults', () => {
  it('uses Stalwart ClusterIP as default JMAP URL', async () => {
    const { JMAP_URL } = await import('../config.js')
    expect(JMAP_URL).toBe('http://stalwart.system:8080')
  })

  it('uses roci@hr-home.xyz as default account email', async () => {
    const { JMAP_ACCOUNT_EMAIL } = await import('../config.js')
    expect(JMAP_ACCOUNT_EMAIL).toBe('roci@hr-home.xyz')
  })

  it('builds EventSource URL with correct query params', async () => {
    const { EVENTSOURCE_URL } = await import('../config.js')
    expect(EVENTSOURCE_URL).toContain('/jmap/eventsource/')
    expect(EVENTSOURCE_URL).toContain('types=EmailDelivery')
    expect(EVENTSOURCE_URL).toContain('closeafter=no')
    expect(EVENTSOURCE_URL).toContain('ping=60')
  })

  it('builds session URL at .well-known/jmap', async () => {
    const { SESSION_URL } = await import('../config.js')
    expect(SESSION_URL).toBe('http://stalwart.system:8080/.well-known/jmap')
  })

  it('defaults inbox-only filter to true', async () => {
    const { INBOX_ONLY } = await import('../config.js')
    expect(INBOX_ONLY).toBe(true)
  })
})
