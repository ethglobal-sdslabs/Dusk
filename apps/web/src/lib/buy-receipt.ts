import type { Claim, Job, Receipt } from '@dusk/core'

export type CreditsSpentView = {
  kind: 'measured' | 'proxy' | 'unstated'
  figure: string
  note: string
}

const WORKERS_CLAIM = 'This is the worker’s own figure, not an attestation from 0G.'

export function creditsSpentView(creditsSpent: string): CreditsSpentView {
  const raw = creditsSpent.trim()

  const proxy = /^tokens:(\d+)\/(\d+)$/.exec(raw)
  if (proxy) {
    return {
      kind: 'proxy',
      figure: raw,
      note: `${WORKERS_CLAIM} It is a token count — ${proxy[1]} in, ${proxy[2]} out — standing in for a cost the Router does not report per request.`,
    }
  }

  if (/^\d+$/.test(raw) && BigInt(raw) > 0n) {
    return {
      kind: 'measured',
      figure: raw,
      note: `${WORKERS_CLAIM} The worker watched its own credit balance drop by this much after the call.`,
    }
  }

  return {
    kind: 'unstated',
    figure: '',
    note: `${WORKERS_CLAIM} It recorded no figure it could stand behind: 0G’s balance settles about forty seconds after a call, so a reading taken straight afterwards shows no movement at all.`,
  }
}

export type JobStage = 'open' | 'claimed' | 'delivered' | 'lapsed'

export function jobStage(args: {
  job: Job
  claims: readonly Claim[]
  receipt: Receipt | undefined
  now: number
  ttlClaimSec: number
}): JobStage {
  if (args.receipt) return 'delivered'
  if (liveLease(args.claims, args.ttlClaimSec, args.now)) return 'claimed'
  if (args.now >= args.job.expiresAt) return 'lapsed'
  return 'open'
}

export function liveLease(claims: readonly Claim[], ttlClaimSec: number, now: number): Claim | undefined {
  return [...claims]
    .sort((a, b) => b.claimedAt - a.claimedAt)
    .find((claim) => leaseRemainingMs(claim, ttlClaimSec, now) > 0)
}

export function leaseRemainingMs(claim: Claim, ttlClaimSec: number, now: number): number {
  return Math.max(0, claim.claimedAt + ttlClaimSec * 1000 - now)
}

export function jobRemainingMs(job: Job, now: number): number {
  return Math.max(0, job.expiresAt - now)
}

export function shortHash(value: string): string {
  if (value.length <= 20) return value
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

export function latencyLabel(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}
