import { keccak256, toHex, type Address, type Hex } from 'viem'
import type { Deal } from '@dusk/core'

export const REPUTATION_POLICY = {
  id: 'dusk-rep-v2',
  version: 2,
  minGrantLeadSec: 600,
  minAbandoned: 3,
  minDistinctBuyers: 2,
  minAbandonRate: 0.5,
  reasonCodes: { receiptContradictsChain: 10, grantedNotCommitted: 11 },
} as const

export type ReputationPolicy = typeof REPUTATION_POLICY

export type ReputationEvidence = {
  deals: ReadonlyMap<string, Deal>
  receipts: ReadonlyArray<{ owner?: Address; escrowId: Hex; outputHash: Hex }>
  grants: ReadonlyArray<{ owner?: Address; escrowId: Hex; worker: Address; grantedAtSec?: number }>
  verifiedBuyers?: ReadonlySet<string>
  nowSec: number
  exclude?: ReadonlySet<string>
}

export type ReputationSignal =
  | { kind: 'receipt-contradicts-chain'; escrowId: Hex; committed: Hex; receipt: Hex }
  | { kind: 'granted-not-committed'; abandoned: number; served: number; buyers: number; buyersVerified: boolean; buyerInfluenced: true; escrowIds: Hex[] }

export type BanProposal = {
  wallet: string
  policyId: string
  policyVersion: number
  reasonCode: number
  signals: ReputationSignal[]
  evidence: string
  evidenceHash: Hex
  decisionId: string
}

const lc = (s: string) => s.toLowerCase()

export function proposeBans(e: ReputationEvidence, policy: ReputationPolicy = REPUTATION_POLICY): BanProposal[] {
  const deals = new Map<string, Deal>()
  for (const [k, v] of e.deals) deals.set(lc(k), v)
  const signals = new Map<string, ReputationSignal[]>()
  const add = (w: string, s: ReputationSignal) => signals.set(w, [...(signals.get(w) ?? []), s])

  const seenReceipt = new Set<string>()
  for (const r of [...e.receipts].sort((a, b) => (lc(a.escrowId) < lc(b.escrowId) ? -1 : 1))) {
    if (!r.owner) continue
    const deal = deals.get(lc(r.escrowId))
    if (!deal || (deal.state !== 'committed' && deal.state !== 'settled')) continue
    if (lc(deal.worker) !== lc(r.owner) || lc(deal.outputHash) === lc(r.outputHash)) continue
    const key = `${lc(r.owner)}:${lc(r.escrowId)}`
    if (seenReceipt.has(key)) continue
    seenReceipt.add(key)
    add(lc(r.owner), { kind: 'receipt-contradicts-chain', escrowId: lc(r.escrowId) as Hex, committed: lc(deal.outputHash) as Hex, receipt: lc(r.outputHash) as Hex })
  }

  const tally = new Map<string, { abandoned: Set<string>; served: Set<string>; buyers: Set<string> }>()
  for (const g of e.grants) {
    if (!g.owner) continue
    const deal = deals.get(lc(g.escrowId))
    if (!deal || lc(deal.buyer) !== lc(g.owner)) continue
    const w = lc(g.worker)
    const t = tally.get(w) ?? { abandoned: new Set(), served: new Set(), buyers: new Set() }
    tally.set(w, t)
    const committed = deal.state === 'committed' || deal.state === 'settled'
    if (committed && lc(deal.worker) === w) t.served.add(lc(g.escrowId))
    else if (deal.state === 'refunded' || (deal.state === 'funded' && e.nowSec > deal.deadlineSec)) {
      if (g.grantedAtSec === undefined || g.grantedAtSec > deal.deadlineSec - policy.minGrantLeadSec) continue
      t.abandoned.add(lc(g.escrowId))
      if (!e.verifiedBuyers || e.verifiedBuyers.has(lc(g.owner))) t.buyers.add(lc(g.owner))
    }
  }
  for (const [w, t] of tally) {
    const abandoned = t.abandoned.size
    const rate = abandoned / (abandoned + t.served.size)
    if (abandoned < policy.minAbandoned || t.buyers.size < policy.minDistinctBuyers || rate < policy.minAbandonRate) continue
    add(w, { kind: 'granted-not-committed', abandoned, served: t.served.size, buyers: t.buyers.size, buyersVerified: e.verifiedBuyers !== undefined, buyerInfluenced: true, escrowIds: [...t.abandoned].sort() as Hex[] })
  }

  return [...signals.entries()]
    .filter(([w]) => !e.exclude?.has(w))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([wallet, list]) => {
      const evidence = JSON.stringify({ policy: policy.id, version: policy.version, wallet, signals: list })
      const evidenceHash = keccak256(toHex(evidence))
      const reasonCode = list.some((s) => s.kind === 'receipt-contradicts-chain') ? policy.reasonCodes.receiptContradictsChain : policy.reasonCodes.grantedNotCommitted
      return { wallet, policyId: policy.id, policyVersion: policy.version, reasonCode, signals: list, evidence, evidenceHash, decisionId: `${policy.id}-${wallet.slice(2, 10)}-${evidenceHash.slice(2, 10)}` }
    })
}
