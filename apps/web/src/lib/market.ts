import { winningClaim, type Claim, type Job, type WorkerAd } from '@dusk/core'
import type { MarketSnapshot } from './arkiv'

export type MarketSummary = {
  liveWorkers: number
  openJobs: number
  activeClaims: number
  cheapestPer1kOut: bigint | null
  modelsOnOffer: number
}

type Supply = Pick<MarketSnapshot, 'workers'>
type Demand = Pick<MarketSnapshot, 'jobs'>
type Leases = Pick<MarketSnapshot, 'claims'>

export function marketSummary(snapshot: Supply & Demand & Leases): MarketSummary {
  const prices = snapshot.workers.map((w) => w.pricePer1kOut)
  const models = new Set(snapshot.workers.flatMap((w) => w.models))
  return {
    liveWorkers: snapshot.workers.length,
    openJobs: openJobsOf(snapshot).length,
    activeClaims: snapshot.claims.length,
    cheapestPer1kOut: prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a)),
    modelsOnOffer: models.size,
  }
}

export function openJobsOf(snapshot: Demand): Job[] {
  return snapshot.jobs.filter((job) => job.status === 'open')
}

export function supplyRows(snapshot: Supply): WorkerAd[] {
  return [...snapshot.workers].sort(
    (a, b) => compareBigint(a.pricePer1kOut, b.pricePer1kOut) || a.id.localeCompare(b.id),
  )
}

export function demandRows(snapshot: Demand): Job[] {
  return openJobsOf(snapshot).sort(
    (a, b) => compareBigint(b.maxPricePer1kOut, a.maxPricePer1kOut) || a.id.localeCompare(b.id),
  )
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function claimForJob(snapshot: Leases, jobId: string): Claim | undefined {
  return winningClaim(snapshot.claims.filter((claim) => claim.jobId === jobId))
}

export function workerById(snapshot: Supply, workerId: string): WorkerAd | undefined {
  return snapshot.workers.find((worker) => worker.id === workerId)
}

export function isEmptyMarket(snapshot: Supply & Demand): boolean {
  return snapshot.workers.length === 0 && openJobsOf(snapshot).length === 0
}

export type MarketView = 'reading' | 'unreadable' | 'empty' | 'market'

export function marketView(state: { hasAnswer: boolean; error: string | null; empty: boolean }): MarketView {
  if (!state.hasAnswer) return state.error === null ? 'reading' : 'unreadable'
  return state.empty ? 'empty' : 'market'
}

export function formatWei(wei: bigint): string {
  return wei.toLocaleString('en-US')
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
