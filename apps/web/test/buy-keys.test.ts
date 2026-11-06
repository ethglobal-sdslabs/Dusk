import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { parseSigningKey } from '../src/lib/keys'

const KEY = generatePrivateKey()
const ACCOUNT = privateKeyToAccount(KEY)

const KEY_SHAPED = /\b(sk|mk)-/

describe('parseSigningKey', () => {
  it('accepts a 0x-prefixed key and derives the identity the buyer posts under', () => {
    const parsed = parseSigningKey(KEY)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.address).toBe(ACCOUNT.address)
    expect(parsed.publicKey).toBe(ACCOUNT.publicKey)
  })

  it('accepts the same key without the 0x prefix', () => {
    const parsed = parseSigningKey(KEY.slice(2))
    expect(parsed.ok && parsed.address).toBe(ACCOUNT.address)
  })

  it('tolerates the whitespace a paste brings with it', () => {
    const parsed = parseSigningKey(`  ${KEY}\n`)
    expect(parsed.ok && parsed.address).toBe(ACCOUNT.address)
  })

  it('invites rather than scolds when the field is empty', () => {
    const parsed = parseSigningKey('   ')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/paste/i)
  })

  it('names a pasted 0G inference key for what it is, without printing the shape', () => {
    const parsed = parseSigningKey('sk-0gabcdef0123456789abcdef0123456789')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toMatch(/inference key|API key/i)
    expect(parsed.error).not.toMatch(KEY_SHAPED)
  })

  it.each([
    ['too short', '0xdeadbeef'],
    ['too long', `${KEY}00`],
    ['not hexadecimal', `0x${'z'.repeat(64)}`],
    ['an address, not a key', ACCOUNT.address],
    ['the zero key, which no account owns', `0x${'00'.repeat(32)}`],
  ])('refuses %s', (_why, raw) => {
    const parsed = parseSigningKey(raw)
    expect(parsed.ok).toBe(false)
  })

  it.each([
    'sk-0gsecretsecretsecret',
    'mk-0gsecretsecretsecret',
    `0x${'z'.repeat(64)}`,
    `${KEY}00`,
    '0xdeadbeef',
    KEY.slice(2).toUpperCase().slice(0, 40),
  ])('never echoes its input in the error (%s)', (raw) => {
    const parsed = parseSigningKey(raw)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).not.toContain(raw)
    expect(parsed.error).not.toContain(raw.replace(/^0x/, ''))
    expect(parsed.error).not.toMatch(KEY_SHAPED)
  })

  it('never echoes a very nearly valid key, which is the dangerous case', () => {
    const nearly = `${KEY.slice(0, -1)}z`
    const parsed = parseSigningKey(nearly)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).not.toContain(nearly)
    expect(parsed.error).not.toContain(KEY.slice(2, 20))
  })
})
