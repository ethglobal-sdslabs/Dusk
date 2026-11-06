import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Receipt, Verification, WorkerAd } from '@dusk/core'
import type { ChainEvent } from '../src/lib/past'
import {
  EMPTY_ANSWER_PENALTY,
  LATE_PENALTY,
  PASS_BONUS,
  REVIEW_BELOW,
  ILLEGAL_PENALTY,
  marketReputation,
  sellerRecords,
  standingOf,
  withModeration,
  type MarketEvents,
} from '../src/lib/reputation'

const A = `0x${'a1'.repeat(20)}` as Address
const B = `0x${'b2'.repeat(20)}` as Address
const BUYER = `0x${'c3'.repeat(20)}` as Address
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function ev(n: number, party: Address, at: number, amountWei?: bigint): ChainEvent {
  return { escrowId: id(n), party, txHash: id(n + 1000), at, ...(amountWei === undefined ? {} : { amountWei }) }
}

function receipt(n: number, worker: Address, latencyMs: number, model = '0gm-1.0-35b-a3b'): Receipt {
  return {
    id: `r${n}`, jobId: `j${n}`, escrowId: id(n), worker, modelServed: model, creditsSpent: 'tokens:1/1',
    tokensIn: 1, tokensOut: 8, outputRef: 'ab'.repeat(32), outputHash: `0x${'cd'.repeat(32)}`, latencyMs, trustMode: 'verified',
  }
}

function ad(payout: Address, price: bigint): WorkerAd {
  return { id: 'w', models: ['0gm-1.0-35b-a3b'], pricePer1kOut: price, creditsBucket: '>50%', trustModes: ['verified'], payout }
}

const EMPTY: MarketEvents = { funded: [], committed: [], settled: [], challenged: [] }

describe('sellerRecords', () => {
  it('counts delivered, collected, challenged and pending per worker, and sums what Settled paid', () => {
    const events: MarketEvents = {
      funded: [],
      committed: [ev(1, A, 10), ev(2, A, 20), ev(3, A, 30), ev(4, B, 40)],
      settled: [ev(1, A, 15, 8000n), ev(4, B, 45, 640n)],
      challenged: [ev(2, BUYER, 25)],
    }
    const records = sellerRecords(events, [], [])
    const a = records.find((r) => r.worker === A)!
    expect(a.delivered).toBe(3)
    expect(a.collected).toBe(1)
    expect(a.challenged).toBe(1)
    expect(a.pending).toBe(1)
    expect(a.earnedWei).toBe(8000n)
    expect(a.reliability).toBeCloseTo(0.5)
    expect(records.find((r) => r.worker === B)!.earnedWei).toBe(640n)
  })

  it('has no reliability until a job has resolved — pending is not a success', () => {
    const r = sellerRecords({ ...EMPTY, committed: [ev(1, A, 10)] }, [], [])[0]!
    expect(r.reliability).toBeNull()
  })

  it('measures delivery as commit time minus fund time, as a median', () => {
    const events: MarketEvents = {
      funded: [ev(1, BUYER, 0), ev(2, BUYER, 0), ev(3, BUYER, 0)],
      committed: [ev(1, A, 10_000), ev(2, A, 30_000), ev(3, A, 90_000)],
      settled: [],
      challenged: [],
    }
    expect(sellerRecords(events, [], [])[0]!.medianDeliverMs).toBe(30_000)
  })

  it('matches addresses case-insensitively and keeps first and last activity', () => {
    const lower = A.toLowerCase() as Address
    const r = sellerRecords({ ...EMPTY, committed: [ev(1, A, 50), ev(2, lower, 10)], settled: [ev(2, lower, 70, 1n)] }, [], [])
    expect(r).toHaveLength(1)
    expect(r[0]!.firstSeen).toBe(10)
    expect(r[0]!.lastActive).toBe(70)
  })

  it('adds latency and models from surviving receipts, and a live ad when one is up', () => {
    const r = sellerRecords(
      { ...EMPTY, committed: [ev(1, A, 1), ev(2, A, 2)] },
      [receipt(1, A, 1000), receipt(2, A, 3000, 'other-model'), receipt(9, B, 50)],
      [ad(A.toLowerCase() as Address, 7n)],
    )[0]!
    expect(r.recentReceipts).toBe(2)
    expect(r.avgLatencyMs).toBe(2000)
    expect(r.models).toEqual(['0gm-1.0-35b-a3b', 'other-model'])
    expect(r.livePricePer1kOut).toBe(7n)
  })

  it('ranks by jobs collected, then fewer challenges, then most recent', () => {
    const events: MarketEvents = {
      funded: [],
      committed: [ev(1, A, 1), ev(2, B, 2), ev(3, B, 3)],
      settled: [ev(1, A, 5, 1n), ev(2, B, 6, 1n), ev(3, B, 7, 1n)],
      challenged: [],
    }
    expect(sellerRecords(events, [], []).map((r) => r.worker)).toEqual([B, A])
  })
})

describe('standingOf', () => {
  const rec = (collected: number, challenged: number) =>
    sellerRecords(
      {
        funded: [],
        committed: Array.from({ length: collected + challenged }, (_, i) => ev(i + 1, A, i)),
        settled: Array.from({ length: collected }, (_, i) => ev(i + 1, A, i, 1n)),
        challenged: Array.from({ length: challenged }, (_, i) => ev(collected + i + 1, BUYER, i)),
      },
      [],
      [],
    )[0]!

  it('is new until three jobs have resolved', () => {
    expect(standingOf(rec(2, 0))).toBe('new')
  })
  it('is trusted at 95% or better, good at 80%, disputed below', () => {
    expect(standingOf(rec(20, 1))).toBe('trusted')
    expect(standingOf(rec(9, 1))).toBe('good')
    expect(standingOf(rec(3, 2))).toBe('disputed')
  })
})

describe('marketReputation', () => {
  it('summarises sellers, live sellers and the market-wide challenge rate', () => {
    const records = sellerRecords(
      {
        funded: [],
        committed: [ev(1, A, 1), ev(2, A, 2), ev(3, B, 3), ev(4, B, 4)],
        settled: [ev(1, A, 5, 1n), ev(2, A, 6, 1n), ev(3, B, 7, 1n)],
        challenged: [ev(4, BUYER, 8)],
      },
      [],
      [ad(B, 1n)],
    )
    const m = marketReputation(records)
    expect(m.sellers).toBe(2)
    expect(m.live).toBe(1)
    expect(m.delivered).toBe(4)
    expect(m.challengeRate).toBeCloseTo(0.25)
  })
})

describe('misconduct score', () => {
  const VERIFIER = `0x${'d4'.repeat(20)}` as Address
  const HASH = `0x${'cd'.repeat(32)}` as Hex
  const OTHER = `0x${'ee'.repeat(32)}` as Hex
  const commit = (n: number, party: Address, outputHash: Hex = HASH): ChainEvent => ({ ...ev(n, party, n), outputHash })
  const CHECK = { pass: 'delivered', bad: 'empty-answer', illegal: 'output-hash-mismatch' } as const
  const verdict = (n: number, worker: Address, result: Verification['result'], owner: Address = VERIFIER, over: Partial<Verification> = {}): Verification => ({
    id: `v${n}-${result}`, owner, jobId: `j${n}`, escrowId: id(n), worker, result, check: CHECK[result], ...over,
  })
  const own = (r: Receipt): Receipt => ({ ...r, owner: r.worker })

  it('starts every seller at 100 and in good standing', () => {
    const r = sellerRecords({ ...EMPTY, committed: [commit(1, A)] }, [], [])[0]!
    expect(r.score).toBe(100)
    expect(r.banned).toBe(false)
  })

  it('deducts 20 for an empty canary answer and 50 for an illegal act', () => {
    const r = sellerRecords(
      { ...EMPTY, committed: [commit(1, A), commit(2, A)] },
      [], [],
      [verdict(1, A, 'bad'), verdict(2, A, 'illegal')],
      [VERIFIER],
    )[0]!
    expect(r.badAnswers).toBe(1)
    expect(r.illegal).toBe(1)
    expect(EMPTY_ANSWER_PENALTY).toBe(20)
    expect(ILLEGAL_PENALTY).toBe(50)
    expect(r.score).toBe(100 - 20 - 50)
  })

  it('ignores a verdict from anyone who is not a configured verifier', () => {
    const r = sellerRecords({ ...EMPTY, committed: [commit(1, A)] }, [], [], [verdict(1, A, 'illegal', B)], [VERIFIER])[0]!
    expect(r.score).toBe(100)
  })

  it('ignores a verdict pinned on a seller for a job it never committed', () => {
    const records = sellerRecords(
      { ...EMPTY, committed: [commit(1, B), commit(2, A)] },
      [], [], [verdict(1, A, 'illegal')], [VERIFIER],
    )
    expect(records.find((r) => r.worker === A)!.score).toBe(100)
  })

  it('counts a verdict once however many times it was written', () => {
    const v = verdict(1, A, 'bad')
    const r = sellerRecords({ ...EMPTY, committed: [commit(1, A)] }, [], [], [v, { ...v, id: 'dup' }], [VERIFIER])[0]!
    expect(r.badAnswers).toBe(1)
  })

  it('charges an illegal act for a seller-signed receipt that contradicts the committed hash', () => {
    const lying = own({ ...receipt(1, A, 100), outputHash: OTHER })
    const r = sellerRecords({ ...EMPTY, committed: [commit(1, A)] }, [lying], [])[0]!
    expect(r.illegal).toBe(1)
  })

  it('does not charge a seller for a receipt someone else signed in its name', () => {
    const forged = { ...receipt(1, A, 100), outputHash: OTHER, owner: B }
    const r = sellerRecords({ ...EMPTY, committed: [commit(1, A)] }, [forged], [])[0]!
    expect(r.illegal).toBe(0)
  })

  it('does not charge a receipt whose commit has not landed yet', () => {
    const r = sellerRecords({ ...EMPTY, committed: [commit(2, A)] }, [own({ ...receipt(1, A, 100), outputHash: OTHER })], [])[0]!
    expect(r.illegal).toBe(0)
  })

  it('does not invent an on-chain ban from a low reputation score', () => {
    // Two jobs: one finding per job counts, so two findings need two jobs.
    const r = sellerRecords(
      { ...EMPTY, committed: [commit(1, A), commit(2, A)] },
      [own({ ...receipt(1, A, 100), outputHash: OTHER })], [],
      [verdict(2, A, 'bad')], [VERIFIER],
    )[0]!
    expect(r.score).toBeLessThan(REVIEW_BELOW)
    expect(r.banned).toBe(false)
    expect(standingOf(r)).not.toBe('banned')
  })

  it('never scores below zero', () => {
    const committed = [1, 2, 3].map((n) => commit(n, A))
    const r = sellerRecords({ ...EMPTY, committed }, [], [], [1, 2, 3].map((n) => verdict(n, A, 'illegal')), [VERIFIER])[0]!
    expect(r.score).toBe(0)
  })
})

describe('on-chain moderation', () => {
  const record = () => sellerRecords({ funded: [], committed: [ev(1, A, 100)], settled: [], challenged: [] }, [], [])[0]!
  const identity = (status: 'active' | 'banned' | 'unknown', wallet = A) => ({
    wallet, status, chainId: 11155111, registry: B, checkedAt: Date.now(), name: 'alice.dusk.eth',
  })

  it('only the controller status sets a ban, regardless of the score', () => {
    const banned = withModeration(record(), identity('banned'))
    expect(banned.score).toBe(100)
    expect(banned.banned).toBe(true)
    expect(standingOf(banned)).toBe('banned')
    const unbanned = withModeration({ ...banned, score: 0 }, identity('active'))
    expect(unbanned.banned).toBe(false)
    expect(unbanned.ensName).toBe('alice.dusk.eth')
  })

  it('does not treat an unavailable or foreign status as an unban', () => {
    for (const value of [undefined, identity('unknown'), identity('banned', B)]) {
      expect(withModeration(record(), value).moderationStatus).toBe('unknown')
    }
  })
})

describe('canary scoring — output and latency, not answer quality', () => {
  const VERIFIER = `0x${'d4'.repeat(20)}` as Address
  const HASH = `0x${'cd'.repeat(32)}` as Hex
  const commit = (n: number, party: Address): ChainEvent => ({ ...ev(n, party, n), outputHash: HASH })
  const v = (n: number, worker: Address, result: Verification['result'], check: string, latencyMs?: number): Verification => ({
    id: `v${n}`, owner: VERIFIER, jobId: `j${n}`, escrowId: id(n), worker, result, check, ...(latencyMs !== undefined ? { latencyMs } : {}),
  })
  const score = (verdicts: Verification[], committed = verdicts.map((x) => Number(BigInt(x.escrowId)))) =>
    sellerRecords({ ...EMPTY, committed: [...new Set(committed)].map((n) => commit(n, A)) }, [], [], verdicts, [VERIFIER])
      .find((r) => r.worker === A)!

  it('adds 10 for a delivered canary, but never above 100', () => {
    expect(PASS_BONUS).toBe(10)
    const r = score([v(1, A, 'illegal', 'output-hash-mismatch'), v(2, A, 'pass', 'delivered', 5_000)])
    expect(r.score).toBe(100 - 50 + 10)
    expect(score([v(1, A, 'pass', 'delivered', 5_000)]).score).toBe(100)
  })

  it('does not judge what the answer says — a legacy wrong-answer verdict costs nothing', () => {
    expect(score([v(1, A, 'bad', 'wrong-answer')]).score).toBe(100)
  })

  // Claiming a canary and never delivering is the same failure as an empty answer.
  it('deducts 20 for a canary the seller claimed and never delivered, even with no commit', () => {
    const r = score([v(1, A, 'pass', 'delivered', 5_000), v(2, A, 'bad', 'no-delivery')], [1])
    expect(r.score).toBe(100 + 10 - 20)
  })

  it('deducts 10 instead of adding 10 for a delivered canary over twice the market median latency', () => {
    expect(LATE_PENALTY).toBe(10)
    const market = [v(1, B, 'pass', 'delivered', 20_000), v(2, B, 'pass', 'delivered', 20_000), v(3, B, 'pass', 'delivered', 20_000)]
    const slow = v(4, A, 'pass', 'delivered', 90_000)
    const records = sellerRecords(
      { ...EMPTY, committed: [commit(1, B), commit(2, B), commit(3, B), commit(4, A)] }, [], [], [...market, slow], [VERIFIER],
    )
    const a = records.find((r) => r.worker === A)!
    expect(a.score).toBe(100 - 10)
    expect(a.canaryLate).toBe(1)
  })

  it('does not call anything late until there are enough canaries to compare against', () => {
    expect(score([v(1, A, 'pass', 'delivered', 90_000)]).score).toBe(100)
  })

  it('never calls a fast canary late, however much faster the market is', () => {
    const market = [1, 2, 3].map((n) => v(n, B, 'pass', 'delivered', 1_000))
    const quick = v(4, A, 'pass', 'delivered', 8_000)
    const records = sellerRecords(
      { ...EMPTY, committed: [commit(1, B), commit(2, B), commit(3, B), commit(4, A)] }, [], [], [...market, quick], [VERIFIER],
    )
    expect(records.find((r) => r.worker === A)!.canaryLate).toBe(0)
  })
})

describe('one finding per job, as the contract counts it', () => {
  const VERIFIER = `0x${'d4'.repeat(20)}` as Address
  const HASH = `0x${'cd'.repeat(32)}` as Hex
  it('charges only the worst finding when one job has several', () => {
    const commit: ChainEvent = { ...ev(1, A, 1), outputHash: HASH }
    const base = { id: 'v', owner: VERIFIER, jobId: 'j1', escrowId: id(1), worker: A }
    const r = sellerRecords({ ...EMPTY, committed: [commit] }, [], [], [
      { ...base, id: 'a', result: 'bad', check: 'empty-answer' },
      { ...base, id: 'b', result: 'illegal', check: 'output-hash-mismatch' },
    ], [VERIFIER])[0]!
    expect(r.illegal).toBe(1)
    expect(r.badAnswers).toBe(0)
    expect(r.score).toBe(50)
  })
})
