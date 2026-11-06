import { describe, expect, it } from 'vitest'
import { LOOPBACK_HOST, serveArgs } from '../src/lib/bind'

describe('serveArgs', () => {
  it('always binds loopback', () => {
    const r = serveArgs('dev', [])
    expect(r).toEqual({ ok: true, args: ['dev', '-H', LOOPBACK_HOST, '-p', '3000'] })
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
  })

  it('keeps an explicit port and passes other flags through', () => {
    expect(serveArgs('start', ['-p', '3000', '--turbopack'])).toEqual({
      ok: true,
      args: ['start', '-H', LOOPBACK_HOST, '-p', '3000', '--turbopack'],
    })
    expect(serveArgs('dev', ['--port=3000'])).toEqual({
      ok: true,
      args: ['dev', '-H', LOOPBACK_HOST, '--port=3000'],
    })
  })

  it.each([
    [['-H', '0.0.0.0']],
    [['--hostname', '0.0.0.0']],
    [['--hostname=0.0.0.0']],
    [['-H0.0.0.0']],
    [['-H', '127.0.0.1']],
  ])('refuses a caller-chosen hostname: %j', (rest) => {
    const r = serveArgs('dev', rest)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/api\/config/)
  })

  it('does not mistake an unrelated flag for -H', () => {
    expect(serveArgs('dev', ['--help']).ok).toBe(true)
  })
})
