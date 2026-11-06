import { describe, expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { isSealablePubkey, seal, SealError, unseal, UnsealError } from '../src/index'

const ref = 'a1'.repeat(64)

const aliceKey = generatePrivateKey()
const bobKey = generatePrivateKey()
const alice = privateKeyToAccount(aliceKey)

describe('seal / unseal', () => {
  it('round-trips a Swarm reference through the recipient key', () => {
    const sealed = seal(ref, alice.publicKey)
    expect(unseal(sealed, aliceKey)).toBe(ref)
  })

  it('produces ciphertext that does not contain the plaintext', () => {
    expect(seal(ref, alice.publicKey).toLowerCase()).not.toContain(ref.toLowerCase())
  })

  it('refuses to unseal with a different key, rather than returning garbage', () => {
    expect(() => unseal(seal(ref, alice.publicKey), bobKey)).toThrow(UnsealError)
  })

  it('refuses input that is not ciphertext at all', () => {
    expect(() => unseal('0xdeadbeef', aliceKey)).toThrow(UnsealError)
  })

  it('is non-deterministic — two seals of one ref differ', () => {
    expect(seal(ref, alice.publicKey)).not.toBe(seal(ref, alice.publicKey))
  })

  it.each([
    ['a 33-byte non-point', `0x${'22'.repeat(33)}` as const],
    ['something far too short', '0xdeadbeef' as const],
    ['not hex at all', 'notevenhex' as const],
    ['empty', '' as const],
  ])('raises a typed SealError, not a library error, for %s', (_what, bad) => {
    expect(() => seal(ref, bad as `0x${string}`)).toThrow(SealError)
    expect(isSealablePubkey(bad)).toBe(false)
  })

  it('accepts the uncompressed key shape viem accounts expose', () => {
    expect(isSealablePubkey(alice.publicKey)).toBe(true)
    expect(() => seal(ref, alice.publicKey)).not.toThrow()
  })

  it('never puts the rejected key material into the error it throws', () => {
    const err: unknown = (() => {
      try {
        seal(ref, `0x${'22'.repeat(33)}`)
      } catch (e) {
        return e
      }
    })()
    expect((err as Error).message).not.toContain('22'.repeat(33))
    expect((err as Error).message).not.toMatch(/\b(sk|mk)-/)
  })

  it("produces ciphertext longer than Arkiv's 128-byte string attribute limit", () => {
    expect(seal(ref, alice.publicKey).length).toBeGreaterThan(128)
  })
})
