/**
 * Canary scoring, policy v2 — one definition for `/reputation`, the reputation workflow
 * and (mirrored line for line) `DuskReputation.sol`. If any of the three drifts, the
 * contract refuses the workflow's evaluations, so they share this module.
 *
 * A seller starts at 100 and stays within 0..100:
 *   delivered canary +10 · late canary -10 · empty answer or claimed-and-never-delivered -20
 *   · illegal (receipt contradicts the chain, output is not what was committed) -50
 *
 * Late is relative: over LATE_FACTOR x the median latency of delivered canaries, once
 * there are LATE_MIN_SAMPLES of them, and never under LATE_FLOOR_MS. What an answer says
 * is not judged.
 */

export const ILLEGAL_PENALTY = 50
export const EMPTY_ANSWER_PENALTY = 20
export const LATE_PENALTY = 10
export const PASS_BONUS = 10
export const LATE_FACTOR = 2
export const LATE_MIN_SAMPLES = 3
export const LATE_FLOOR_MS = 10_000

/** Verdict checks that mean "no usable output". */
export const EMPTY_CHECKS: ReadonlySet<string> = new Set(['empty-answer', 'no-delivery'])

export type FindingCounts = { empty: number; illegal: number; late: number; passed: number }

export function canaryScore(c: FindingCounts): number {
  const points = PASS_BONUS * c.passed - LATE_PENALTY * c.late - EMPTY_ANSWER_PENALTY * c.empty - ILLEGAL_PENALTY * c.illegal
  return Math.min(100, Math.max(0, 100 + points))
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** LATE_FACTOR x the median delivered-canary latency (one per job), or null without enough. */
export function lateThresholdMs(
  verdicts: readonly { escrowId: string; result: string; latencyMs?: number | undefined }[],
): number | null {
  const byJob = new Map<string, number>()
  for (const v of verdicts) {
    if (v.result === 'pass' && v.latencyMs !== undefined && Number.isFinite(v.latencyMs)) byJob.set(v.escrowId.toLowerCase(), v.latencyMs)
  }
  if (byJob.size < LATE_MIN_SAMPLES) return null
  return Math.max(LATE_FLOOR_MS, LATE_FACTOR * median([...byJob.values()]))
}

export function isLate(latencyMs: number | undefined, lateAfterMs: number | null): boolean {
  return lateAfterMs !== null && latencyMs !== undefined && latencyMs > lateAfterMs
}

/**
 * On-chain finding kinds. The numbers are the contract's; never renumber them.
 * 1 and 2 keep their policy-v1 meaning (bad answer → now empty/no-delivery, illegal).
 */
export const FINDING = { empty: 1, illegal: 2, late: 3, pass: 4 } as const
export type FindingKind = (typeof FINDING)[keyof typeof FINDING]

/** Worst wins when one job has several findings. */
const RANK: Record<FindingKind, number> = { 2: 4, 1: 3, 3: 2, 4: 1 }
const COUNTER: Record<FindingKind, keyof FindingCounts> = { 1: 'empty', 2: 'illegal', 3: 'late', 4: 'passed' }
const KINDS: readonly FindingKind[] = [1, 2, 3, 4]

export const findingBit = (kind: FindingKind): number => 1 << (kind - 1)
export const dismissedBit = (kind: FindingKind): number => findingBit(kind) << 4

export type FindingState = { flags: Map<string, number>; counts: FindingCounts }

export function newFindingState(counts: Partial<FindingCounts> = {}, flags?: ReadonlyMap<string, number>): FindingState {
  return {
    flags: new Map(flags ? [...flags].map(([k, v]) => [k.toLowerCase(), v]) : []),
    counts: { empty: 0, illegal: 0, late: 0, passed: 0, ...counts },
  }
}

/**
 * Records `kind` for `job` exactly as `DuskReputation._applyFinding` does, and says
 * whether anything changed. A dismissed or already-recorded kind is ignored; so is one
 * outranked by a finding the job already has. A worse finding clears the job's lesser
 * ones, taking back their points.
 */
export function applyFinding(state: FindingState, job: string, kind: FindingKind): boolean {
  const id = job.toLowerCase()
  let flags = state.flags.get(id) ?? 0
  const bit = findingBit(kind)
  if ((flags & dismissedBit(kind)) !== 0 || (flags & bit) !== 0) return false
  for (const k of KINDS) if ((flags & findingBit(k)) !== 0 && RANK[k] > RANK[kind]) return false
  for (const k of KINDS) {
    if ((flags & findingBit(k)) !== 0 && RANK[k] < RANK[kind]) {
      flags &= ~findingBit(k)
      state.counts[COUNTER[k]]--
    }
  }
  state.flags.set(id, flags | bit)
  state.counts[COUNTER[kind]]++
  return true
}

/** The company's appeal path: clears an active finding and stops it coming back. */
export function dismissFinding(state: FindingState, job: string, kind: FindingKind): void {
  const id = job.toLowerCase()
  let flags = state.flags.get(id) ?? 0
  if ((flags & findingBit(kind)) !== 0) {
    flags &= ~findingBit(kind)
    state.counts[COUNTER[kind]]--
  }
  state.flags.set(id, flags | dismissedBit(kind))
}

/** The finding a verifier verdict counts as; null when it counts as nothing (answer quality). */
export function verdictFinding(
  v: { result: string; check: string; latencyMs?: number | undefined },
  lateAfterMs: number | null,
): FindingKind | null {
  if (v.result === 'illegal') return FINDING.illegal
  if (v.result === 'bad') return EMPTY_CHECKS.has(v.check) ? FINDING.empty : null
  if (v.result === 'pass') return isLate(v.latencyMs, lateAfterMs) ? FINDING.late : FINDING.pass
  return null
}
