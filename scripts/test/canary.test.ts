import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import type { Deal, Receipt } from '@dusk/core'
import { CANARIES, everyMs, judge } from '../canary'

const W = `0x${'a1'.repeat(20)}` as Address
const TEXT = 'The answer is 4.'
const HASH = keccak256(toHex(TEXT))
const CASE = { prompt: 'What is 2+2? Reply with the number only.', expect: /\b4\b/ }

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  id: 'r', jobId: 'j', escrowId: `0x${'01'.repeat(32)}`, worker: W, modelServed: 'm', creditsSpent: 'x',
  tokensIn: 1, tokensOut: 1, outputRef: 'ab', outputHash: HASH, latencyMs: 1, trustMode: 'verified', ...over,
})
const deal = (over: Partial<Deal> = {}): Deal => ({
  buyer: W, worker: W, amount: 1n, outputHash: HASH, commitAtSec: 1, deadlineSec: 2, state: 'committed', ...over,
})
const run = (o: { text?: string; bytesHash?: Hex; receipt?: Receipt; deal?: Deal } = {}) =>
  judge({ canary: CASE, text: o.text ?? TEXT, bytesHash: o.bytesHash ?? HASH, receipt: o.receipt ?? receipt(), deal: o.deal ?? deal() })

describe('judge', () => {
  it('passes a correct answer whose bytes are what was committed', () => {
    expect(run()).toEqual({ result: 'pass', check: 'correct' })
  })

  it('marks a wrong answer bad', () => {
    expect(run({ text: 'five', bytesHash: keccak256(toHex('five')), receipt: receipt({ outputHash: keccak256(toHex('five')) }), deal: deal({ outputHash: keccak256(toHex('five')) }) }))
      .toEqual({ result: 'bad', check: 'wrong-answer' })
  })

  it('marks an empty answer bad', () => {
    expect(run({ text: '  ' }).result).not.toBe('pass')
  })

  it('is illegal when the stored output does not hash to the committed hash', () => {
    expect(run({ bytesHash: keccak256(toHex('swapped')) })).toEqual({ result: 'illegal', check: 'output-hash-mismatch' })
  })

  it('is illegal when the receipt contradicts the chain', () => {
    expect(run({ receipt: receipt({ outputHash: keccak256(toHex('other')) }) })).toEqual({ result: 'illegal', check: 'receipt-contradicts-chain' })
    expect(run({ receipt: receipt({ worker: `0x${'b2'.repeat(20)}` }) })).toEqual({ result: 'illegal', check: 'receipt-contradicts-chain' })
  })

  it('charges the lie even when the answer is wrong too', () => {
    expect(run({ text: 'five', bytesHash: keccak256(toHex('x')) }).result).toBe('illegal')
  })
})

describe('CANARIES', () => {
  it('each expected answer matches nothing in its own prompt, so echoing the prompt fails', () => {
    for (const c of CANARIES) expect(c.expect.test(c.prompt)).toBe(false)
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
