import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Claim, Receipt } from '@dusk/core'
import {
  creditsView,
  dealsToRead,
  earningsOf,
  feedRows,
  mergeDeal,
  quotaView,
  rereadDue,
  reputationView,
  tickNote,
  type DealRow,
} from '../src/lib/earn'

const PAYOUT = `0x${'ee'.repeat(20)}` as Address
const OTHER = `0x${'cc'.repeat(20)}` as Address

function receipt(n: number, over: Partial<Receipt> = {}): Receipt {
  return {
    id: `0x${n.toString(16).padStart(64, '0')}`,
    jobId: `0x${(n + 100).toString(16).padStart(64, '0')}`,
    escrowId: `0x${(n + 200).toString(16).padStart(64, '0')}` as Hex,
    worker: PAYOUT,
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: 'tokens:31/8',
    tokensIn: 31,
    tokensOut: 8,
    outputRef: 'ab'.repeat(32),
    visibility: 'public',
    outputHash: `0x${'dd'.repeat(32)}` as Hex,
    latencyMs: 1200,
    trustMode: 'verified',
    ...over,
  }
}

function deal(escrowId: Hex, over: Partial<DealRow> = {}): DealRow {
  return { escrowId, amountWei: 8n, state: 'settled', ...over }
}

describe('earningsOf', () => {
  it('counts nothing when nothing has been delivered', () => {
    expect(earningsOf([], new Map())).toEqual({
      delivered: 0,
      tokensOut: 0,
      collectedWei: 0n,
      collectedDeals: 0,
      collectedUnknown: 0,
      awaitingWei: 0n,
      unknown: 0,
    })
  })

  it('sums what the chain says was settled', () => {
    const rs = [receipt(1), receipt(2)]
    const deals = new Map(rs.map((r) => [r.escrowId, deal(r.escrowId, { amountWei: 8n })]))
    const earnings = earningsOf(rs, deals)

    expect(earnings.delivered).toBe(2)
    expect(earnings.tokensOut).toBe(16)
    expect(earnings.collectedWei).toBe(16n)
    expect(earnings.awaitingWei).toBe(0n)
    expect(earnings.collectedDeals).toBe(2)
    expect(earnings.collectedUnknown).toBe(0)
  })

  it('counts a settled deal whose amount the chain has already forgotten, without claiming zero', () => {
    const r = receipt(1)
    const earnings = earningsOf([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'settled', amountWei: 0n })]]))

    expect(earnings.collectedDeals).toBe(1)
    expect(earnings.collectedUnknown).toBe(1)
    expect(earnings.collectedWei).toBe(0n)
  })

  it('keeps a committed deal out of collected, because the holder does not have it yet', () => {
    const r = receipt(1)
    const earnings = earningsOf([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'committed', amountWei: 5n })]]))

    expect(earnings.collectedWei).toBe(0n)
    expect(earnings.awaitingWei).toBe(5n)
  })

  it('counts a refunded deal as neither, and does not pretend it was collected', () => {
    const r = receipt(1)
    const earnings = earningsOf([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'refunded', amountWei: 0n })]]))

    expect(earnings.delivered).toBe(1)
    expect(earnings.collectedWei).toBe(0n)
    expect(earnings.awaitingWei).toBe(0n)
  })

  it('reports how many deals it has not read yet rather than treating them as zero', () => {
    const rs = [receipt(1), receipt(2), receipt(3)]
    const earnings = earningsOf(rs, new Map([[rs[0]!.escrowId, deal(rs[0]!.escrowId)]]))

    expect(earnings.unknown).toBe(2)
    expect(earnings.collectedWei).toBe(8n)
  })

  it('ignores a receipt naming another worker, however it got into the list', () => {
    const mine = receipt(1)
    const theirs = receipt(2, { worker: OTHER })
    const deals = new Map([
      [mine.escrowId, deal(mine.escrowId, { amountWei: 3n })],
      [theirs.escrowId, deal(theirs.escrowId, { amountWei: 1_000n })],
    ])

    expect(earningsOf([mine, theirs], deals, PAYOUT).collectedWei).toBe(3n)
    expect(earningsOf([mine, theirs], deals, PAYOUT).delivered).toBe(1)
  })

  it('counts one receipt per job, so a duplicate write cannot inflate the total', () => {
    const a = receipt(1)
    const b = { ...receipt(2), jobId: a.jobId, escrowId: a.escrowId }
    const deals = new Map([[a.escrowId, deal(a.escrowId, { amountWei: 8n })]])

    expect(earningsOf([a, b], deals).collectedWei).toBe(8n)
    expect(earningsOf([a, b], deals).delivered).toBe(1)
  })

  it('skips a receipt with no escrowId, which is what Gate 1 wrote', () => {
    const r = { ...receipt(1), escrowId: undefined as unknown as Hex }
    const earnings = earningsOf([r], new Map())
    expect(earnings.delivered).toBe(1)
    expect(earnings.unknown).toBe(0)
  })
})

describe('dealsToRead', () => {
  it('asks about every deal it has never seen', () => {
    const rs = [receipt(1), receipt(2)]
    expect(dealsToRead(rs, new Map())).toEqual([rs[0]!.escrowId, rs[1]!.escrowId])
  })

  it('re-reads a committed deal, because that is the state that changes', () => {
    const r = receipt(1)
    expect(dealsToRead([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'committed' })]]))).toEqual([
      r.escrowId,
    ])
  })

  it('never re-reads a settled deal, so the chain reads stop', () => {
    const r = receipt(1)
    expect(dealsToRead([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'settled' })]]))).toEqual([])
  })

  it('never re-reads a refunded deal either', () => {
    const r = receipt(1)
    expect(dealsToRead([r], new Map([[r.escrowId, deal(r.escrowId, { state: 'refunded' })]]))).toEqual([])
  })

  it('asks once for a job that produced two receipts', () => {
    const a = receipt(1)
    const b = { ...receipt(2), escrowId: a.escrowId }
    expect(dealsToRead([a, b], new Map())).toEqual([a.escrowId])
  })

  it('skips a receipt with no escrowId rather than reading deal(undefined)', () => {
    const r = { ...receipt(1), escrowId: undefined as unknown as Hex }
    expect(dealsToRead([r], new Map())).toEqual([])
  })
})

describe('reputationView', () => {
  it('states the window, and takes it from the TTL the receipts were written with', () => {
    const view = reputationView([receipt(1)], 604_800)
    expect(view.days).toBe(7)
    expect(view.note).toMatch(/7 days/)
  })

  it('states a different window when the receipt TTL is different', () => {
    expect(reputationView([], 86_400).days).toBe(1)
    expect(reputationView([], 86_400).note).toMatch(/1 day\b/)
  })

  it('never claims a window it cannot support, and never says "no data"', () => {
    const view = reputationView([], 604_800)
    expect(view.delivered).toBe(0)
    expect(view.note).toMatch(/7 days/)
    expect(view.note).not.toMatch(/no data/i)
  })

  it('counts delivered jobs, not receipts', () => {
    const a = receipt(1)
    const b = { ...receipt(2), jobId: a.jobId }
    expect(reputationView([a, b], 604_800).delivered).toBe(1)
  })
})

describe('creditsView', () => {
  it('shows the bucket and says it is a bucket', () => {
    const view = creditsView('>50%')
    expect(view.figure).toBe('>50%')
    expect(view.note).toMatch(/bucket|coarse/i)
  })

  it('says why it is coarse, which is the part that matters', () => {
    expect(creditsView('10-50%').note).toMatch(/exact/i)
  })

  it('never renders a number of credits, for any bucket', () => {
    for (const bucket of ['<10%', '10-50%', '>50%'] as const) {
      const view = creditsView(bucket)
      expect(`${view.figure} ${view.note}`).not.toMatch(/\b\d{4,}\b/)
    }
  })

  it('says it does not know rather than showing the lowest bucket as fact', () => {
    const view = creditsView(null)
    expect(view.figure).toBe('—')
    expect(view.note).toMatch(/cannot read|not reading|no .*key/i)
  })
})

describe('feedRows', () => {
  const claim = (n: number, over: Partial<Claim> = {}): Claim => ({
    id: `0x${(n + 500).toString(16).padStart(64, '0')}`,
    jobId: `0x${(n + 100).toString(16).padStart(64, '0')}`,
    workerId: `0x${'aa'.repeat(32)}`,
    price: 1n,
    claimedAt: 1_000 + n,
    ...over,
  })

  it('invites rather than reporting nothing, when nothing has happened', () => {
    expect(feedRows({ claims: [], receipts: [], now: 2_000, ttlClaimSec: 90 })).toEqual([])
  })

  it('shows a live claim as working, in the flow’s own vocabulary', () => {
    const rows = feedRows({ claims: [claim(1)], receipts: [], now: 2_000, ttlClaimSec: 90 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('working')
  })

  it('shows a delivered job as earned — the word the button promised', () => {
    const r = receipt(1)
    const rows = feedRows({ claims: [claim(1)], receipts: [r], now: 2_000, ttlClaimSec: 90 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('earned')
  })

  it('drops a claim whose lease has lapsed, because on Arkiv it is simply not there', () => {
    const rows = feedRows({ claims: [claim(1)], receipts: [], now: 1_000 + 1 + 90_000 + 1, ttlClaimSec: 90 })
    expect(rows).toEqual([])
  })

  it('keeps an earned row after its claim has gone, because the receipt outlives the lease', () => {
    const r = receipt(1)
    const rows = feedRows({ claims: [], receipts: [r], now: 9_999_999, ttlClaimSec: 90 })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('earned')
    expect(rows[0]!.jobId).toBe(r.jobId)
  })

  it('puts the newest first, so the demo’s next event appears at the top', () => {
    const rows = feedRows({
      claims: [claim(1), claim(2), claim(3)],
      receipts: [],
      now: 2_000,
      ttlClaimSec: 90,
    })
    expect(rows.map((r) => r.at)).toEqual([1_003, 1_002, 1_001])
  })

  it('carries the credits-spent caveat on every earned row', () => {
    const rows = feedRows({ claims: [], receipts: [receipt(1)], now: 2_000, ttlClaimSec: 90 })
    expect(rows[0]!.credits?.note).toMatch(/worker’s own figure|not an attestation/i)
  })

  it('never presents credits spent as something 0G signed', () => {
    for (const spent of ['tokens:31/8', '7', '0', '']) {
      const rows = feedRows({
        claims: [],
        receipts: [receipt(1, { creditsSpent: spent })],
        now: 2_000,
        ttlClaimSec: 90,
      })
      const note = rows[0]!.credits!.note
      expect(note).toMatch(/not an attestation from 0G/)
      expect(note).not.toMatch(/(?<!not an |never an )attestation from 0G\b(?! )/)
    }
  })
})

describe('quotaView', () => {
  it('reports the budget the index itself volunteered', () => {
    const view = quotaView({ usedPercent: 12, limit: 9999, remaining: 9998, resetSec: 1 })
    expect(view.figure).toBe('12%')
    expect(view.note).toMatch(/Arkiv/)
  })

  it('says it is not being told rather than reporting 0%', () => {
    expect(quotaView(null).figure).toBe('—')
    expect(quotaView({ limit: 600, remaining: 599, resetSec: 60 }).figure).toBe('—')
  })

  it('names the ceiling it is measured against, so the percentage means something', () => {
    expect(quotaView({ usedPercent: 3, limit: 9999, remaining: 9998, resetSec: 1 }).note).toMatch(/9999|budget/i)
  })
})

describe('tickNote', () => {
  it('says nothing happened when nothing happened, without calling it an error', () => {
    expect(tickNote({ claimed: 0, delivered: 0, settled: 0 })).toBeNull()
  })

  it('reports a delivery in the flow’s vocabulary', () => {
    expect(tickNote({ claimed: 1, delivered: 1, settled: 0 })).toMatch(/earned/i)
  })

  it('reports money collected separately from work delivered', () => {
    expect(tickNote({ claimed: 0, delivered: 0, settled: 1 })).toMatch(/collect|withdrew|withdrawn/i)
  })

  it('scrubs a tick error, because its text can come straight from the Router', () => {
    const note = tickNote({
      claimed: 1,
      delivered: 0,
      settled: 0,
      error: 'Incorrect API key provided: sk-live-abcdef0123456789.',
    })
    expect(note).not.toMatch(/\b(sk|mk)-/)
    expect(note).not.toContain('abcdef')
  })

  it('says a claimed-but-not-delivered tick cost no credits when that is why', () => {
    const note = tickNote({ claimed: 1, delivered: 0, settled: 0, error: 'no grant arrived; no credits were spent.' })
    expect(note).toMatch(/no credits/i)
  })
})

describe('mergeDeal', () => {
  const id = `0x${'ab'.repeat(32)}` as Hex

  it('takes a first reading as it is', () => {
    const next = { escrowId: id, amountWei: 8n, state: 'committed' as const }
    expect(mergeDeal(undefined, next)).toEqual(next)
  })

  it('keeps the amount it saw while the deal was committed, after the chain zeroes it', () => {
    const committed: DealRow = { escrowId: id, amountWei: 8_000n, state: 'committed' }
    const settled: DealRow = { escrowId: id, amountWei: 0n, state: 'settled' }
    expect(mergeDeal(committed, settled)).toEqual({ escrowId: id, amountWei: 8_000n, state: 'settled' })
  })

  it('always takes the newer state, because the state is what moves', () => {
    const funded: DealRow = { escrowId: id, amountWei: 8n, state: 'funded' }
    expect(mergeDeal(funded, { escrowId: id, amountWei: 8n, state: 'committed' }).state).toBe('committed')
  })

  it('prefers a newer non-zero amount, in case the deal was re-funded under the same key', () => {
    const old: DealRow = { escrowId: id, amountWei: 8n, state: 'funded' }
    expect(mergeDeal(old, { escrowId: id, amountWei: 9n, state: 'funded' }).amountWei).toBe(9n)
  })

  it('does not resurrect an amount for a refund, which also paid this worker nothing', () => {
    const committed: DealRow = { escrowId: id, amountWei: 8n, state: 'committed' }
    const refunded = mergeDeal(committed, { escrowId: id, amountWei: 0n, state: 'refunded' })
    expect(refunded.state).toBe('refunded')
    expect(earningsOf([], new Map([[id, refunded]])).collectedWei).toBe(0n)
  })
})

describe('rereadDue', () => {
  it('reads on the first pass, when nothing has been read yet', () => {
    expect(rereadDue(0, 1_000, 10_000)).toBe(true)
  })

  it('refuses a re-read inside the interval, which is the loop this prevents', () => {
    expect(rereadDue(1_000, 1_500, 10_000)).toBe(false)
    expect(rereadDue(1_000, 10_999, 10_000)).toBe(false)
  })

  it('allows one once the interval has passed', () => {
    expect(rereadDue(1_000, 11_000, 10_000)).toBe(true)
  })

  it('does not wedge if the clock goes backwards', () => {
    expect(rereadDue(10_000, 1_000, 10_000)).toBe(true)
  })
})
