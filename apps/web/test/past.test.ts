import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { Deal, DealState, Receipt } from '@dusk/core'
import {
  formatUsd,
  mergeSaved,
  orderRows,
  orderTotals,
  saleRows,
  saleTotals,
  savingsOf,
  savingsWindows,
  profitWindows,
  type ChainEvent,
  type Pricing,
} from '../src/lib/past'
import type { LedgerRow } from '../src/lib/history'

const BUYER = `0x${'b1'.repeat(20)}` as Address
const WORKER = `0x${'a2'.repeat(20)}` as Address
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const tx = (n: number) => `0x${(n + 0xf000).toString(16).padStart(64, '0')}` as Hex

function event(n: number, at: number, amountWei?: bigint, party: Address = BUYER): ChainEvent {
  return { escrowId: id(n), party, txHash: tx(n), at, ...(amountWei === undefined ? {} : { amountWei }) }
}

function deal(state: DealState, amount = 0n, deadlineSec = 2_000_000_000): Deal {
  return { buyer: BUYER, worker: WORKER, amount, outputHash: `0x${'00'.repeat(32)}`, commitAtSec: 0, deadlineSec, state }
}

function receipt(n: number, tokensIn: number, tokensOut: number, worker: Address = WORKER): Receipt {
  return {
    id: `r${n}`,
    jobId: `job${n}`,
    escrowId: id(n),
    worker,
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: `tokens:${tokensIn}/${tokensOut}`,
    tokensIn,
    tokensOut,
    outputRef: 'ab'.repeat(32),
    outputHash: `0x${'cd'.repeat(32)}`,
    latencyMs: 900,
    trustMode: 'verified',
  }
}

const PRICING: Pricing = { usdPer1mIn: 1, usdPer1mOut: 2, usdPer0g: 3 }

describe('orderRows', () => {
  it('takes the amount from the Funded event even when the settled deal reads zero', () => {
    const rows = orderRows([event(1, 1_000, 8000n)], new Map([[id(1), deal('settled', 0n)]]), [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.paidWei).toBe(8000n)
    expect(rows[0]!.status).toBe('delivered')
  })

  it('newest first, one row per escrow id even if the log repeats', () => {
    const rows = orderRows(
      [event(1, 1_000, 1n), event(2, 3_000, 2n), event(1, 1_000, 1n)],
      new Map(),
      [],
    )
    expect(rows.map((r) => r.escrowId)).toEqual([id(2), id(1)])
  })

  it('names each deal state, and an unread deal is unknown rather than open', () => {
    const now = 5_000_000
    const rows = orderRows(
      [event(1, 1, 1n), event(2, 2, 1n), event(3, 3, 1n), event(4, 4, 1n), event(5, 5, 1n), event(6, 6, 1n)],
      new Map([
        [id(1), deal('settled')],
        [id(2), deal('committed', 1n)],
        [id(3), deal('funded', 1n, 9_999_999)],
        [id(4), deal('funded', 1n, 1)],
        [id(5), deal('refunded')],
      ]),
      [],
      now,
    )
    const status = Object.fromEntries(rows.map((r) => [r.escrowId, r.status]))
    expect(status[id(1)]).toBe('delivered')
    expect(status[id(2)]).toBe('in-challenge')
    expect(status[id(3)]).toBe('waiting')
    expect(status[id(4)]).toBe('refundable')
    expect(status[id(5)]).toBe('refunded')
    expect(status[id(6)]).toBe('unknown')
  })

  it('joins the receipt by escrow id, and leaves it absent when it has expired', () => {
    const rows = orderRows(
      [event(1, 1, 1n), event(2, 2, 1n)],
      new Map(),
      [receipt(1, 10, 8)],
    )
    const byId = new Map(rows.map((r) => [r.escrowId, r]))
    expect(byId.get(id(1))!.receipt?.tokensOut).toBe(8)
    expect(byId.get(id(2))!.receipt).toBeUndefined()
  })
})

describe('orderRows and the delivery', () => {
  const withHash = (state: DealState, hash: Hex): Deal => ({ ...deal(state), outputHash: hash })

  it('takes the output hash from the deal, which outlives the receipt', () => {
    const rows = orderRows(
      [event(1, 1_000, 8n)],
      new Map([[id(1), withHash('settled', `0x${'cd'.repeat(32)}`)]]),
      [],
    )
    expect(rows[0]!.outputHash).toBe(`0x${'cd'.repeat(32)}`)
  })

  it('reports no output hash for a deal that was never committed', () => {
    const rows = orderRows([event(1, 1_000, 8n)], new Map([[id(1), deal('funded', 8n)]]), [])
    expect(rows[0]!.outputHash).toBeUndefined()
  })

  it('carries the Swarm reference from a public receipt', () => {
    const rows = orderRows([event(1, 1_000, 8n)], new Map([[id(1), deal('settled')]]), [receipt(1, 3, 8)])
    expect(rows[0]!.outputRef).toBe('ab'.repeat(32))
  })

  it('withholds the reference from a private receipt, which is sealed to the buyer', () => {
    const rows = orderRows(
      [event(1, 1_000, 8n)],
      new Map([[id(1), deal('settled')]]),
      [{ ...receipt(1, 3, 8), visibility: 'private' }],
    )
    expect(rows[0]!.outputRef).toBeUndefined()
    expect(rows[0]!.receipt?.tokensOut).toBe(8)
  })
})

describe('mergeSaved', () => {
  const saved = (over: Partial<LedgerRow> = {}): LedgerRow => ({
    escrowId: id(1),
    jobId: 'job1',
    amountWei: 8n,
    model: '0gm-1.0-35b-a3b',
    maxTokens: 8,
    visibility: 'public',
    prompt: 'summarise this',
    expiresAt: 1_000,
    postedAt: 1_000,
    ...over,
  })

  const rows = () => orderRows([event(1, 1_000, 8n)], new Map([[id(1), deal('settled')]]), [])

  it('adds the prompt and the answer a buyer kept locally', () => {
    const merged = mergeSaved(rows(), [saved({ outputText: 'the answer' })])
    expect(merged[0]!.prompt).toBe('summarise this')
    expect(merged[0]!.outputText).toBe('the answer')
  })

  it('adds the names of what was attached, and marks the row as kept in this browser', () => {
    const merged = mergeSaved(rows(), [saved({ attachmentNames: ['cat.jpg'] })])
    expect(merged[0]!.attachmentNames).toEqual(['cat.jpg'])
    expect(merged[0]!.savedHere).toBe(true)
    expect(mergeSaved(rows(), [])[0]!.savedHere).toBeUndefined()
  })

  it('fills the Swarm reference once the Arkiv receipt is gone', () => {
    const merged = mergeSaved(rows(), [saved({ outputRef: 'ef'.repeat(32) })])
    expect(merged[0]!.outputRef).toBe('ef'.repeat(32))
  })

  it('prefers the live receipt’s reference over the saved one', () => {
    const live = orderRows([event(1, 1_000, 8n)], new Map([[id(1), deal('settled')]]), [receipt(1, 3, 8)])
    const merged = mergeSaved(live, [saved({ outputRef: 'ef'.repeat(32) })])
    expect(merged[0]!.outputRef).toBe('ab'.repeat(32))
  })

  it('fills the receipt detail from the saved copy when Arkiv no longer has one', () => {
    const merged = mergeSaved(rows(), [
      saved({
        receipt: { modelServed: 'gone-from-arkiv', tokensIn: 3, tokensOut: 8, latencyMs: 900, worker: WORKER },
      }),
    ])
    expect(merged[0]!.receipt).toEqual({ modelServed: 'gone-from-arkiv', tokensIn: 3, tokensOut: 8 })
    expect(merged[0]!.receiptFrom).toBe('saved')
  })

  it('does not let a saved copy override what Arkiv still serves', () => {
    const live = orderRows([event(1, 1_000, 8n)], new Map([[id(1), deal('settled')]]), [receipt(1, 3, 8)])
    const merged = mergeSaved(live, [
      saved({
        receipt: { modelServed: 'stale', tokensIn: 99, tokensOut: 99, latencyMs: 1, worker: WORKER },
      }),
    ])
    expect(merged[0]!.receipt?.modelServed).toBe('0gm-1.0-35b-a3b')
    expect(merged[0]!.receiptFrom).toBe('receipt')
  })

  it('matches on escrow id regardless of case', () => {
    const merged = mergeSaved(rows(), [saved({ escrowId: id(1).toUpperCase() as Hex })])
    expect(merged[0]!.prompt).toBe('summarise this')
  })

  it('leaves a row alone when nothing was saved for it, and adds no rows', () => {
    const merged = mergeSaved(rows(), [saved({ escrowId: id(9) })])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.prompt).toBeUndefined()
    expect(merged[0]!.outputText).toBeUndefined()
  })

  it('is a no-op on an empty ledger, which is every wallet but your own', () => {
    expect(mergeSaved(rows(), [])).toEqual(rows())
  })
})

describe('savingsOf', () => {
  const delivered = (paidWei: bigint, tokensIn: number, tokensOut: number) =>
    orderRows([event(1, 1, paidWei)], new Map([[id(1), deal('settled')]]), [receipt(1, tokensIn, tokensOut)])[0]!

  it('is the list price of the tokens served, minus what was paid in USD', () => {
    const s = savingsOf(delivered(5n * 10n ** 17n, 1_000_000, 1_000_000), PRICING)!
    expect(s.listUsd).toBeCloseTo(3)
    expect(s.paidUsd).toBeCloseTo(1.5)
    expect(s.savedUsd).toBeCloseTo(1.5)
  })

  it('reports a negative saving as negative, never clamped to zero', () => {
    const s = savingsOf(delivered(10n ** 18n, 0, 1_000_000), PRICING)!
    expect(s.savedUsd).toBeCloseTo(-1)
  })

  it('has no figure without pricing, without a receipt, or for an order that was not delivered', () => {
    expect(savingsOf(delivered(1n, 1, 1), null)).toBeNull()
    const noReceipt = orderRows([event(1, 1, 1n)], new Map([[id(1), deal('settled')]]), [])[0]!
    expect(savingsOf(noReceipt, PRICING)).toBeNull()
    const refunded = orderRows([event(1, 1, 1n)], new Map([[id(1), deal('refunded')]]), [receipt(1, 1, 1)])[0]!
    expect(savingsOf(refunded, PRICING)).toBeNull()
  })
})

describe('orderTotals', () => {
  it('counts refunded money as not spent, and says how many savings it could not compute', () => {
    const rows = orderRows(
      [event(1, 1, 5n * 10n ** 17n), event(2, 2, 7n), event(3, 3, 9n)],
      new Map([
        [id(1), deal('settled')],
        [id(2), deal('refunded')],
        [id(3), deal('settled')],
      ]),
      [receipt(1, 1_000_000, 1_000_000)],
    )
    const t = orderTotals(rows, PRICING)
    expect(t.orders).toBe(3)
    expect(t.delivered).toBe(2)
    expect(t.refunded).toBe(1)
    expect(t.spentWei).toBe(5n * 10n ** 17n + 9n)
    expect(t.savedUsd).toBeCloseTo(1.5)
    expect(t.savingsCounted).toBe(1)
    expect(t.savingsMissing).toBe(1)
  })

  it('has no saved figure at all without pricing', () => {
    const rows = orderRows([event(1, 1, 1n)], new Map([[id(1), deal('settled')]]), [receipt(1, 1, 1)])
    expect(orderTotals(rows, null).savedUsd).toBeNull()
  })
})

describe('saleRows', () => {
  it('takes a collected amount from Settled, and an awaiting one from the live deal', () => {
    const rows = saleRows(
      [event(1, 1_000, undefined, WORKER), event(2, 2_000, undefined, WORKER)],
      [event(1, 1_500, 8000n, WORKER)],
      new Map([
        [id(1), deal('settled', 0n)],
        [id(2), deal('committed', 300n)],
      ]),
      [receipt(2, 5, 8)],
    )
    expect(rows.map((r) => [r.escrowId, r.status, r.earnedWei])).toEqual([
      [id(2), 'awaiting', 300n],
      [id(1), 'collected', 8000n],
    ])
    expect(rows[0]!.receipt?.tokensOut).toBe(8)
  })

  it('a settled deal with no Settled event in hand has an unknown amount, not zero', () => {
    const rows = saleRows([event(1, 1, undefined, WORKER)], [], new Map([[id(1), deal('settled', 0n)]]), [])
    expect(rows[0]!.status).toBe('collected')
    expect(rows[0]!.earnedWei).toBeNull()
  })

  it('a challenged deal refunded to the buyer earned nothing', () => {
    const rows = saleRows([event(1, 1, undefined, WORKER)], [], new Map([[id(1), deal('refunded')]]), [])
    expect(rows[0]!.status).toBe('refunded')
    expect(rows[0]!.earnedWei).toBe(0n)
  })
})

describe('saleTotals', () => {
  it('splits collected from awaiting and counts tokens only where a receipt survives', () => {
    const rows = saleRows(
      [event(1, 1, undefined, WORKER), event(2, 2, undefined, WORKER), event(3, 3, undefined, WORKER)],
      [event(1, 1, 8000n, WORKER)],
      new Map([
        [id(1), deal('settled')],
        [id(2), deal('committed', 300n)],
        [id(3), deal('settled')],
      ]),
      [receipt(1, 5, 8), receipt(2, 5, 6)],
    )
    const t = saleTotals(rows)
    expect(t.sales).toBe(3)
    expect(t.collectedWei).toBe(8000n)
    expect(t.awaitingWei).toBe(300n)
    expect(t.unknownAmounts).toBe(1)
    expect(t.tokensOut).toBe(14)
  })
})

describe('formatUsd', () => {
  it('keeps cents for ordinary figures and significant digits for tiny ones', () => {
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0000032)).toBe('$0.0000032')
    expect(formatUsd(-0.25)).toBe('−$0.25')
  })
})

describe('savingsWindows', () => {
  it('splits savings at the start of the credit day, by when each order was funded', () => {
    const dayStart = 10_000
    const rows = orderRows(
      [event(1, 9_999, 5n * 10n ** 17n), event(2, 10_000, 5n * 10n ** 17n), event(3, 12_000, 5n * 10n ** 17n)],
      new Map([
        [id(1), deal('settled')],
        [id(2), deal('settled')],
        [id(3), deal('settled')],
      ]),
      [receipt(1, 1_000_000, 1_000_000), receipt(2, 1_000_000, 1_000_000), receipt(3, 1_000_000, 1_000_000)],
    )
    const w = savingsWindows(rows, PRICING, dayStart)
    expect(w.today.savedUsd).toBeCloseTo(3)
    expect(w.today.savingsCounted).toBe(2)
    expect(w.overall.savedUsd).toBeCloseTo(4.5)
    expect(w.overall.savingsCounted).toBe(3)
  })

  it('has no figure in either window without pricing', () => {
    const w = savingsWindows([], null, 0)
    expect(w.today.savedUsd).toBeNull()
    expect(w.overall.savedUsd).toBeNull()
  })
})

describe('profitWindows', () => {
  it('splits earnings at the start of the credit day, by when each job was committed', () => {
    const dayStart = 10_000
    const rows = saleRows(
      [event(1, 9_999, undefined, WORKER), event(2, 10_000, undefined, WORKER), event(3, 12_000, undefined, WORKER), event(4, 12_500, undefined, WORKER)],
      [event(1, 9_999, 8000n, WORKER)],
      new Map([
        [id(1), deal('settled')],
        [id(2), deal('committed', 300n)],
        [id(3), deal('settled')],
        [id(4), deal('refunded')],
      ]),
      [],
    )
    const w = profitWindows(rows, dayStart)
    expect(w.today.earnedWei).toBe(300n)
    expect(w.today.jobs).toBe(2)
    expect(w.today.unknownAmounts).toBe(1)
    expect(w.overall.earnedWei).toBe(8300n)
    expect(w.overall.jobs).toBe(3)
    expect(w.overall.unknownAmounts).toBe(1)
  })

  it('is zero in both windows with no sales', () => {
    const w = profitWindows([], 0)
    expect(w.today).toEqual({ earnedWei: 0n, jobs: 0, unknownAmounts: 0 })
    expect(w.overall).toEqual({ earnedWei: 0n, jobs: 0, unknownAmounts: 0 })
  })
})
