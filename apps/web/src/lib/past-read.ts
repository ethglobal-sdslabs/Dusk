'use client'

import { attrEq, createArkivReader, type ArkivReader } from '@dusk/arkiv'
import { createEscrowHistory, type EscrowHistory, type HistoryEvent } from '@dusk/escrow'
import type { Deal, Receipt, ReputationMirror, Verification, WorkerAd } from '@dusk/core'
import type { Address, Hex } from 'viem'
import { browserArkivAccessKey, browserEns, browserReadConfig, browserVerifiers } from './config'
import { createEnsReader, createPublishedReputationReader } from '@dusk/ens'
import { loadLedger } from './history'
import { mergeSaved, orderRows, saleRows, type ChainEvent, type OrderRow, type SaleRow } from './past'
import { sellerRecords, withModeration, withPublishedReputation, type SellerRecord } from './reputation'

export type HistorySources = { escrow: EscrowHistory; arkiv: ArkivReader; receiptTtlSec: number; verifiers?: string[] }

export function historySources(): HistorySources | null {
  const config = browserReadConfig()
  if (!config.escrow.address) return null
  const accessKey = browserArkivAccessKey()
  return {
    escrow: createEscrowHistory({ rpc: config.escrow.rpc, chainId: config.escrow.chainId, address: config.escrow.address }),
    arkiv: createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, ...(accessKey ? { accessKey } : {}) }),
    receiptTtlSec: config.ttl.receipt,
    verifiers: browserVerifiers(),
  }
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

async function timed(escrow: EscrowHistory, events: readonly HistoryEvent[]): Promise<ChainEvent[]> {
  const times = await escrow.blockTimes(events.map((e) => e.blockNumber))
  return events.map((e) => ({
    escrowId: e.escrowId,
    party: e.party,
    txHash: e.txHash,
    at: times.get(e.blockNumber) ?? 0,
    ...(e.amountWei === undefined ? {} : { amountWei: e.amountWei }),
  }))
}

async function dealsFor(escrow: EscrowHistory, ids: readonly Hex[]): Promise<Map<Hex, Deal>> {
  const distinct = [...new Set(ids)]
  const deals = await inBatches(distinct, 6, async (id) => [id, await escrow.deal(id)] as const)
  return new Map(deals)
}

export async function readOrders(sources: HistorySources, buyer: Address, nowMs = Date.now()): Promise<OrderRow[]> {
  const [funded, receipts] = await Promise.all([
    sources.escrow.events('Funded', buyer),
    sources.arkiv.query<Receipt>('receipt'),
  ])
  const [events, deals] = await Promise.all([
    timed(sources.escrow, funded),
    dealsFor(sources.escrow, funded.map((e) => e.escrowId)),
  ])
  return mergeSaved(orderRows(events, deals, receipts, nowMs), loadLedger(buyer, undefined, nowMs))
}

export async function readSales(sources: HistorySources, worker: Address): Promise<SaleRow[]> {
  const [committed, settled, receipts] = await Promise.all([
    sources.escrow.events('Committed', worker),
    sources.escrow.events('Settled', worker),
    sources.arkiv.query<Receipt>('receipt', attrEq('receipt', 'worker', worker)),
  ])
  const done = new Set(settled.map((e) => e.escrowId.toLowerCase()))
  const open = committed.filter((e) => !done.has(e.escrowId.toLowerCase())).map((e) => e.escrowId)
  const [committedEvents, settledEvents, deals] = await Promise.all([
    timed(sources.escrow, committed),
    timed(sources.escrow, settled),
    dealsFor(sources.escrow, open),
  ])
  const mine = receipts.filter((r) => r.worker?.toLowerCase() === worker.toLowerCase())
  return saleRows(committedEvents, settledEvents, deals, mine)
}

export async function readReputation(sources: HistorySources): Promise<SellerRecord[]> {
  const [funded, committed, settled, challenged, receipts, ads, verifications] = await Promise.all([
    sources.escrow.events('Funded'),
    sources.escrow.events('Committed'),
    sources.escrow.events('Settled'),
    sources.escrow.events('Challenged'),
    sources.arkiv.query<Receipt>('receipt'),
    sources.arkiv.query<WorkerAd>('worker'),
    sources.arkiv.query<Verification>('verification').catch(() => [] as Verification[]),
  ])
  const all = [...funded, ...committed, ...settled, ...challenged]
  const times = await sources.escrow.blockTimes(all.map((e) => e.blockNumber))
  const at = (events: readonly HistoryEvent[]): ChainEvent[] =>
    events.map((e) => ({
      escrowId: e.escrowId,
      party: e.party,
      txHash: e.txHash,
      at: times.get(e.blockNumber) ?? 0,
      ...(e.amountWei === undefined ? {} : { amountWei: e.amountWei }),
      ...(e.outputHash === undefined ? {} : { outputHash: e.outputHash }),
    }))
  const records = sellerRecords(
    { funded: at(funded), committed: at(committed), settled: at(settled), challenged: at(challenged) },
    receipts,
    ads,
    verifications,
    sources.verifiers ?? [],
  )
  let ens: ReturnType<typeof browserEns>
  try { ens = browserEns() } catch { return records }
  if (!ens?.controller) return records
  const reader = createEnsReader(ens)
  const published = ens.reputation ? createPublishedReputationReader(ens) : undefined
  const mirrors = published ? await sources.arkiv.query<ReputationMirror>('reputation_v1').catch(() => [] as ReputationMirror[]) : []
  return inBatches(records, 4, async (record) => {
    const moderated = withModeration(record, await reader.identityOf(record.worker))
    return published ? withPublishedReputation(moderated, await published.read(record.worker, mirrors)) : moderated
  })
}
