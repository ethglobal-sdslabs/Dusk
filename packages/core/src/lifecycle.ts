import { nextCreditReset, type ClockConfig } from './clock'
import { isImageModel } from './image'
import type { Claim, CompletionResult, CreditsBucket, Deal, Job } from './types'

export function winningClaim(claims: Claim[]): Claim | undefined {
  return [...claims].sort(
    (a, b) =>
      cmpBlock(a.createdAtBlock, b.createdAtBlock) ||
      a.claimedAt - b.claimedAt ||
      (a.id < b.id ? -1 : 1),
  )[0]
}

function cmpBlock(a?: bigint, b?: bigint): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return a < b ? -1 : 1
}

export function jobExpiry(deadlineMs: number, clock: ClockConfig, now: Date): number {
  return Math.min(deadlineMs, nextCreditReset(clock, now).getTime())
}

export function isDeliverable(result: CompletionResult): boolean {
  return result.text.trim().length > 0 && result.tokensOut > 0
}

export function parseCreditBalance(raw: string): bigint {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return 0n
  const [whole] = trimmed.split('.')
  try {
    return BigInt(whole || '0')
  } catch {
    return 0n
  }
}

export function creditsBucketOf(remaining: bigint, dayStart: bigint): CreditsBucket {
  if (dayStart <= 0n) return '<10%'
  if (remaining > dayStart) return '>50%'
  const pct = (remaining * 100n) / dayStart
  if (pct <= 10n) return '<10%'
  if (pct <= 50n) return '10-50%'
  return '>50%'
}

const WRAPPER_TOKENS = 20

export function estimateInputTokens(chars: number): number {
  return Math.ceil(chars / 3) + WRAPPER_TOKENS
}

export function jobTokens(job: { maxTokens: number; inputChars?: number }): number {
  return job.maxTokens + (job.inputChars === undefined ? 0 : estimateInputTokens(job.inputChars))
}

export function jobPriceWei(maxPricePer1kOut: bigint, tokens: number): bigint {
  const price = (maxPricePer1kOut * BigInt(tokens) + 999n) / 1000n
  return price > 0n ? price : 1n
}

export function jobAmountWei(
  job: { model: string; maxTokens: number; inputChars?: number },
  pricePerUnit: bigint,
  imageModels: readonly string[],
): bigint {
  if (!isImageModel(job.model, imageModels)) return jobPriceWei(pricePerUnit, jobTokens(job))
  const amount = pricePerUnit * BigInt(job.maxTokens)
  return amount > 0n ? amount : 1n
}

export function escrowDeadlineSec(expiresAtMs: number): number {
  return Math.ceil(expiresAtMs / 1000)
}

export function hasTimeToDeliver(job: Job, nowMs: number, marginMs: number): boolean {
  return job.expiresAt - nowMs > marginMs
}

export function isFundedFor(
  deal: Deal,
  job: Job,
  pricePer1kOut: bigint,
  imageModels: readonly string[] = [],
): boolean {
  return (
    deal.state === 'funded' &&
    deal.amount >= jobAmountWei(job, pricePer1kOut, imageModels) &&
    deal.deadlineSec >= escrowDeadlineSec(job.expiresAt) &&
    job.owner !== undefined &&
    deal.buyer.toLowerCase() === job.owner.toLowerCase()
  )
}

export function fundingPrice(
  maxPricePer1kOut: bigint,
  model: string,
  ads: readonly { models: string[]; payout?: string; pricePer1kOut: bigint }[],
  fallbackPayout: string | undefined,
): bigint {
  if (!fallbackPayout) return maxPricePer1kOut
  const sellers = ads.filter((a) => a.models.includes(model))
  const ours = (a: { payout?: string }) => a.payout?.toLowerCase() === fallbackPayout.toLowerCase()
  if (sellers.length === 0 || !sellers.every(ours)) return maxPricePer1kOut
  const price = sellers.reduce((lo, a) => (a.pricePer1kOut < lo ? a.pricePer1kOut : lo), sellers[0]!.pricePer1kOut)
  return price < maxPricePer1kOut ? price : maxPricePer1kOut
}
