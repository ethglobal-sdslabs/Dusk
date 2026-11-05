import { describe, expect, it } from 'vitest'
import type { Claim, CompletionResult, Deal, Job } from '../src/types'
import {
  creditsBucketOf,
  escrowDeadlineSec,
  hasTimeToDeliver,
  isDeliverable,
  isFundedFor,
  jobExpiry,
  jobAmountWei,
  estimateInputTokens,
  fundingPrice,
  jobPriceWei,
  jobTokens,
  parseCreditBalance,
  winningClaim,
} from '../src/lifecycle'

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j',
  model: '0gm-1.0-35b-a3b',
  maxPricePer1kOut: 1_000n,
  maxTokens: 16,
  trustMode: 'verified',
  visibility: 'public',
  inputHash: `0x${'11'.repeat(32)}`,
  buyerPubkey: `0x${'22'.repeat(33)}`,
  escrowId: `0x${'33'.repeat(32)}`,
  status: 'open',
  expiresAt: 1_700_000_000_000,
  owner: `0x${'11'.repeat(20)}`,
  ...over,
})

const jobExpiring = (expiresAt: number): Job => job({ expiresAt })

const deal = (over: Partial<Deal> = {}): Deal => ({
  buyer: `0x${'11'.repeat(20)}` as Deal['buyer'],
  worker: `0x${'22'.repeat(20)}` as Deal['worker'],
  amount: 1_000n,
  outputHash: `0x${'00'.repeat(32)}`,
  commitAtSec: 0,
  deadlineSec: 1_700_000_001,
  state: 'funded',
  ...over,
})

const c = (id: string, workerId: string, claimedAt: number, createdAtBlock?: bigint): Claim => ({
  id,
  jobId: 'j',
  workerId,
  price: 1n,
  claimedAt,
  createdAtBlock: createdAtBlock ?? BigInt(claimedAt),
})

const result = (over: Partial<CompletionResult> = {}): CompletionResult => ({
  text: 'x',
  modelServed: 'm',
  tokensIn: 1,
  tokensOut: 1,
  finishReason: 'stop',
  latencyMs: 1,
  ...over,
})

describe('winningClaim', () => {
  it('picks the oldest claim', () => {
    expect(winningClaim([c('b', 'w2', 200), c('a', 'w1', 100)])?.id).toBe('a')
  })

  it('breaks an exact tie deterministically so two workers agree', () => {
    const order1 = winningClaim([c('b', 'w2', 100), c('a', 'w1', 100)])
    const order2 = winningClaim([c('a', 'w1', 100), c('b', 'w2', 100)])
    expect(order1?.id).toBe(order2?.id)
  })

  it('does not mutate the array it was given', () => {
    const claims = [c('b', 'w2', 200), c('a', 'w1', 100)]
    winningClaim(claims)
    expect(claims.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('returns undefined for no claims', () => {
    expect(winningClaim([])).toBeUndefined()
  })

  it('ignores a claimedAt of 0 when the chain says that claim was written later', () => {
    const honest = c('honest', 'w1', 1_000, 100n)
    const liar = c('liar', 'w2', 0, 101n)
    expect(winningClaim([liar, honest])?.id).toBe('honest')
  })

  it('still orders by the chain even when the lie is in the other direction', () => {
    const honest = c('honest', 'w1', 1_000, 100n)
    const liar = c('liar', 'w2', 999_999_999, 99n)
    expect(winningClaim([honest, liar])?.id).toBe('liar')
  })

  it('falls back to claimedAt for claims the chain cannot separate', () => {
    const first = c('b', 'w2', 100, 50n)
    const second = c('a', 'w1', 200, 50n)
    expect(winningClaim([second, first])?.id).toBe('b')
  })

  it('breaks a same-block, same-claimedAt tie deterministically', () => {
    const order1 = winningClaim([c('b', 'w2', 100, 50n), c('a', 'w1', 100, 50n)])
    const order2 = winningClaim([c('a', 'w1', 100, 50n), c('b', 'w2', 100, 50n)])
    expect(order1?.id).toBe(order2?.id)
  })

  it('sorts a claim with no createdAtBlock last, not first', () => {
    const known = c('known', 'w1', 5_000, 900n)
    const unknown: Claim = { id: 'unknown', jobId: 'j', workerId: 'w2', price: 1n, claimedAt: 0 }
    expect(winningClaim([unknown, known])?.id).toBe('known')
  })

  it('still returns something when no claim has a createdAtBlock', () => {
    const a: Claim = { id: 'a', jobId: 'j', workerId: 'w1', price: 1n, claimedAt: 200 }
    const b: Claim = { id: 'b', jobId: 'j', workerId: 'w2', price: 1n, claimedAt: 100 }
    expect(winningClaim([a, b])?.id).toBe('b')
  })
})

describe('jobExpiry', () => {
  it('uses the deadline when it falls before the credit reset', () => {
    const now = new Date('2026-10-29T10:00:00Z')
    const deadline = new Date('2026-10-29T10:05:00Z').getTime()
    expect(jobExpiry(deadline, { resetAt: 'daily-utc-midnight' }, now)).toBe(deadline)
  })

  it('clamps a deadline that outlives the credit reset', () => {
    const now = new Date('2026-10-29T23:50:00Z')
    const deadline = new Date('2026-10-30T02:00:00Z').getTime()
    expect(jobExpiry(deadline, { resetAt: 'daily-utc-midnight' }, now)).toBe(
      new Date('2026-10-30T00:00:00Z').getTime(),
    )
  })

  it('clamps against a compressed demo clock too', () => {
    const now = new Date('2026-10-29T13:45:10Z')
    const deadline = new Date('2026-10-29T14:30:00Z').getTime()
    expect(jobExpiry(deadline, { resetAt: { everySeconds: 300 } }, now)).toBe(
      new Date('2026-10-29T13:50:00Z').getTime(),
    )
  })
})

describe('isDeliverable', () => {
  it('rejects an empty result even when the request succeeded', () => {
    expect(isDeliverable(result({ text: '  ' }))).toBe(false)
  })

  it('accepts a non-empty result', () => {
    expect(isDeliverable(result({ text: 'x' }))).toBe(true)
  })

  it('rejects a result with no output tokens, which cannot have produced text', () => {
    expect(isDeliverable(result({ text: 'x', tokensOut: 0 }))).toBe(false)
  })
})

describe('creditsBucketOf', () => {
  it('buckets without revealing the exact balance', () => {
    expect(creditsBucketOf(5n, 100n)).toBe('<10%')
    expect(creditsBucketOf(30n, 100n)).toBe('10-50%')
    expect(creditsBucketOf(80n, 100n)).toBe('>50%')
  })

  it('reports the lowest bucket when the day start is unknown', () => {
    expect(creditsBucketOf(5n, 0n)).toBe('<10%')
  })

  it('reports the top bucket when more remains than the day started with', () => {
    expect(creditsBucketOf(150n, 100n)).toBe('>50%')
  })

  it('puts the boundaries in the lower bucket', () => {
    expect(creditsBucketOf(10n, 100n)).toBe('<10%')
    expect(creditsBucketOf(50n, 100n)).toBe('10-50%')
  })
})

describe('jobPriceWei', () => {
  it('prices a job at its ceiling over 1k output tokens', () => {
    expect(jobPriceWei(1_000_000n, 8)).toBe(8_000n)
  })

  it('rounds up, because a buyer must never underfund the ceiling it advertised', () => {
    expect(jobPriceWei(1n, 1)).toBe(1n)
    expect(jobPriceWei(3n, 500)).toBe(2n)
  })

  it('never returns zero, because fund() reverts ZeroAmount', () => {
    expect(jobPriceWei(0n, 8)).toBe(1n)
  })
})

describe('escrowDeadlineSec', () => {
  it('rounds the job expiry up to whole seconds so commit is never shut out by truncation', () => {
    expect(escrowDeadlineSec(1_700_000_000_500)).toBe(1_700_000_001)
  })
})

describe('hasTimeToDeliver', () => {
  it('refuses a job with less than the margin remaining', () => {
    expect(hasTimeToDeliver(jobExpiring(1_000 + 5_000), 1_000, 90_000)).toBe(false)
  })

  it('accepts a job with more than the margin remaining', () => {
    expect(hasTimeToDeliver(jobExpiring(1_000 + 200_000), 1_000, 90_000)).toBe(true)
  })
})

describe('isFundedFor', () => {
  it('accepts a Funded deal covering the price at this worker rate', () => {
    expect(isFundedFor(deal({ amount: 1_000n }), job(), 500n)).toBe(true)
  })

  it('rejects a deal in state none — nobody escrowed anything', () => {
    expect(isFundedFor(deal({ state: 'none' }), job(), 500n)).toBe(false)
  })

  it('rejects a deal funded by someone other than the job author', () => {
    const stolen = job({ owner: `0x${'bb'.repeat(20)}` })
    expect(isFundedFor(deal({ buyer: `0x${'aa'.repeat(20)}` }), stolen, 500n)).toBe(false)
  })

  it('accepts a buyer and owner that differ only in checksum case', () => {
    const mixed = job({ owner: '0xAaAaAAaaAAaaAaAaaAAAAaaaAaaAaAAaAaaaAaaA' })
    expect(isFundedFor(deal({ buyer: `0x${'aa'.repeat(20)}` }), mixed, 500n)).toBe(true)
  })

  it('rejects a job with no owner rather than treating it as funded', () => {
    expect(isFundedFor(deal(), job({ owner: undefined }), 500n)).toBe(false)
  })

  it('rejects a deal already committed by another worker', () => {
    expect(isFundedFor(deal({ state: 'committed' }), job(), 500n)).toBe(false)
  })

  it('rejects a deal funded below this worker rate', () => {
    expect(isFundedFor(deal({ amount: 1n }), job(), 500n)).toBe(false)
  })

  it('rejects a deal whose on-chain deadline is earlier than the job entity claims', () => {
    expect(isFundedFor(deal({ deadlineSec: 1_699_999_999 }), job(), 500n)).toBe(false)
  })
})

describe('parseCreditBalance', () => {
  it('reads the mainnet integer shape', () => {
    expect(parseCreditBalance('983016')).toBe(983016n)
  })

  it('reads the testnet decimal shape DESIGN.md documents', () => {
    expect(parseCreditBalance('0.0')).toBe(0n)
    expect(parseCreditBalance('12.75')).toBe(12n)
  })

  it('returns 0 for empty or unparseable input rather than throwing', () => {
    expect(parseCreditBalance('')).toBe(0n)
    expect(parseCreditBalance('not-a-number')).toBe(0n)
  })
})

describe('jobAmountWei', () => {
  const IMG = ['z-image-turbo']
  it.each([
    [1000n, 16],
    [8000n, 8],
    [1n, 1],
    [0n, 1],
  ])('for a text job equals jobPriceWei (%s wei, %s tokens)', (price, tokens) => {
    expect(jobAmountWei({ model: '0gm-1.0-35b-a3b', maxTokens: tokens }, price, IMG)).toBe(
      jobPriceWei(price, tokens),
    )
  })
  it('for an image job is price × n', () => {
    expect(jobAmountWei({ model: 'z-image-turbo', maxTokens: 1 }, 8000n, IMG)).toBe(8000n)
    expect(jobAmountWei({ model: 'z-image-turbo', maxTokens: 2 }, 8000n, IMG)).toBe(16000n)
  })
  it('floors an image job at 1 wei, like jobPriceWei', () => {
    expect(jobAmountWei({ model: 'z-image-turbo', maxTokens: 1 }, 0n, IMG)).toBe(1n)
  })
})

describe('isFundedFor — image jobs', () => {
  const IMG = ['z-image-turbo']
  const imageJob = job({ model: 'z-image-turbo', maxTokens: 1 })
  it('accepts an image deal funded at price × n', () => {
    expect(isFundedFor(deal({ amount: 8000n }), imageJob, 8000n, IMG)).toBe(true)
  })
  it('rejects one funded at price × n / 1000', () => {
    expect(isFundedFor(deal({ amount: 8n }), imageJob, 8000n, IMG)).toBe(false)
  })
})

describe('jobTokens — the tokens a buyer pays for', () => {
  it('over-counts the prompt: a token per 3 characters plus the chat wrapper', () => {
    expect(estimateInputTokens(0)).toBe(20)
    expect(estimateInputTokens(2)).toBe(21)
    expect(estimateInputTokens(300)).toBe(120)
  })

  it('covers the prompt and the whole answer budget', () => {
    expect(jobTokens({ maxTokens: 8, inputChars: 2 })).toBe(29)
  })

  it('is output alone for a job that does not say how long its prompt is', () => {
    expect(jobTokens({ maxTokens: 8 })).toBe(8)
  })
})

describe('isFundedFor — prompt and answer', () => {
  it('refuses a deal that covers the answer but not the prompt', () => {
    const j = job({ maxTokens: 8, inputChars: 300 })
    expect(isFundedFor(deal({ amount: 8n }), j, 1_000n)).toBe(false)
    expect(isFundedFor(deal({ amount: 128n }), j, 1_000n)).toBe(true)
  })
})

describe('fundingPrice — drop to our cost only when our worker is the only seller', () => {
  const OURS = `0x${'f0'.repeat(20)}` as const
  const ad = (payout: string, models: string[], price: bigint) =>
    ({ id: payout, models, pricePer1kOut: price, creditsBucket: '>50%', trustModes: ['verified'], payout }) as never

  it('funds at our price when every live seller of the model is our worker', () => {
    expect(fundingPrice(5_000n, 'm', [ad(OURS, ['m'], 1_000n), ad('0x01', ['other'], 1n)], OURS)).toBe(1_000n)
  })

  it('never funds above the buyer cap', () => {
    expect(fundingPrice(500n, 'm', [ad(OURS, ['m'], 1_000n)], OURS)).toBe(500n)
  })

  it('funds at the buyer cap when any other seller offers the model', () => {
    expect(fundingPrice(5_000n, 'm', [ad(OURS, ['m'], 1_000n), ad('0x01', ['m'], 2_000n)], OURS)).toBe(5_000n)
  })

  it('funds at the buyer cap when our worker is not live, or not configured', () => {
    expect(fundingPrice(5_000n, 'm', [], OURS)).toBe(5_000n)
    expect(fundingPrice(5_000n, 'm', [ad(OURS, ['m'], 1_000n)], undefined)).toBe(5_000n)
  })

  it('matches our address case-insensitively', () => {
    expect(fundingPrice(5_000n, 'm', [ad(OURS.toUpperCase().replace('0X', '0x'), ['m'], 1_000n)], OURS)).toBe(1_000n)
  })
})
