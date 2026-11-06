import { describe, expect, it } from 'vitest'
import {
  ARKIV_TRANSPORT_OPTS,
  arkivChain,
  arkivTransportOpts,
  ArkivKeyRejectedError,
} from '../src/client'

describe('arkivTransportOpts', () => {
  it("disables viem's own retry, so a Retry-After is never slept on", () => {
    expect(arkivTransportOpts().retryCount).toBe(0)
    expect(arkivTransportOpts({ accessKey: 'a-key' }).retryCount).toBe(0)
  })

  it('bounds a single request, so a slow index surfaces instead of hanging', () => {
    expect(arkivTransportOpts().timeout).toBeGreaterThan(0)
    expect(arkivTransportOpts().timeout).toBeLessThanOrEqual(30_000)
  })

  it('puts the access key in the chain RPC URL, which is what sends it now', () => {
    const url = arkivChain({ accessKey: 'ark_live_example' }).rpcUrls.default.http[0]
    expect(url).toContain('rpc.rabdi.db-chain.testnet.arkiv.network')
    expect(url).toContain('ark_live_example')
  })

  it('falls back to the public endpoint when no key is given', () => {
    const bare = arkivChain({}).rpcUrls.default.http[0]
    expect(bare).toContain('rpc.rabdi.db-chain.testnet.arkiv.network')
    expect(bare).not.toContain('undefined')
  })

  it('treats an empty or whitespace key as no key, not as a blank one', () => {
    const empty = arkivChain({ accessKey: '' }).rpcUrls.default.http[0]
    expect(arkivChain({ accessKey: '   ' }).rpcUrls.default.http[0]).toBe(empty)
    expect(empty).toBe(arkivChain({}).rpcUrls.default.http[0])
  })

  it('trims the key, because an env file keeps the whitespace around a pasted value', () => {
    expect(arkivChain({ accessKey: ' ark_live_example\n' }).rpcUrls.default.http[0]).toBe(
      arkivChain({ accessKey: 'ark_live_example' }).rpcUrls.default.http[0],
    )
  })

  it('sends no fetch headers of its own, since nothing needs one', () => {
    expect('fetchOptions' in arkivTransportOpts()).toBe(false)
  })

  it('refuses a 0G inference key, which is the one paste that must never leave the process', () => {
    expect(() => arkivTransportOpts({ accessKey: 'sk-live-abcdef' })).toThrow(/API key/i)
    expect(() => arkivTransportOpts({ accessKey: 'mk-live-abcdef' })).toThrow(/API key/i)
  })

  it('does not echo the rejected value in the message it throws', () => {
    try {
      arkivTransportOpts({ accessKey: 'sk-secret-value' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error).message).not.toMatch(/secret-value/)
      expect((e as Error).message).not.toMatch(/\b(sk|mk)-/)
    }
  })

  it('reports what the index said about the budget, when it says anything', () => {
    const seen: unknown[] = []
    const opts = arkivTransportOpts({ accessKey: 'k', onQuota: (q) => seen.push(q) })
    expect(opts.onFetchResponse).toBeTypeOf('function')
    opts.onFetchResponse!(
      new Response('{}', {
        headers: { 'arkiv-quota-used-percent': '12', ratelimit: 'limit=9999, remaining=9998, reset=1' },
      }),
    )
    expect(seen).toEqual([{ usedPercent: 12, limit: 9999, remaining: 9998, resetSec: 1 }])
  })

  it('installs no response hook when there is no key and nobody listening', () => {
    expect(arkivTransportOpts().onFetchResponse).toBeUndefined()
  })

  it('installs a response hook whenever a key is sent, even with no onQuota', () => {
    expect(arkivTransportOpts({ accessKey: 'k' }).onFetchResponse).toBeDefined()
  })

  it('throws ArkivKeyRejectedError on a 401, naming the variable and not the key', () => {
    const hook = arkivTransportOpts({ accessKey: 'a-rabdi-key-sent-to-tiramisu' }).onFetchResponse!
    let thrown: unknown
    try {
      hook(new Response('{"error":"INVALID_KEY"}', { status: 401 }))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ArkivKeyRejectedError)
    expect(String(thrown)).toContain('ARKIV_ACCESS_KEY')
    expect(String(thrown)).toMatch(/UNSET/i)
    expect(String(thrown)).not.toContain('a-rabdi-key-sent-to-tiramisu')
  })

  it('does not throw on a 401 when no key was sent, since the key cannot be the cause', () => {
    const opts = arkivTransportOpts({ onQuota: () => {} })
    expect(() => opts.onFetchResponse!(new Response('', { status: 401 }))).not.toThrow()
  })

  it('still reports quota on a non-401 response when both are configured', () => {
    const seen: unknown[] = []
    const hook = arkivTransportOpts({ accessKey: 'k', onQuota: (q) => seen.push(q) }).onFetchResponse!
    hook(
      new Response('{}', {
        status: 200,
        headers: { 'arkiv-quota-used-percent': '7', ratelimit: 'limit=9999, remaining=9998, reset=1' },
      }),
    )
    expect(seen).toEqual([{ usedPercent: 7, limit: 9999, remaining: 9998, resetSec: 1 }])
  })
})

describe('ARKIV_TRANSPORT_OPTS', () => {
  it('is the keyless default, kept so a caller that needs no key reads as if there were none', () => {
    expect(ARKIV_TRANSPORT_OPTS).toEqual({ retryCount: 0, timeout: arkivTransportOpts().timeout })
  })
})
