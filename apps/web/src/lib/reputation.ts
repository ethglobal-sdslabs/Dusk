import type { Receipt, Verification, WorkerAd } from '@dusk/core'
import { applyFinding, canaryScore, FINDING, lateThresholdMs, newFindingState, verdictFinding } from '@dusk/core'
import type { Address } from 'viem'
import type { PublishedReputationResult, VerifiedIdentity } from '@dusk/ens'
import type { ChainEvent } from './past'

export type MarketEvents = {
  funded: ChainEvent[]
  committed: ChainEvent[]
  settled: ChainEvent[]
  challenged: ChainEvent[]
}

export type SellerRecord = {
  worker: Address
  delivered: number
  collected: number
  challenged: number
  pending: number
  earnedWei: bigint
  reliability: number | null
  medianDeliverMs: number | null
  firstSeen: number
  lastActive: number
  recentReceipts: number
  avgLatencyMs: number | null
  models: string[]
  livePricePer1kOut: bigint | null
  /** Canary verdicts: empty answer or claimed-and-never-delivered. */
  badAnswers: number
  illegal: number
  /** Delivered canaries, and how many of those were late. */
  canaryPassed: number
  canaryLate: number
  score: number
  banned: boolean
  moderationStatus?: 'clear' | 'banned' | 'unknown'
  ensName?: string
  publishedReputationStatus?: 'verified' | 'stale' | 'missing' | 'unknown'
  publishedReputationSource?: 'mirror' | 'chain'
  publishedReputationAt?: number
  officialStanding?: Standing
  reputationEvidenceRef?: string
}

// Canary scoring rules live in @dusk/core so this page, the reputation workflow and
// DuskReputation.sol cannot disagree. Re-exported for the page and older imports.
export {
  EMPTY_ANSWER_PENALTY,
  ILLEGAL_PENALTY,
  LATE_FACTOR,
  LATE_FLOOR_MS,
  LATE_MIN_SAMPLES,
  LATE_PENALTY,
  lateThresholdMs,
  PASS_BONUS,
} from '@dusk/core'
/** @deprecated kept for older imports; an empty answer now costs EMPTY_ANSWER_PENALTY. */
export { EMPTY_ANSWER_PENALTY as BAD_ANSWER_PENALTY } from '@dusk/core'
export const REVIEW_BELOW = 50

const sameHash = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '')

const key = (s: string) => s.toLowerCase()

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function sellerRecords(
  events: MarketEvents,
  receipts: readonly Receipt[],
  ads: readonly WorkerAd[],
  verifications: readonly Verification[] = [],
  verifiers: readonly string[] = [],
): SellerRecord[] {
  const trusted = new Set(verifiers.map(key))
  const committedBy = new Map(events.committed.map((e) => [key(e.escrowId), e]))
  const fundedAt = new Map(events.funded.map((e) => [key(e.escrowId), e.at]))
  const settledBy = new Map(events.settled.map((e) => [key(e.escrowId), e]))
  const challengedJobs = new Set(events.challenged.map((e) => key(e.escrowId)))

  type Acc = { worker: Address; jobs: Map<string, ChainEvent>; times: number[] }
  const sellers = new Map<string, Acc>()
  const sellerFor = (worker: Address) => {
    let acc = sellers.get(key(worker))
    if (!acc) sellers.set(key(worker), (acc = { worker, jobs: new Map(), times: [] }))
    return acc
  }
  for (const e of events.committed) {
    const acc = sellerFor(e.party)
    if (!acc.jobs.has(key(e.escrowId))) acc.jobs.set(key(e.escrowId), e)
    acc.times.push(e.at)
  }

  // Only verdicts from configured verifiers count, and the "late" bar is set by the whole
  // market's delivered canaries, so it moves with how fast 0G actually is.
  const trustedVerdicts = verifications.filter((v) => v.owner !== undefined && trusted.has(key(v.owner)))
  const lateAfterMs = lateThresholdMs(trustedVerdicts)

  const records = [...sellers.values()].map((acc): SellerRecord => {
    let collected = 0
    let challenged = 0
    let earnedWei = 0n
    const deliverMs: number[] = []
    for (const [job, commit] of acc.jobs) {
      const settled = settledBy.get(job)
      if (settled) {
        collected++
        earnedWei += settled.amountWei ?? 0n
        acc.times.push(settled.at)
      } else if (challengedJobs.has(job)) {
        challenged++
      }
      const funded = fundedAt.get(job)
      if (funded !== undefined && commit.at >= funded) deliverMs.push(commit.at - funded)
    }
    const mine = receipts.filter((r) => r.worker && key(r.worker) === key(acc.worker))
    const latencies = mine.map((r) => r.latencyMs).filter((ms) => Number.isFinite(ms))
    const ad = ads.find((a) => a.payout && key(a.payout) === key(acc.worker))
    const resolved = collected + challenged

    // One finding per job, worst wins (`applyFinding`, the contract's own rule). A
    // no-delivery has no commit behind it — the seller never delivered — so it is the
    // one verdict counted without one.
    const state = newFindingState()
    for (const v of trustedVerdicts) {
      const job = key(v.escrowId)
      if (key(v.worker) !== key(acc.worker)) continue
      if (!acc.jobs.has(job) && v.check !== 'no-delivery') continue
      const kind = verdictFinding(v, lateAfterMs)
      if (kind !== null) applyFinding(state, job, kind)
    }
    // A receipt this seller signed that contradicts its own commit is illegal too.
    for (const r of mine) {
      if (!r.owner || key(r.owner) !== key(acc.worker)) continue
      const commit = committedBy.get(key(r.escrowId))
      if (!commit) continue
      if (key(commit.party) !== key(acc.worker) || (commit.outputHash && !sameHash(commit.outputHash, r.outputHash))) {
        applyFinding(state, key(r.escrowId), FINDING.illegal)
      }
    }
    const { empty: badAnswers, illegal, late, passed } = state.counts
    const score = canaryScore(state.counts)
    return {
      worker: acc.worker,
      delivered: acc.jobs.size,
      collected,
      challenged,
      pending: acc.jobs.size - resolved,
      earnedWei,
      reliability: resolved === 0 ? null : collected / resolved,
      medianDeliverMs: median(deliverMs),
      firstSeen: Math.min(...acc.times),
      lastActive: Math.max(...acc.times),
      recentReceipts: mine.length,
      avgLatencyMs: latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      models: [...new Set(mine.map((r) => r.modelServed))].sort(),
      livePricePer1kOut: ad ? ad.pricePer1kOut : null,
      badAnswers,
      illegal,
      canaryPassed: passed + late,
      canaryLate: late,
      score,
      banned: false,
      moderationStatus: 'unknown',
    }
  })

  return records.sort(
    (a, b) => b.collected - a.collected || a.challenged - b.challenged || b.lastActive - a.lastActive,
  )
}

export function withModeration(record: SellerRecord, identity?: VerifiedIdentity): SellerRecord {
  if (!identity || identity.wallet.toLowerCase() !== record.worker.toLowerCase() || identity.status === 'unknown') {
    return { ...record, banned: false, moderationStatus: 'unknown', ensName: undefined }
  }
  const banned = identity.status === 'banned' || identity.status === 'revoked'
  return {
    ...record,
    banned,
    moderationStatus: banned ? 'banned' : 'clear',
    ensName: identity.status === 'active' ? identity.name : undefined,
  }
}

export function withPublishedReputation(record: SellerRecord, result: PublishedReputationResult): SellerRecord {
  const published = result.record
  const conflictsWithAppeal = published?.standing === 'banned' && record.moderationStatus === 'clear'
  if (result.status !== 'verified' || !published || conflictsWithAppeal) return { ...record, publishedReputationStatus: conflictsWithAppeal ? 'stale' : result.status }
  return { ...record, score: published.score, badAnswers: published.badAnswers, illegal: published.illegal,
    ...(published.late !== undefined ? { canaryLate: published.late } : {}),
    ...(published.passed !== undefined ? { canaryPassed: published.passed + (published.late ?? 0) } : {}),
    publishedReputationStatus: 'verified', publishedReputationSource: result.source, publishedReputationAt: published.evaluatedAt * 1000,
    officialStanding: published.standing === 'banned' && !record.banned ? undefined : published.standing,
    reputationEvidenceRef: published.evidenceRef.replace(/^0x/, '') }
}

export type Standing = 'banned' | 'new' | 'trusted' | 'good' | 'disputed'

export const MIN_RESOLVED = 3

export function standingOf(record: SellerRecord): Standing {
  if (record.banned) return 'banned'
  if (record.publishedReputationStatus === 'verified' && record.officialStanding) return record.officialStanding
  if (record.collected + record.challenged < MIN_RESOLVED || record.reliability === null) return 'new'
  if (record.reliability >= 0.95) return 'trusted'
  if (record.reliability >= 0.8) return 'good'
  return 'disputed'
}

export type MarketReputation = {
  sellers: number
  live: number
  delivered: number
  challengeRate: number | null
}

export function marketReputation(records: readonly SellerRecord[]): MarketReputation {
  let delivered = 0
  let challenged = 0
  let resolved = 0
  for (const r of records) {
    delivered += r.delivered
    challenged += r.challenged
    resolved += r.collected + r.challenged
  }
  return {
    sellers: records.length,
    live: records.filter((r) => r.livePricePer1kOut !== null).length,
    delivered,
    challengeRate: resolved === 0 ? null : challenged / resolved,
  }
}
