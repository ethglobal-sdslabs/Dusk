import { describe, expect, it } from 'vitest'
import { portVerdict, REQUIRED_PORT, requestedPort } from '../src/lib/port'

describe('requestedPort', () => {
  it('defaults to the one allowlisted port when nothing asks for another', () => {
    expect(requestedPort({ argv: ['node', 'preflight'], env: {} })).toBe(REQUIRED_PORT)
  })

  it('reads `-p 3001`', () => {
    expect(requestedPort({ argv: ['next', 'dev', '-p', '3001'], env: {} })).toBe(3001)
  })

  it('reads `--port=3001`', () => {
    expect(requestedPort({ argv: ['next', 'dev', '--port=3001'], env: {} })).toBe(3001)
  })

  it('reads `--port 8080`', () => {
    expect(requestedPort({ argv: ['next', 'dev', '--port', '8080'], env: {} })).toBe(8080)
  })

  it('reads PORT from the environment', () => {
    expect(requestedPort({ argv: [], env: { PORT: '4000' } })).toBe(4000)
  })

  it('lets an explicit flag win over the environment, the way Next resolves it', () => {
    expect(requestedPort({ argv: ['next', 'dev', '-p', '3000'], env: { PORT: '3001' } })).toBe(3000)
  })

  it('returns null for a port that is not a number, rather than guessing', () => {
    expect(requestedPort({ argv: ['next', 'dev', '-p', 'auto'], env: {} })).toBeNull()
  })
})

describe('portVerdict', () => {
  it('passes on the allowlisted port with nothing already bound', () => {
    expect(portVerdict({ argv: [], env: {}, inUse: false })).toEqual({ ok: true, port: REQUIRED_PORT })
  })

  it('refuses any other port, and names friction #21 so the reason is findable', () => {
    const verdict = portVerdict({ argv: ['next', 'dev', '-p', '3001'], env: {}, inUse: false })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.message).toContain('3001')
    expect(verdict.message).toContain('friction')
    expect(verdict.message).toContain('#21')
  })

  it('explains the specific trap when the port asked for is 3001', () => {
    const verdict = portVerdict({ argv: ['next', 'dev', '-p', '3001'], env: {}, inUse: false })
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.message).toMatch(/sign-in/i)
    expect(verdict.message).toMatch(/inference/i)
  })

  it('refuses when 3000 is already bound, because Next would quietly move to 3001', () => {
    const verdict = portVerdict({ argv: [], env: {}, inUse: true })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.message).toContain('3000')
    expect(verdict.message).toContain('#21')
    expect(verdict.message).toMatch(/free/i)
  })

  it('refuses an unparseable port rather than letting it through', () => {
    const verdict = portVerdict({ argv: ['next', 'dev', '--port=auto'], env: {}, inUse: false })
    expect(verdict.ok).toBe(false)
  })

  it('names localhost rather than 127.0.0.1, which the Router does not allowlist', () => {
    const verdict = portVerdict({ argv: [], env: {}, inUse: true })
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.message).toContain('localhost:3000')
    expect(verdict.message).not.toContain('127.0.0.1')
  })
})
