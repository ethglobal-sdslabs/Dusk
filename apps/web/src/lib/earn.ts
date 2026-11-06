'use client'

import { attrEq } from '@dusk/arkiv'
import type { ArkivQuota, ArkivReader } from '@dusk/arkiv'
import type { Claim, CreditsBucket, DealState, Kind, Receipt } from '@dusk/core'
import type { Expression } from '@arkiv-network/sdk/query'
import type { Address, Hex } from 'viem'
import { creditsSpentView, type CreditsSpentView } from './buy-receipt'
import { redactKeyish } from './worker-browser'

export type EarnQuery = { kind: Kind; filter: Expression }

export function earnQueries(workerId: string, payout: Address): Record<'claims' | 'receipts', EarnQuery> {
  return {
    claims: { kind: 'claim', filter: attrEq('claim', 'workerId', workerId) },
    receipts: { kind: 'receipt', filter: attrEq('receipt', 'worker', payout) },
  }
}

export type EarnSnapshot = {
  claims: Claim[]
  receipts: Receipt[]
  readAt: number
}

export const EMPTY_EARN_SNAPSHOT: EarnSnapshot = { claims: [], receipts: [], readAt: 0 }

export async function readEarn(
  reader: ArkivReader,
  workerId: string,
  payout: Address,
  nowMs: number,
): Promise<EarnSnapshot> {
  const q = earnQueries(workerId, payout)
  const [claims, receipts] = await Promise.all([
    reader.query<Claim>(q.claims.kind, q.claims.filter),
    reader.query<Receipt>(q.receipts.kind, q.receipts.filter),
  ])
  return {
    claims: claims.filter((c) => c.workerId === workerId),
    receipts: receipts.filter((r) => r.worker?.toLowerCase() === payout.toLowerCase()),
    readAt: nowMs,
  }
}

export type DealRow = { escrowId: Hex; amountWei: bigint; state: DealState }

export function mergeDeal(previous: DealRow | undefined, next: DealRow): DealRow {
  if (!previous) return next
  return {
    escrowId: next.escrowId,
    state: next.state,
    amountWei: next.amountWei > 0n ? next.amountWei : previous.amountWei,
  }
}

export type Earnings = {
  delivered: number
  tokensOut: number
  collectedWei: bigint
  collectedDeals: number
  collectedUnknown: number
  awaitingWei: bigint
  unknown: number
}

function byJob(receipts: readonly Receipt[], payout?: Address): Receipt[] {
  const seen = new Map<string, Receipt>()
  for (const r of receipts) {
    if (payout && r.worker?.toLowerCase() !== payout.toLowerCase()) continue
    if (!seen.has(r.jobId)) seen.set(r.jobId, r)
  }
  return [...seen.values()]
}

export function earningsOf(
  receipts: readonly Receipt[],
  deals: ReadonlyMap<string, DealRow>,
  payout?: Address,
): Earnings {
  const mine = byJob(receipts, payout)
  let collectedWei = 0n
  let collectedDeals = 0
  let collectedUnknown = 0
  let awaitingWei = 0n
  let unknown = 0

  for (const escrowId of new Set(mine.map((r) => r.escrowId).filter(Boolean))) {
    const deal = deals.get(escrowId)
    if (!deal) {
      unknown++
      continue
    }
    if (deal.state === 'settled') {
      collectedDeals++
      if (deal.amountWei > 0n) collectedWei += deal.amountWei
      else collectedUnknown++
    } else if (deal.state === 'committed') {
      awaitingWei += deal.amountWei
    }
  }

  return {
    delivered: mine.length,
    tokensOut: mine.reduce((sum, r) => sum + r.tokensOut, 0),
    collectedWei,
    collectedDeals,
    collectedUnknown,
    awaitingWei,
    unknown,
  }
}

export function dealsToRead(
  receipts: readonly Receipt[],
  deals: ReadonlyMap<string, DealRow>,
): Hex[] {
  const wanted: Hex[] = []
  for (const escrowId of new Set(receipts.map((r) => r.escrowId).filter(Boolean))) {
    const deal = deals.get(escrowId)
    if (!deal || deal.state === 'committed') wanted.push(escrowId)
  }
  return wanted
}

export function rereadDue(lastAtMs: number, now: number, minIntervalMs: number): boolean {
  if (lastAtMs === 0) return true
  return now < lastAtMs || now - lastAtMs >= minIntervalMs
}

export type ReputationView = { delivered: number; days: number; note: string }

export function reputationView(receipts: readonly Receipt[], ttlReceiptSec: number): ReputationView {
  const days = Math.round(ttlReceiptSec / 86_400)
  const label = days === 1 ? '1 day' : `${days} days`
  return {
    delivered: byJob(receipts).length,
    days,
    note:
      `Counted over the last ${label}, which is how long a receipt lives on Arkiv before ` +
      `its TTL fires. Older work is not hidden — it is gone, because nothing keeps it.`,
  }
}

export type CreditsView = { figure: string; note: string }

export function creditsView(bucket: CreditsBucket | null): CreditsView {
  if (bucket === null) {
    return {
      figure: '—',
      note:
        'This tab cannot read your balance: that needs the 0G key with account:read, and ' +
        'without it your worker advertises the lowest bucket so it never over-promises.',
    }
  }
  return {
    figure: bucket,
    note:
      'A coarse bucket, which is also exactly what your worker ad publishes — the market ' +
      'sees what you see. An exact figure on a public entity would tell every rival how ' +
      'much of tonight’s credit you have left to undercut them with.',
  }
}

export type FeedState = 'working' | 'earned'

export type FeedRow = {
  jobId: string
  state: FeedState
  at: number
  receipt?: Receipt
  credits?: CreditsSpentView
  claim?: Claim
}

export function feedRows(args: {
  claims: readonly Claim[]
  receipts: readonly Receipt[]
  now: number
  ttlClaimSec: number
}): FeedRow[] {
  const earned = new Map<string, FeedRow>()
  for (const receipt of byJob(args.receipts)) {
    earned.set(receipt.jobId, {
      jobId: receipt.jobId,
      state: 'earned',
      at: 0,
      receipt,
      credits: creditsSpentView(receipt.creditsSpent),
    })
  }

  const rows: FeedRow[] = []
  const leaseMs = args.ttlClaimSec * 1000
  for (const claim of args.claims) {
    const row = earned.get(claim.jobId)
    if (row) {
      rows.push({ ...row, at: claim.claimedAt, claim })
      earned.delete(claim.jobId)
      continue
    }
    if (claim.claimedAt + leaseMs <= args.now) continue
    rows.push({ jobId: claim.jobId, state: 'working', at: claim.claimedAt, claim })
  }

  rows.push(...earned.values())

  return rows.sort((a, b) => b.at - a.at)
}

export type QuotaView = { figure: string; note: string }

export function quotaView(quota: ArkivQuota | null): QuotaView {
  if (!quota || quota.usedPercent === undefined) {
    return {
      figure: '—',
      note:
        'Arkiv is not reporting a quota, which means this page is reading anonymously: ' +
        'about 600 requests a minute, shared with every other Dusk tab. Set ' +
        'NEXT_PUBLIC_ARKIV_ACCESS_KEY and the ceiling becomes 9999 a second.',
    }
  }
  return {
    figure: `${quota.usedPercent}%`,
    note:
      `Of this build’s Arkiv quota, as the index reports it on every read. The per-second ` +
      `ceiling is ${quota.limit ?? 'unknown'} requests; this worker makes one to three per tick.`,
  }
}

export function tickNote(result: {
  claimed: number
  delivered: number
  settled: number
  error?: string
}): string | null {
  const parts: string[] = []
  if (result.delivered > 0) parts.push('Earned: a job was claimed, run on 0G and receipted.')
  if (result.settled > 0) {
    parts.push(
      `Collected ${result.settled} ${result.settled === 1 ? 'deal' : 'deals'} from escrow — ` +
        'payment for work this worker committed on chain.',
    )
  }
  if (result.error !== undefined) {
    parts.push(`Claimed but did not deliver: ${redactKeyish(result.error)}`)
  } else if (result.claimed > 0 && result.delivered === 0) {
    parts.push('Claimed a job; it is still running.')
  }
  return parts.length === 0 ? null : parts.join(' ')
}
