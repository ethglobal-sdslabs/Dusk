import { describe, expect, it } from 'vitest'
import { configRequestAllowed } from '../src/lib/config-gate'

const h = (o: Record<string, string>) => new Headers(o)

describe('configRequestAllowed', () => {
  it.each(['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST:3000'])('allows Host %s', (host) => {
    expect(configRequestAllowed(h({ host }))).toBe(true)
  })

  it.each(['192.168.1.5:3000', 'evil.example:3000', 'localhost.evil.example', '127.0.0.2:3000', ''])(
    'refuses Host %j',
    (host) => {
      expect(configRequestAllowed(h(host ? { host } : {}))).toBe(false)
    },
  )

  it('allows a same-origin fetch and a direct navigation', () => {
    expect(configRequestAllowed(h({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(configRequestAllowed(h({ host: 'localhost:3000', 'sec-fetch-site': 'none' }))).toBe(true)
  })

  it.each(['cross-site', 'same-site'])('refuses sec-fetch-site: %s', (site) => {
    expect(configRequestAllowed(h({ host: 'localhost:3000', 'sec-fetch-site': site }))).toBe(false)
  })

  it('allows a client that sends no sec-fetch-site (curl on this machine)', () => {
    expect(configRequestAllowed(h({ host: '127.0.0.1:3000' }))).toBe(true)
  })
})
