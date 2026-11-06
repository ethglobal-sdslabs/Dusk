import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { createIdentityCache, type VerifiedIdentity } from '../src'

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

function fakeReader(statusOf: (w: Address) => VerifiedIdentity['status'] = () => 'active') {
  let inFlight = 0
  const seen = { calls: 0, peak: 0 }
  const release: Array<() => void> = []
  return {
    seen, release,
    identityOf: async (w: Address): Promise<VerifiedIdentity> => {
      seen.calls++
      inFlight++
      seen.peak = Math.max(seen.peak, inFlight)
      await new Promise<void>((r) => release.push(r))
      inFlight--
      return { wallet: w, chainId: 11155111, registry: wallet(9), status: statusOf(w), checkedAt: 0 }
    },
  }
}

const drain = async (r: ReturnType<typeof fakeReader>) => {
  for (let i = 0; i < 50 && (r.release.length > 0 || i < 3); i++) {
    r.release.splice(0).forEach((f) => f())
    await new Promise((s) => setTimeout(s, 0))
  }
}

describe('createIdentityCache — display only, bounded', () => {
  it('shares one read between concurrent askers for the same wallet, case-insensitively', async () => {
    const r = fakeReader()
    const cache = createIdentityCache(r, { now: () => 0 })
    const all = Promise.all([cache.get(wallet(1)), cache.get(wallet(1)), cache.get(wallet(1).toUpperCase().replace('0X', '0x') as Address)])
    await drain(r)
    await all
    expect(r.seen.calls).toBe(1)
  })

  it('never runs more than maxConcurrent reads at once', async () => {
    const r = fakeReader()
    const cache = createIdentityCache(r, { maxConcurrent: 2, now: () => 0 })
    const all = Promise.all(Array.from({ length: 7 }, (_, i) => cache.get(wallet(i + 1))))
    await drain(r)
    await all
    expect(r.seen.calls).toBe(7)
    expect(r.seen.peak).toBe(2)
  })

  it('serves from memory inside the ttl and rereads after it', async () => {
    let t = 0
    const r = fakeReader()
    const cache = createIdentityCache(r, { ttlMs: 1000, now: () => t })
    const first = cache.get(wallet(1)); await drain(r); await first
    t = 999
    await cache.get(wallet(1))
    expect(r.seen.calls).toBe(1)
    t = 1000
    const again = cache.get(wallet(1)); await drain(r); await again
    expect(r.seen.calls).toBe(2)
  })

  it('does not remember an unknown result, so an outage does not stick', async () => {
    const r = fakeReader(() => 'unknown')
    const cache = createIdentityCache(r, { now: () => 0 })
    const a = cache.get(wallet(1)); await drain(r); await a
    const b = cache.get(wallet(1)); await drain(r); await b
    expect(r.seen.calls).toBe(2)
  })

  it('forget() during an in-flight read discards that read and rereads next time', async () => {
    const r = fakeReader()
    const cache = createIdentityCache(r, { now: () => 0 })
    const stale = cache.get(wallet(1))
    cache.forget(wallet(1))
    await drain(r); await stale
    const fresh = cache.get(wallet(1)); await drain(r); await fresh
    expect(r.seen.calls).toBe(2)
  })

  it('forget() drops an entry after an ownership change', async () => {
    const r = fakeReader()
    const cache = createIdentityCache(r, { now: () => 0 })
    const a = cache.get(wallet(1)); await drain(r); await a
    cache.forget(wallet(1))
    const b = cache.get(wallet(1)); await drain(r); await b
    expect(r.seen.calls).toBe(2)
  })
})
