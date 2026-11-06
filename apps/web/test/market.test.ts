import type { Claim, Job, Receipt, WorkerAd } from '@dusk/core'
import { describe, expect, it } from 'vitest'
import { EMPTY_SNAPSHOT, trackBurns, type MarketSnapshot } from '../src/lib/arkiv'
import {
  claimForJob,
  formatCount,
  formatWei,
  isEmptyMarket,
  marketSummary,
  marketView,
  openJobsOf,
  supplyRows,
  demandRows,
  workerById,
} from '../src/lib/market'

function worker(id: string, pricePer1kOut: bigint, models: string[] = ['0gm-1.0-35b-a3b']): WorkerAd {
  return {
    id,
    models,
    pricePer1kOut,
    creditsBucket: '>50%',
    trustModes: ['verified'],
    payout: `0x${id.padEnd(40, '0')}` as WorkerAd['payout'],
  }
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id,
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1000n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'public',
    inputHash: `0x${'11'.repeat(32)}`,
    buyerPubkey: `0x${'22'.repeat(65)}`,
    escrowId: `0x${'33'.repeat(32)}`,
    status: 'open',
    expiresAt: 1_700_000_600_000,
    ...over,
  }
}

function claim(id: string, jobId: string, workerId: string, claimedAt: number): Claim {
  return { id, jobId, workerId, price: 8n, claimedAt }
}

function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { ...EMPTY_SNAPSHOT, ...over }
}

describe('marketSummary', () => {
  it('counts live supply as the worker ads the last read returned, and nothing more', () => {
    const s = snapshot({ workers: [worker('w1', 5n), worker('w2', 3n)] })
    expect(marketSummary(s).liveWorkers).toBe(2)
  })

  it('takes the cheapest price per 1k output tokens across live supply', () => {
    const s = snapshot({ workers: [worker('w1', 5n), worker('w2', 3n), worker('w3', 11n)] })
    expect(marketSummary(s).cheapestPer1kOut).toBe(3n)
  })

  it('has no cheapest price at all when nobody is offering, rather than zero', () => {
    expect(marketSummary(snapshot()).cheapestPer1kOut).toBeNull()
  })

  it('distinguishes a floor price of zero from no supply', () => {
    const s = snapshot({ workers: [worker('w1', 0n)] })
    expect(marketSummary(s).cheapestPer1kOut).toBe(0n)
  })

  it('counts only open jobs, judged client-side over the whole result set', () => {
    const s = snapshot({ jobs: [job('j1'), job('j2'), job('j3', { status: 'settled' })] })
    expect(marketSummary(s).openJobs).toBe(2)
  })

  it('counts the live claims, which is how many jobs are being worked right now', () => {
    const s = snapshot({ claims: [claim('c1', 'j1', 'w1', 0), claim('c2', 'j2', 'w1', 0)] })
    expect(marketSummary(s).activeClaims).toBe(2)
  })

  it('counts the distinct models actually on offer, not the models advertised by 0G', () => {
    const s = snapshot({
      workers: [worker('w1', 5n, ['a', 'b']), worker('w2', 3n, ['b', 'c'])],
    })
    expect(marketSummary(s).modelsOnOffer).toBe(3)
  })
})

describe('openJobsOf', () => {
  it('is a client-side predicate, so it is right even if the query filter were not', () => {
    const s = snapshot({ jobs: [job('j1'), job('j2', { status: 'delivered' })] })
    expect(openJobsOf(s).map((j: Job) => j.id)).toEqual(['j1'])
  })
})

describe('claimForJob', () => {
  it('finds the claim that binds a job to a worker', () => {
    const s = snapshot({ claims: [claim('c1', 'j1', 'w1', 10), claim('c2', 'j2', 'w2', 10)] })
    expect(claimForJob(s, 'j1')?.id).toBe('c1')
  })

  it('breaks a race the way the worker loop does, oldest first', () => {
    const s = snapshot({ claims: [claim('c2', 'j1', 'w2', 200), claim('c1', 'j1', 'w1', 100)] })
    expect(claimForJob(s, 'j1')?.id).toBe('c1')
  })

  it('has no claim for an unclaimed job', () => {
    expect(claimForJob(snapshot(), 'j1')).toBeUndefined()
  })
})

describe('workerById', () => {
  it('resolves a claim’s worker id to the ad it points at', () => {
    const s = snapshot({ workers: [worker('w1', 5n)] })
    expect(workerById(s, 'w1')?.id).toBe('w1')
    expect(workerById(s, 'w2')).toBeUndefined()
  })
})

describe('isEmptyMarket', () => {
  it('is empty with no workers and no open jobs', () => {
    expect(isEmptyMarket(snapshot())).toBe(true)
  })

  it('is not empty with supply but no demand, because the offer is the market', () => {
    expect(isEmptyMarket(snapshot({ workers: [worker('w1', 0n)] }))).toBe(false)
  })

  it('is not empty with demand but no supply', () => {
    expect(isEmptyMarket(snapshot({ jobs: [job('j1')] }))).toBe(false)
  })

  it('is empty when the only job left is not open', () => {
    expect(isEmptyMarket(snapshot({ jobs: [job('j1', { status: 'expired' })] }))).toBe(true)
  })
})

describe('supplyRows and demandRows', () => {
  it('puts the cheapest offer at the top of supply', () => {
    const s = snapshot({ workers: [worker('w1', 5n), worker('w2', 0n), worker('w3', 11n)] })
    expect(supplyRows(s).map((w) => w.pricePer1kOut)).toEqual([0n, 5n, 11n])
  })

  it('puts the most valuable open job at the top of demand', () => {
    const s = snapshot({
      jobs: [job('j1', { maxPricePer1kOut: 100n }), job('j2', { maxPricePer1kOut: 900n })],
    })
    expect(demandRows(s).map((j) => j.maxPricePer1kOut)).toEqual([900n, 100n])
  })

  it('shows only open jobs in demand', () => {
    const s = snapshot({ jobs: [job('j1'), job('j2', { status: 'delivered' })] })
    expect(demandRows(s).map((j) => j.id)).toEqual(['j1'])
  })

  it('breaks a tie by id, so equal prices do not reshuffle between reads', () => {
    const s = snapshot({ workers: [worker('wb', 0n), worker('wa', 0n)] })
    expect(supplyRows(s).map((w) => w.id)).toEqual(['wa', 'wb'])
  })

  it('does not mutate the snapshot it was given', () => {
    const workers = [worker('w1', 5n), worker('w2', 0n)]
    const s = snapshot({ workers })
    supplyRows(s)
    expect(workers.map((w) => w.id)).toEqual(['w1', 'w2'])
  })
})

describe('marketView', () => {
  it('is unreadable, not empty, when the first read failed', () => {
    expect(marketView({ hasAnswer: false, error: 'rate-limited', empty: true })).toBe('unreadable')
  })

  it('is reading before the first read comes back either way', () => {
    expect(marketView({ hasAnswer: false, error: null, empty: true })).toBe('reading')
  })

  it('is empty only once Arkiv has actually answered with nothing', () => {
    expect(marketView({ hasAnswer: true, error: null, empty: true })).toBe('empty')
  })

  it('shows the market when there is one', () => {
    expect(marketView({ hasAnswer: true, error: null, empty: false })).toBe('market')
  })

  it('keeps showing the last answer when a later read fails', () => {
    expect(marketView({ hasAnswer: true, error: 'dropped', empty: false })).toBe('market')
    expect(marketView({ hasAnswer: true, error: 'dropped', empty: true })).toBe('empty')
  })
})

describe('formatWei', () => {
  it('groups digits so a column of wei is scannable', () => {
    expect(formatWei(1_234_567n)).toBe('1,234,567')
    expect(formatWei(0n)).toBe('0')
  })

  it('stays exact at a size no number type could hold', () => {
    expect(formatWei(123456789012345678901234567890n)).toBe('123,456,789,012,345,678,901,234,567,890')
  })
})

describe('formatCount', () => {
  it('groups a plain count the same way', () => {
    expect(formatCount(7)).toBe('7')
    expect(formatCount(12_000)).toBe('12,000')
  })
})

describe('trackBurns', () => {
  function receipt(id: string, jobId = 'j1'): Receipt {
    return {
      id,
      jobId,
      escrowId: `0x${'33'.repeat(32)}`,
      worker: `0x${'44'.repeat(20)}`,
      modelServed: '0gm-1.0-35b-a3b',
      creditsSpent: 'tokens:31/8',
      tokensIn: 31,
      tokensOut: 8,
      outputRef: 'ab'.repeat(32),
      outputHash: `0x${'55'.repeat(32)}`,
      latencyMs: 900,
      trustMode: 'verified',
    }
  }

  const burnMs = 2500

  it('emits nothing on the first read, because every receipt looks new to a page that just loaded', () => {
    const { burns, seen } = trackBurns({
      previous: [],
      seen: null,
      receipts: [receipt('r1'), receipt('r2')],
      nowMs: 1000,
      burnMs,
    })
    expect(burns).toEqual([])
    expect([...seen].sort()).toEqual(['r1', 'r2'])
  })

  it('emits one burn for a receipt that was not there last time', () => {
    const first = trackBurns({ previous: [], seen: null, receipts: [receipt('r1')], nowMs: 1000, burnMs })
    const second = trackBurns({
      previous: first.burns,
      seen: first.seen,
      receipts: [receipt('r1'), receipt('r2', 'j9')],
      nowMs: 2000,
      burnMs,
    })
    expect(second.burns).toEqual([{ id: 'r2', jobId: 'j9', firstSeenMs: 2000 }])
  })

  it('drops a burn once its ember has finished, without a timer', () => {
    const first = trackBurns({ previous: [], seen: null, receipts: [], nowMs: 0, burnMs })
    const second = trackBurns({ previous: first.burns, seen: first.seen, receipts: [receipt('r1')], nowMs: 1000, burnMs })
    expect(second.burns).toHaveLength(1)
    const third = trackBurns({
      previous: second.burns,
      seen: second.seen,
      receipts: [receipt('r1')],
      nowMs: 1000 + burnMs + 1,
      burnMs,
    })
    expect(third.burns).toEqual([])
  })

  it('keeps an ember that is still burning when a later read brings nothing new', () => {
    const first = trackBurns({ previous: [], seen: null, receipts: [], nowMs: 0, burnMs })
    const second = trackBurns({ previous: first.burns, seen: first.seen, receipts: [receipt('r1')], nowMs: 100, burnMs })
    const third = trackBurns({ previous: second.burns, seen: second.seen, receipts: [receipt('r1')], nowMs: 200, burnMs })
    expect(third.burns).toEqual([{ id: 'r1', jobId: 'j1', firstSeenMs: 100 }])
  })

  it('does not re-burn a receipt it has already seen', () => {
    const first = trackBurns({ previous: [], seen: null, receipts: [receipt('r1')], nowMs: 0, burnMs })
    const second = trackBurns({ previous: first.burns, seen: first.seen, receipts: [receipt('r1')], nowMs: 10, burnMs })
    expect(second.burns).toEqual([])
  })

  it('forgets a receipt that has expired off chain, so `seen` cannot grow without bound', () => {
    const first = trackBurns({ previous: [], seen: null, receipts: [receipt('r1')], nowMs: 0, burnMs })
    const second = trackBurns({ previous: [], seen: first.seen, receipts: [], nowMs: 10, burnMs })
    expect(second.seen.size).toBe(0)
  })
})
