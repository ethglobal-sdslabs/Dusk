import { describe, expect, it } from 'vitest'
import type { RegistrationOp, VerifiedIdentity } from '@dusk/ens'
import { enrollStorageKey, identityLine, latestOnly, loadOp, saveOp } from '../src/lib/enroll'

const controller = '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' as const
const wallet = '0x1111111111111111111111111111111111111111' as const

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

const op: RegistrationOp = {
  chainId: 11155111, controller, wallet, label: 'alice', name: 'alice.dusk.eth', secret: `0x${'ab'.repeat(32)}`, createdAt: 1,
}
const key = enrollStorageKey(op.chainId, op.controller, op.wallet)

describe('enrollment storage', () => {
  it('is scoped by chain, controller and wallet', () => {
    expect(enrollStorageKey(11155111, controller, wallet)).toBe(`dusk.ens.v1:11155111:${controller.toLowerCase()}:${wallet}`)
    expect(enrollStorageKey(1, controller, wallet)).not.toBe(enrollStorageKey(11155111, controller, wallet))
  })

  it('round-trips a pending operation and clears it', () => {
    const s = memoryStorage()
    saveOp(s, key, op)
    expect(loadOp(s, key)).toEqual(op)
    saveOp(s, key, null)
    expect(loadOp(s, key)).toBeNull()
  })

  it('treats corrupt or foreign data as nothing, and never throws', () => {
    const s = memoryStorage()
    s.setItem(key, '{not json')
    expect(loadOp(s, key)).toBeNull()
    s.setItem(key, JSON.stringify({ ...op, secret: 'short' }))
    expect(loadOp(s, key)).toBeNull()
    const blocked = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceeded') }, removeItem: () => {} }
    expect(loadOp(blocked, 'k')).toBeNull()
    expect(() => saveOp(blocked, 'k', op)).not.toThrow()
    expect(loadOp(undefined, 'k')).toBeNull()
  })

  it('discards foreign wallet, controller, chain, and parent records on reload', () => {
    const s = memoryStorage()
    for (const bad of [
      { ...op, wallet: controller }, { ...op, controller: wallet }, { ...op, chainId: 1 },
      { ...op, name: 'alice.other.eth' },
    ]) {
      s.setItem(key, JSON.stringify(bad))
      expect(loadOp(s, key, 'dusk.eth')).toBeNull()
    }
  })

  it('discards incomplete or invalid transaction state instead of crashing a page', () => {
    const s = memoryStorage()
    for (const bad of [
      null, { label: op.label, secret: op.secret }, { ...op, createdAt: -1 },
      { ...op, committedAt: 1 }, { ...op, commitTx: '0xdead' },
      { ...op, registeredAt: 1 }, { ...op, label: 'ALIСE' },
    ]) {
      s.setItem(key, JSON.stringify(bad))
      expect(() => loadOp(s, key, 'dusk.eth')).not.toThrow()
      expect(loadOp(s, key, 'dusk.eth')).toBeNull()
    }
  })
})

describe('latestOnly', () => {
  it('drops an answer that arrives after a newer question', async () => {
    const resolvers: Array<(v: string) => void> = []
    const check = latestOnly((label: string) => new Promise<string>((r) => resolvers.push(() => r(label))))
    const alice = check('alice')
    const bob = check('bob')
    resolvers[1]!('bob')
    resolvers[0]!('alice')
    expect(await bob).toEqual({ stale: false, value: 'bob' })
    expect(await alice).toEqual({ stale: true })
  })
})

describe('identityLine', () => {
  const id = (status: VerifiedIdentity['status'], name?: string): VerifiedIdentity =>
    ({ wallet, chainId: 11155111, registry: controller, status, checkedAt: 0, ...(name ? { name } : {}) })

  it('says verified only for an active name', () => {
    expect(identityLine(id('active', 'alice.dusk.eth'))).toEqual({ tone: 'ok', text: 'alice.dusk.eth · verified on Sepolia' })
    for (const status of ['unnamed', 'expired', 'mismatch', 'banned', 'unknown'] as const) {
      expect(identityLine(id(status, 'alice.dusk.eth')).text).not.toMatch(/verified/)
    }
  })

  it('tells a banned wallet what it keeps', () => {
    expect(identityLine(id('banned')).text).toMatch(/Refunds, history and earnings already owed are unaffected/)
  })

  it('is a neutral "checking" before the first read lands', () => {
    expect(identityLine(undefined).tone).toBe('muted')
  })
})
