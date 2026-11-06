import { ArkivQuotaError } from '@dusk/arkiv'
import { describe, expect, it } from 'vitest'
import { QUOTA_BACKOFF_MAX_MS, readErrorOf, retryDelayMs } from '../src/lib/arkiv'

const POLL = 6000
const RPC = 'https://rpc.tiramisu.db-chain.testnet.arkiv.network'

describe('retryDelayMs', () => {
  it('keeps the normal rhythm after an ordinary failure', () => {
    expect(retryDelayMs(new Error('fetch failed'), POLL)).toBe(POLL)
  })

  it('keeps the normal rhythm when nothing failed', () => {
    expect(retryDelayMs(null, POLL)).toBe(POLL)
  })

  it('backs off when the index says the budget is spent', () => {
    expect(retryDelayMs(new ArkivQuotaError(1740), POLL)).toBeGreaterThan(POLL)
  })

  it('waits no longer than a minute, so a tab left open recovers on its own', () => {
    expect(retryDelayMs(new ArkivQuotaError(1740), POLL)).toBe(QUOTA_BACKOFF_MAX_MS)
  })

  it('honours a short wait exactly, rather than rounding it up to the cap', () => {
    expect(retryDelayMs(new ArkivQuotaError(20), POLL)).toBe(20_000)
  })

  it('never backs off to less than the poll interval', () => {
    expect(retryDelayMs(new ArkivQuotaError(1), POLL)).toBe(POLL)
  })

  it('still backs off when the server named no wait at all', () => {
    expect(retryDelayMs(new ArkivQuotaError(), POLL)).toBe(QUOTA_BACKOFF_MAX_MS)
  })
})

describe('readErrorOf', () => {
  it('names the quota and the wait, in the interface’s voice', () => {
    const message = readErrorOf(new ArkivQuotaError(1740), RPC)
    expect(message).toMatch(/budget/i)
    expect(message).toMatch(/29 minutes/)
    expect(message).not.toMatch(/sorry|apolog/i)
  })

  it('does not blame the network for a quota refusal', () => {
    expect(readErrorOf(new ArkivQuotaError(60), RPC)).not.toMatch(/did not answer/i)
  })

  it('does not claim the page is keyless, because since B4 it usually is not', () => {
    const message = readErrorOf(new ArkivQuotaError(60), RPC)
    expect(message).not.toMatch(/no API key|without a key|unauthenticated/i)
    expect(message).toMatch(/budget/i)
  })

  it('names the host for an ordinary failure, so it is clear what did not answer', () => {
    const message = readErrorOf(new Error('fetch failed'), RPC)
    expect(message).toContain('rpc.tiramisu.db-chain.testnet.arkiv.network')
    expect(message).toMatch(/did not answer/i)
  })

  it('does not put a raw RPC request into the user-facing failure message', () => {
    const message = readErrorOf(new Error('HTTP request failed.\nRequest body: {"method":"arkiv_query"}'), RPC)
    expect(message).not.toMatch(/request body|arkiv_query/i)
    expect(message).toMatch(/out of date/i)
    expect(message).toMatch(/retrying/i)
  })

  it('survives an rpc that is not a parseable URL', () => {
    expect(readErrorOf(new Error('nope'), 'not a url')).toContain('not a url')
  })

  it('never says the market is empty when the truth is that it could not read', () => {
    for (const error of [new ArkivQuotaError(60), new Error('fetch failed')]) {
      expect(readErrorOf(error, RPC)).not.toMatch(/nothing is live|empty market/i)
    }
  })
})
