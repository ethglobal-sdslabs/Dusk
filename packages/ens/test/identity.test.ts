import { describe, expect, it } from 'vitest'
import { duskName, loadEnsConfig, normalizeLabel, admission, type IdentitySnapshot } from '../src'

const wallet = '0x1111111111111111111111111111111111111111' as const
const registry = '0x2222222222222222222222222222222222222222' as const
const active: IdentitySnapshot = { wallet, registry, chainId: 11155111, status: 'active', checkedAt: 1000 }
const base = { mode: 'application-enforced' as const, action: 'new-claim' as const, wallet, registry, chainId: 11155111, now: 2000, snapshot: active }

describe('namespace inputs', () => {
  it('canonicalizes a label before hashing', () => {
    expect(duskName('Ashura', 'dusk.eth')).toEqual(duskName('ashura', 'dusk.eth'))
    expect(duskName('Ashura', 'dusk.eth').name).toBe('ashura.dusk.eth')
  })
  it.each(['ab', 'a'.repeat(33), 'alice.eth', ' alice', 'alice ', 'ali\u200bce', 'аlice', 'xn--abc', '-alice', 'alice-', 'a--b', 'ADMIN', 'api', 'a/b'])('rejects ambiguous/reserved label %s', (name) => {
    expect(() => normalizeLabel(name)).toThrow()
  })
  it('starts disabled and rejects incomplete or unsafe configuration', () => {
    expect(loadEnsConfig({}).mode).toBe('off')
    for (const env of [
      { ENS_MODE: 'display' }, { ENS_CHAIN_ID: '1.5' }, { ENS_CHAIN_ID: '16602' },
      { ENS_RPC: 'https://user:password@example.com' }, { ENS_RPC: 'javascript:alert(1)' },
      { ENS_REGISTRY_ADDRESS: 'not-an-address' }, { ENS_PARENT_NAME: 'Dusk.eth' },
      { ENS_MODE: 'enrollment', ENS_REGISTRY_ADDRESS: registry },
    ]) expect(() => loadEnsConfig(env)).toThrow()
  })
})

describe('admission boundaries', () => {
  it('allows current authenticated membership', () => expect(admission(base).allowed).toBe(true))
  it.each(['unknown', 'banned', 'revoked', 'expired', 'unnamed', 'mismatch'] as const)('denies new work when %s', (status) => {
    expect(admission({ ...base, snapshot: { ...active, status } }).allowed).toBe(false)
  })
  it('rejects stale, future, foreign wallet, foreign namespace and foreign chain snapshots', () => {
    for (const s of [undefined, { ...active, checkedAt: -20000 }, { ...active, checkedAt: 3000 },
      { ...active, wallet: registry }, { ...active, registry: wallet }, { ...active, chainId: 1 }]) {
      expect(admission({ ...base, snapshot: s }).allowed).toBe(false)
    }
  })
  it.each(['browse', 'refund', 'settle-existing'] as const)('preserves %s even if banned or unavailable', (action) => {
    expect(admission({ ...base, action, snapshot: { ...active, status: 'banned' } }).allowed).toBe(true)
    expect(admission({ ...base, action, snapshot: undefined }).allowed).toBe(true)
  })
  it('registration requires verified eligibility even in display mode', () => {
    expect(admission({ ...base, mode: 'display', action: 'register', snapshot: undefined }).allowed).toBe(false)
    expect(admission({ ...base, action: 'register' }).allowed).toBe(false)
    expect(admission({ ...base, action: 'register', snapshot: { ...active, status: 'unnamed' } }).allowed).toBe(true)
    expect(admission({ ...base, action: 'register', snapshot: { ...active, status: 'banned' } }).allowed).toBe(false)
  })
})
