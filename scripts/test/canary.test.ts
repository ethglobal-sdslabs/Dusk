import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import type { Deal, Receipt } from '@dusk/core'
import { CANARIES, canaryEveryMs, canaryLatencyMs, everyMs, judge } from '../canary'

const W = `0x${'a1'.repeat(20)}` as Address
const TEXT = 'The answer is 4.'
const HASH = keccak256(toHex(TEXT))

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'r', jobId: 'j', escrowId: `0x${'01'.repeat(32)}`, worker: W, modelServed: 'm', creditsSpent: 'x',
  tokensIn: 1, tokensOut: 1, outputRef: 'ab', outputHash: HASH, latencyMs: 1, trustMode: 'verified', ...over,
})
const deal = (over: Partial<Deal> = {}): Deal => ({
  buyer: W, worker: W, amount: 1n, outputHash: HASH, commitAtSec: 1, deadlineSec: 2, state: 'committed', ...over,
})
const run = (o: { text?: string; bytesHash?: Hex; receipt?: Receipt; deal?: Deal } = {}) =>
  judge({ text: o.text ?? TEXT, bytesHash: o.bytesHash ?? HASH, receipt: o.receipt ?? receipt(), deal: o.deal ?? deal() })

describe('judge — output, not quality', () => {
  it('passes any non-empty answer whose bytes are what was committed', () => {
    expect(run()).toEqual({ result: 'pass', check: 'delivered' })
  })

  // Answer quality is deliberately not judged: only that something was delivered.
  it('passes a wrong answer too', () => {
    const five = keccak256(toHex('five'))
    expect(run({ text: 'five', bytesHash: five, receipt: receipt({ outputHash: five }), deal: deal({ outputHash: five }) }))
      .toEqual({ result: 'pass', check: 'delivered' })
  })

  it('marks an empty answer bad', () => {
    expect(run({ text: '  ' })).toEqual({ result: 'bad', check: 'empty-answer' })
  })

  it('is illegal when the stored output does not hash to the committed hash', () => {
    expect(run({ bytesHash: keccak256(toHex('swapped')) })).toEqual({ result: 'illegal', check: 'output-hash-mismatch' })
  })

  it('is illegal when the receipt contradicts the chain', () => {
    expect(run({ receipt: receipt({ outputHash: keccak256(toHex('other')) }) })).toEqual({ result: 'illegal', check: 'receipt-contradicts-chain' })
    expect(run({ receipt: receipt({ worker: `0x${'b2'.repeat(20)}` }) })).toEqual({ result: 'illegal', check: 'receipt-contradicts-chain' })
  })

  it('charges the lie even when the answer is also empty', () => {
    expect(run({ text: '', bytesHash: keccak256(toHex('x')) }).result).toBe('illegal')
  })
})

describe('canaryLatencyMs — from the blocks Arkiv stamped, which no worker can choose', () => {
  it('is the blocks between claim and receipt, at 2s a block', () => {
    expect(canaryLatencyMs(100n, 115n)).toBe(30_000)
  })
  it('is undefined when either block is unknown or out of order', () => {
    expect(canaryLatencyMs(undefined, 115n)).toBeUndefined()
    expect(canaryLatencyMs(120n, 115n)).toBeUndefined()
  })
})

describe('CANARIES', () => {
  it('has prompts to post', () => {
    expect(CANARIES.length).toBeGreaterThan(0)
    for (const c of CANARIES) expect(c.prompt.trim()).not.toBe('')
  })
})

describe('everyMs', () => {
  it('reads --every as minutes, hours or seconds', () => {
    expect(everyMs(['--every', '30m'])).toBe(1_800_000)
    expect(everyMs(['--every', '2h'])).toBe(7_200_000)
    expect(everyMs(['--every', '90s'])).toBe(90_000)
  })

  it('is null without the flag, so a plain run posts one canary', () => {
    expect(everyMs(['node', 'canary.ts'])).toBeNull()
  })

  it('refuses a malformed or too-short interval', () => {
    expect(() => everyMs(['--every', 'soon'])).toThrow()
    expect(() => everyMs(['--every', '10s'])).toThrow()
  })
})

describe('canaryEveryMs — the automatic loop the verifier starts', () => {
  it('runs every 5 minutes by default', () => {
    expect(canaryEveryMs({})).toBe(300_000)
  })
  it('takes DUSK_CANARY_EVERY, and off disables it', () => {
    expect(canaryEveryMs({ DUSK_CANARY_EVERY: '10m' })).toBe(600_000)
    expect(canaryEveryMs({ DUSK_CANARY_EVERY: 'off' })).toBeNull()
  })
  it('refuses an interval under a minute', () => {
    expect(() => canaryEveryMs({ DUSK_CANARY_EVERY: '30s' })).toThrow(/DUSK_CANARY_EVERY/)
  })
})
