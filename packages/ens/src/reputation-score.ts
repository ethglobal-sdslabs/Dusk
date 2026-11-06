import { encodeAbiParameters, getAddress, keccak256, toHex, zeroHash, type Address, type Hex } from 'viem'
import { applyFinding, canaryScore, lateThresholdMs, newFindingState, verdictFinding, type FindingKind } from '@dusk/core'

// v2: canary scoring (@dusk/core canary-score), mirrored by DuskReputation.sol.
export const REPUTATION_SCORE_POLICY_VERSION = 2
export const AUTOMATIC_REPUTATION_POLICY = { below: 50, minimumResolved: 3, intervalSeconds: 4 * 3600 } as const

export type ReputationSources = {
  ensChainId: number
  controller: Address
  galileoChainId: number
  escrow: Address
  arkivChainId: number
  verifiers: readonly Address[]
}

export type ReputationCommit = { escrowId: Hex; worker: Address; outputHash: Hex; blockNumber: bigint; transactionHash: Hex }
export type ReputationResolution = { escrowId: Hex; worker: Address; result: 'settled' | 'rejected'; blockNumber: bigint; transactionHash: Hex }
export type ReputationEntity = {
  id: string
  creator?: Address
  readonly?: boolean
  createdAtBlock?: bigint
  escrowId: Hex
  worker: Address
  outputHash?: Hex
  result?: 'pass' | 'bad' | 'illegal'
  /** Verification only: why (`empty-answer`, `no-delivery`, `delivered`, …). */
  check?: string
  /** Verification only: canary claim to receipt, from Arkiv's block stamps. */
  latencyMs?: number
}
export type ReputationFinding = { job: Hex; kind: FindingKind }
export type ReputationFacts = {
  sources: ReputationSources
  commits: readonly ReputationCommit[]
  resolutions: readonly ReputationResolution[]
  receipts: readonly ReputationEntity[]
  verifications: readonly ReputationEntity[]
  finalizedArkivBlock: bigint
  snapshotHashes?: { ens: Hex; galileo: Hex; arkiv: Hex }
}

const lower = (s: string) => s.toLowerCase()
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function reputationSourceHash(sources: ReputationSources): Hex {
  const verifiers = [...new Set(sources.verifiers.map(lower))].sort().map((a) => getAddress(a))
  return keccak256(encodeAbiParameters(
    [{ type: 'uint32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address[]' }],
    [REPUTATION_SCORE_POLICY_VERSION, BigInt(sources.ensChainId), sources.controller, BigInt(sources.galileoChainId), sources.escrow, BigInt(sources.arkivChainId), verifiers],
  ))
}

export function reputationJobId(sources: Pick<ReputationSources, 'galileoChainId' | 'escrow'>, escrowId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }], [BigInt(sources.galileoChainId), sources.escrow, escrowId]))
}

export function reputationScore(badAnswers: number, illegal: number, late = 0, passed = 0): number {
  for (const count of [badAnswers, illegal, late, passed]) if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) throw new Error('Invalid reputation count.')
  return canaryScore({ empty: badAnswers, illegal, late, passed })
}

export function reputationFindings(wallet: Address, facts: ReputationFacts) {
  const who = lower(wallet)
  const commits = new Map<string, ReputationCommit>()
  for (const commit of facts.commits) {
    const id = lower(commit.escrowId)
    const previous = commits.get(id)
    if (previous && (lower(previous.worker) !== lower(commit.worker) || lower(previous.outputHash) !== lower(commit.outputHash))) throw new Error('Contradictory escrow history; no reputation may be published.')
    commits.set(id, commit)
  }
  const resolutions = new Map<string, ReputationResolution>()
  for (const resolution of facts.resolutions) {
    const commit = commits.get(lower(resolution.escrowId))
    if (!commit || lower(commit.worker) !== lower(resolution.worker)) throw new Error('Incomplete escrow history; no reputation may be published.')
    const previous = resolutions.get(lower(resolution.escrowId))
    if (previous && previous.result !== resolution.result) throw new Error('Contradictory resolved job; no reputation may be published.')
    resolutions.set(lower(resolution.escrowId), resolution)
  }
  const mine = [...resolutions.values()].filter((r) => lower(r.worker) === who)
  const settledJobs = mine.filter((r) => r.result === 'settled').length
  const rejectedJobs = mine.filter((r) => r.result === 'rejected').length
  const findings = new Map<string, ReputationFinding & { entityId: string; creator: Address; createdAtBlock: string; escrowId: Hex; committedHash?: Hex; claimedHash?: Hex; verdict?: string; check?: string; latencyMs?: number }>()
  const add = (entity: ReputationEntity, kind: FindingKind) => {
    const job = reputationJobId(facts.sources, entity.escrowId)
    const key = `${job}:${kind}`
    const committed = commits.get(lower(entity.escrowId))?.outputHash
    if (!findings.has(key)) findings.set(key, { job, kind, entityId: entity.id, creator: entity.creator!, createdAtBlock: String(entity.createdAtBlock), escrowId: entity.escrowId,
      ...(committed ? { committedHash: committed } : {}), ...(entity.outputHash ? { claimedHash: entity.outputHash } : {}), ...(entity.result ? { verdict: entity.result } : {}),
      ...(entity.check ? { check: entity.check } : {}), ...(entity.latencyMs !== undefined ? { latencyMs: entity.latencyMs } : {}) })
  }
  const immutable = (entity: ReputationEntity) => entity.readonly === true && entity.creator !== undefined &&
    entity.createdAtBlock !== undefined && entity.createdAtBlock <= facts.finalizedArkivBlock
  for (const entity of [...facts.receipts].sort((a, b) => compare(a.id, b.id))) {
    if (!immutable(entity) || lower(entity.creator!) !== who || lower(entity.worker) !== who || !entity.outputHash) continue
    const commit = commits.get(lower(entity.escrowId))
    if (commit && lower(commit.worker) === who && lower(commit.outputHash) !== lower(entity.outputHash)) add(entity, 2)
  }
  const trusted = new Set(facts.sources.verifiers.map(lower))
  const verdicts = facts.verifications.filter((e) => immutable(e) && trusted.has(lower(e.creator!)) && e.result !== undefined)
  // "Late" is measured against every seller's delivered canaries, not this one's.
  const lateAfterMs = lateThresholdMs(verdicts.map((e) => ({ escrowId: e.escrowId, result: e.result!, latencyMs: e.latencyMs })))
  for (const entity of [...verdicts].sort((a, b) => compare(a.id, b.id))) {
    if (lower(entity.worker) !== who) continue
    const commit = commits.get(lower(entity.escrowId))
    // A no-delivery has no commit behind it — the seller never delivered.
    if ((!commit || lower(commit.worker) !== who) && entity.check !== 'no-delivery') continue
    const kind = verdictFinding({ result: entity.result!, check: entity.check ?? '', latencyMs: entity.latencyMs }, lateAfterMs)
    if (kind !== null) add(entity, kind)
  }
  return { settledJobs, rejectedJobs, resolvedDigest: keccak256(toHex(JSON.stringify(mine.sort((a, b) => compare(lower(a.escrowId), lower(b.escrowId))).map((r) => [lower(r.escrowId), r.result, String(r.blockNumber), r.transactionHash])))),
    findings: [...findings.values()].sort((a, b) => compare(`${a.job}:${a.kind}`, `${b.job}:${b.kind}`)) }
}

export type ReputationEvaluation = {
  wallet: Address; generation: bigint; score: number; settledJobs: number; rejectedJobs: number;
  badAnswers: number; illegal: number; late: number; passed: number; policyVersion: number; evaluatedAt: bigint;
  galileoBlock: bigint; arkivBlock: bigint; evidenceHash: Hex; evidenceRef: Hex; findings: ReputationFinding[];
}

export function evaluateReputation(args: {
  wallet: Address; generation: bigint; evaluatedAt: bigint; galileoBlock: bigint; facts: ReputationFacts;
  previous: { badAnswers: number; illegal: number; late?: number; passed?: number; flags: ReadonlyMap<string, number> };
}) {
  const fresh = reputationFindings(args.wallet, args.facts)
  // Replays exactly what DuskReputation._applyFinding will do with these findings, so the
  // counts and score submitted are the ones the contract computes — or it refuses them.
  const state = newFindingState(
    { empty: args.previous.badAnswers, illegal: args.previous.illegal, late: args.previous.late ?? 0, passed: args.previous.passed ?? 0 },
    args.previous.flags,
  )
  const novel: ReputationFinding[] = []
  for (const finding of fresh.findings) {
    if (novel.length >= 200) break
    if (applyFinding(state, finding.job, finding.kind)) novel.push({ job: finding.job, kind: finding.kind })
  }
  const { empty: badAnswers, illegal, late, passed } = state.counts
  const score = reputationScore(badAnswers, illegal, late, passed)
  const evidence = JSON.stringify({
    policy: REPUTATION_SCORE_POLICY_VERSION, sources: reputationSourceHash(args.facts.sources),
    wallet: lower(args.wallet), generation: String(args.generation), evaluatedAt: String(args.evaluatedAt),
    galileoBlock: String(args.galileoBlock), arkivBlock: String(args.facts.finalizedArkivBlock),
    ...(args.facts.snapshotHashes ? { snapshotHashes: args.facts.snapshotHashes } : {}), resolvedDigest: fresh.resolvedDigest,
    previous: { badAnswers: args.previous.badAnswers, illegal: args.previous.illegal, late: args.previous.late ?? 0, passed: args.previous.passed ?? 0 },
    settledJobs: fresh.settledJobs, rejectedJobs: fresh.rejectedJobs,
    findings: fresh.findings.filter((f) => novel.some((n) => n.job === f.job && n.kind === f.kind)),
  })
  const evaluation: ReputationEvaluation = {
    wallet: args.wallet, generation: args.generation, score, settledJobs: fresh.settledJobs, rejectedJobs: fresh.rejectedJobs,
    badAnswers, illegal, late, passed, policyVersion: REPUTATION_SCORE_POLICY_VERSION, evaluatedAt: args.evaluatedAt,
    galileoBlock: args.galileoBlock, arkivBlock: args.facts.finalizedArkivBlock, evidenceHash: keccak256(toHex(evidence)), evidenceRef: zeroHash, findings: novel,
  }
  return { evaluation, evidence }
}
