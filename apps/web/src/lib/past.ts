import type { Deal, Receipt, SwarmRef } from '@dusk/core'
import type { Address, Hex } from 'viem'
import type { LedgerRow } from './history'

export type ChainEvent = {
  outputHash?: Hex
  escrowId: Hex
  party: Address
  txHash: Hex
  at: number
  amountWei?: bigint
}

export type Pricing = { usdPer1mIn: number; usdPer1mOut: number; usdPer0g: number }

export type ReceiptDetail = Pick<Receipt, 'modelServed' | 'tokensIn' | 'tokensOut'>

export type OrderStatus = 'delivered' | 'in-challenge' | 'waiting' | 'refundable' | 'refunded' | 'unknown'

export type OrderRow = {
  escrowId: Hex
  fundTx: Hex
  at: number
  paidWei: bigint
  status: OrderStatus
  receipt?: ReceiptDetail
  receiptFrom?: 'receipt' | 'saved'
  outputHash?: Hex
  outputRef?: SwarmRef
  prompt?: string
  outputText?: string
  attachmentNames?: string[]
  savedHere?: true
}

const NO_HASH = `0x${'00'.repeat(32)}`

export type SaleStatus = 'collected' | 'awaiting' | 'refunded' | 'unknown'

export type SaleRow = {
  escrowId: Hex
  commitTx: Hex
  at: number
  earnedWei: bigint | null
  status: SaleStatus
  receipt?: ReceiptDetail
}

const key = (escrowId: string) => escrowId.toLowerCase()

function distinct(events: readonly ChainEvent[]): ChainEvent[] {
  const seen = new Map<string, ChainEvent>()
  for (const e of events) if (!seen.has(key(e.escrowId))) seen.set(key(e.escrowId), e)
  return [...seen.values()].sort((a, b) => b.at - a.at)
}

function receiptsByEscrow(receipts: readonly Receipt[]): Map<string, ReceiptDetail> {
  const out = new Map<string, ReceiptDetail>()
  for (const r of receipts) {
    if (!r.escrowId || out.has(key(r.escrowId))) continue
    out.set(key(r.escrowId), { modelServed: r.modelServed, tokensIn: r.tokensIn, tokensOut: r.tokensOut })
  }
  return out
}

function publicRefsByEscrow(receipts: readonly Receipt[]): Map<string, SwarmRef> {
  const out = new Map<string, SwarmRef>()
  for (const r of receipts) {
    if (!r.escrowId || out.has(key(r.escrowId))) continue
    if ((r.visibility ?? 'public') === 'private') continue
    if (r.outputRef) out.set(key(r.escrowId), r.outputRef)
  }
  return out
}

function lookup<T>(map: ReadonlyMap<Hex, T>, escrowId: Hex): T | undefined {
  return map.get(escrowId) ?? [...map.entries()].find(([k]) => key(k) === key(escrowId))?.[1]
}

function orderStatus(deal: Deal | undefined, nowMs: number): OrderStatus {
  switch (deal?.state) {
    case 'settled':
      return 'delivered'
    case 'committed':
      return 'in-challenge'
    case 'funded':
      return deal.deadlineSec * 1000 <= nowMs ? 'refundable' : 'waiting'
    case 'refunded':
      return 'refunded'
    default:
      return 'unknown'
  }
}

export function orderRows(
  funded: readonly ChainEvent[],
  deals: ReadonlyMap<Hex, Deal>,
  receipts: readonly Receipt[],
  nowMs = Date.now(),
): OrderRow[] {
  const detail = receiptsByEscrow(receipts)
  const refs = publicRefsByEscrow(receipts)
  return distinct(funded).map((e) => {
    const receipt = detail.get(key(e.escrowId))
    const deal = lookup(deals, e.escrowId)
    const outputHash = deal && deal.outputHash.toLowerCase() !== NO_HASH ? deal.outputHash : undefined
    const outputRef = refs.get(key(e.escrowId))
    return {
      escrowId: e.escrowId,
      fundTx: e.txHash,
      at: e.at,
      paidWei: e.amountWei ?? 0n,
      status: orderStatus(deal, nowMs),
      ...(receipt ? { receipt, receiptFrom: 'receipt' as const } : {}),
      ...(outputHash ? { outputHash } : {}),
      ...(outputRef ? { outputRef } : {}),
    }
  })
}

export function mergeSaved(rows: readonly OrderRow[], saved: readonly LedgerRow[]): OrderRow[] {
  if (saved.length === 0) return [...rows]
  const mine = new Map(saved.map((r) => [key(r.escrowId), r]))
  return rows.map((row) => {
    const own = mine.get(key(row.escrowId))
    if (!own) return row
    const fillReceipt = row.receipt === undefined && own.receipt !== undefined
    return {
      ...row,
      savedHere: true as const,
      ...(own.prompt ? { prompt: own.prompt } : {}),
      ...(own.attachmentNames ? { attachmentNames: own.attachmentNames } : {}),
      ...(own.outputText !== undefined ? { outputText: own.outputText } : {}),
      ...(row.outputRef === undefined && own.outputRef ? { outputRef: own.outputRef } : {}),
      ...(row.outputHash === undefined && own.outputHash ? { outputHash: own.outputHash } : {}),
      ...(fillReceipt
        ? {
            receipt: {
              modelServed: own.receipt!.modelServed,
              tokensIn: own.receipt!.tokensIn,
              tokensOut: own.receipt!.tokensOut,
            },
            receiptFrom: 'saved' as const,
          }
        : {}),
    }
  })
}

export type Savings = { listUsd: number; paidUsd: number; savedUsd: number }

const WEI_PER_0G = 1e18

export function savingsOf(row: OrderRow, pricing: Pricing | null): Savings | null {
  if (!pricing || !row.receipt) return null
  if (row.status !== 'delivered' && row.status !== 'in-challenge') return null
  const listUsd =
    (row.receipt.tokensIn * pricing.usdPer1mIn + row.receipt.tokensOut * pricing.usdPer1mOut) / 1e6
  const paidUsd = (Number(row.paidWei) / WEI_PER_0G) * pricing.usdPer0g
  return { listUsd, paidUsd, savedUsd: listUsd - paidUsd }
}

export type OrderTotals = {
  orders: number
  delivered: number
  refunded: number
  spentWei: bigint
  savedUsd: number | null
  savingsCounted: number
  savingsMissing: number
}

export function orderTotals(rows: readonly OrderRow[], pricing: Pricing | null): OrderTotals {
  let delivered = 0
  let refunded = 0
  let spentWei = 0n
  let savedUsd = 0
  let savingsCounted = 0
  let savingsMissing = 0
  for (const row of rows) {
    if (row.status === 'refunded') refunded++
    else spentWei += row.paidWei
    if (row.status !== 'delivered' && row.status !== 'in-challenge') continue
    delivered++
    const s = savingsOf(row, pricing)
    if (s) {
      savedUsd += s.savedUsd
      savingsCounted++
    } else if (pricing) {
      savingsMissing++
    }
  }
  return {
    orders: rows.length,
    delivered,
    refunded,
    spentWei,
    savedUsd: pricing ? savedUsd : null,
    savingsCounted,
    savingsMissing,
  }
}

export type SavingsWindows = { today: OrderTotals; overall: OrderTotals }

export function savingsWindows(rows: readonly OrderRow[], pricing: Pricing | null, dayStartMs: number): SavingsWindows {
  return {
    today: orderTotals(rows.filter((row) => row.at >= dayStartMs), pricing),
    overall: orderTotals(rows, pricing),
  }
}

export function saleRows(
  committed: readonly ChainEvent[],
  settled: readonly ChainEvent[],
  deals: ReadonlyMap<Hex, Deal>,
  receipts: readonly Receipt[],
): SaleRow[] {
  const detail = receiptsByEscrow(receipts)
  const paid = new Map(settled.map((e) => [key(e.escrowId), e.amountWei]))
  return distinct(committed).map((e) => {
    const deal = lookup(deals, e.escrowId)
    const settledAmount = paid.get(key(e.escrowId))
    let status: SaleStatus
    let earnedWei: bigint | null
    if (settledAmount !== undefined || deal?.state === 'settled') {
      status = 'collected'
      earnedWei = settledAmount ?? null
    } else if (deal?.state === 'committed') {
      status = 'awaiting'
      earnedWei = deal.amount
    } else if (deal?.state === 'refunded') {
      status = 'refunded'
      earnedWei = 0n
    } else {
      status = 'unknown'
      earnedWei = null
    }
    const receipt = detail.get(key(e.escrowId))
    return { escrowId: e.escrowId, commitTx: e.txHash, at: e.at, earnedWei, status, ...(receipt ? { receipt } : {}) }
  })
}

export type SaleTotals = {
  sales: number
  collectedWei: bigint
  awaitingWei: bigint
  unknownAmounts: number
  tokensOut: number
}

export function saleTotals(rows: readonly SaleRow[]): SaleTotals {
  let collectedWei = 0n
  let awaitingWei = 0n
  let unknownAmounts = 0
  let tokensOut = 0
  for (const row of rows) {
    if (row.earnedWei === null) unknownAmounts++
    else if (row.status === 'collected') collectedWei += row.earnedWei
    else if (row.status === 'awaiting') awaitingWei += row.earnedWei
    tokensOut += row.receipt?.tokensOut ?? 0
  }
  return { sales: rows.length, collectedWei, awaitingWei, unknownAmounts, tokensOut }
}

export type ProfitTotals = {
  earnedWei: bigint
  jobs: number
  unknownAmounts: number
}

export type ProfitWindows = { today: ProfitTotals; overall: ProfitTotals }

function profitTotals(rows: readonly SaleRow[]): ProfitTotals {
  let earnedWei = 0n
  let jobs = 0
  let unknownAmounts = 0
  for (const row of rows) {
    if (row.status === 'refunded') continue
    jobs++
    if (row.earnedWei === null) unknownAmounts++
    else earnedWei += row.earnedWei
  }
  return { earnedWei, jobs, unknownAmounts }
}

export function profitWindows(rows: readonly SaleRow[], dayStartMs: number): ProfitWindows {
  return {
    today: profitTotals(rows.filter((row) => row.at >= dayStartMs)),
    overall: profitTotals(rows),
  }
}

export function formatUsd(usd: number): string {
  const sign = usd < 0 ? '−' : ''
  const abs = Math.abs(usd)
  if (abs === 0 || abs >= 0.01) return `${sign}$${abs.toFixed(2)}`
  return `${sign}$${Number(abs.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(abs))))}`
}
