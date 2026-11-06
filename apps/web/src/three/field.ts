import type { Job } from '@dusk/core'
import type { Address } from 'viem'
import { hexToRgb, mix, type Rgb } from '../lib/color'
import type { Burn, MarketSnapshot } from '../lib/arkiv'
import { openJobsOf } from '../lib/market'
import { EMBER, GLOW_MAX_FRACTION, HORIZON_Y, LASTLIGHT, PALE } from './sky.glsl'

const GLOW_TOP = HORIZON_Y + GLOW_MAX_FRACTION * (1 - HORIZON_Y)

export const WORKER_BAND: readonly [number, number] = [GLOW_TOP + 0.025, GLOW_TOP + 0.105]
export const JOB_BAND: readonly [number, number] = [GLOW_TOP + 0.145, 0.95]

export const X_MARGIN = 0.06

export const MAX_LIGHTS = 800

export type FieldKind = 'worker' | 'job' | 'claim' | 'burn'

export type FieldLight = {
  id: string
  kind: FieldKind
  from: [number, number]
  to: [number, number]
  sizePx: number
  color: Rgb
  glow: number
}

const pale = hexToRgb(PALE)
const ember = hexToRgb(EMBER)
const lastlight = hexToRgb(LASTLIGHT)

const WORKER_SIZE_PX = 3.6
const WORKER_GLOW = 0.55
const JOB_SIZE_PX = 6
const JOB_GLOW = 0.95
const CLAIM_WIDTH_PX = 1.5
const CLAIM_GLOW = 0.6
const BURN_SIZE_PX = 8
const BURN_RISE = 0.07

export function hash01(seed: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}

function band(kind: 'worker' | 'job'): readonly [number, number] {
  return kind === 'worker' ? WORKER_BAND : JOB_BAND
}

export function positionOf(kind: 'worker' | 'job', id: string): [number, number] {
  const [low, high] = band(kind)
  const x = X_MARGIN + hash01(`${kind}:x:${id}`) * (1 - 2 * X_MARGIN)
  const y = low + hash01(`${kind}:y:${id}`) * (high - low)
  return [x, y]
}

export function claimHeat(claimedAtMs: number, ttlClaimSec: number, nowMs: number): number {
  const lease = Math.max(1, ttlClaimSec * 1000)
  return Math.min(1, Math.max(0, (nowMs - claimedAtMs) / lease))
}

export type FieldInput = {
  snapshot: MarketSnapshot
  burns: readonly Burn[]
  ttlClaimSec: number
  burnMs: number
  reducedMotion?: boolean
}

export function layoutField(input: FieldInput, nowMs: number): FieldLight[] {
  const { snapshot, ttlClaimSec } = input
  const lights: FieldLight[] = []

  const openJobs = openJobsOf(snapshot)
  const jobsById = new Map(openJobs.map((job) => [job.id, job]))
  const workersById = new Map(snapshot.workers.map((worker) => [worker.id, worker]))
  const claimedJobs = new Set(snapshot.claims.map((claim) => claim.jobId))

  for (const claim of snapshot.claims) {
    const job = jobsById.get(claim.jobId)
    const worker = workersById.get(claim.workerId)
    if (!job || !worker) continue
    const heat = claimHeat(claim.claimedAt, ttlClaimSec, nowMs)
    lights.push({
      id: claim.id,
      kind: 'claim',
      from: positionOf('job', job.id),
      to: positionOf('worker', worker.id),
      sizePx: CLAIM_WIDTH_PX,
      color: mix(pale, ember, heat),
      glow: CLAIM_GLOW + 0.25 * heat,
    })
  }

  for (const worker of snapshot.workers) {
    const at = positionOf('worker', worker.id)
    lights.push({ id: worker.id, kind: 'worker', from: at, to: at, sizePx: WORKER_SIZE_PX, color: pale, glow: WORKER_GLOW })
  }

  for (const job of openJobs) {
    const at = positionOf('job', job.id)
    const claimed = claimedJobs.has(job.id)
    lights.push({
      id: job.id,
      kind: 'job',
      from: at,
      to: at,
      sizePx: claimed ? JOB_SIZE_PX * 1.15 : JOB_SIZE_PX,
      color: pale,
      glow: JOB_GLOW,
    })
  }

  for (const burn of input.burns) {
    const age = (nowMs - burn.firstSeenMs) / Math.max(1, input.burnMs)
    if (age < 0 || age > 1) continue
    const [x, y] = burnOrigin(snapshot, jobsById, burn)
    const still = input.reducedMotion === true
    const at: [number, number] = [x, still ? y : Math.min(1, y + BURN_RISE * age)]
    lights.push({
      id: `burn:${burn.id}`,
      kind: 'burn',
      from: at,
      to: at,
      sizePx: still ? BURN_SIZE_PX : BURN_SIZE_PX * (1 - 0.45 * age),
      color: lastlight,
      glow: still ? 1 : 1 - age * age,
    })
  }

  return lights
}

function burnOrigin(snapshot: MarketSnapshot, jobsById: Map<string, Job>, burn: Burn): [number, number] {
  const job = jobsById.get(burn.jobId)
  if (job) return positionOf('job', job.id)
  const receipt = snapshot.receipts.find((r) => r.id === burn.id)
  const worker = receipt ? workerByPayout(snapshot, receipt.worker) : undefined
  if (worker) return positionOf('worker', worker.id)
  return positionOf('job', burn.id)
}

function workerByPayout(snapshot: MarketSnapshot, payout: Address): MarketSnapshot['workers'][number] | undefined {
  const wanted = payout.toLowerCase()
  return snapshot.workers.find((w) => w.payout.toLowerCase() === wanted)
}
