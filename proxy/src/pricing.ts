import type { TrustMode, WorkerAd } from '@dusk/core'

export type BidSource = 'request' | 'env' | 'market-max'

export type Bid = {
  wei: bigint
  source: BidSource
  /** Live workers serving the model (and trust mode) whose ask this bid meets. */
  reaches: number
  /** Live workers serving the model (and trust mode) at all. */
  live: number
}

export class NoWorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoWorkerError'
  }
}

/** Ads that can serve this model in this trust mode. A standard job is open to every provider. */
export function eligibleAds(ads: readonly WorkerAd[], model: string, trustMode: TrustMode): WorkerAd[] {
  return ads.filter(
    (ad) => ad.models?.includes(model) && (trustMode === 'standard' || (ad.trustModes ?? []).includes(trustMode)),
  )
}

/**
 * Choose the bid in wei per 1k output tokens.
 *
 * An explicit price (request, then env) wins. Without one, bid the HIGHEST live ask so every
 * worker advertising the model can take the job. If that ask is above the operator cap, bid the
 * cap: it still reaches every worker asking at or below it.
 */
export function chooseBid(opts: {
  ads: readonly WorkerAd[]
  model: string
  trustMode: TrustMode
  cap: bigint
  requested?: bigint
  envPrice?: bigint
}): Bid {
  const asks = eligibleAds(opts.ads, opts.model, opts.trustMode).map((ad) => ad.pricePer1kOut)
  const reachesAt = (wei: bigint) => asks.filter((a) => a <= wei).length
  const fixed = opts.requested !== undefined ? { wei: opts.requested, source: 'request' as const } : undefined
  const envFixed = opts.envPrice !== undefined ? { wei: opts.envPrice, source: 'env' as const } : undefined
  const explicit = fixed ?? envFixed
  if (explicit) return { ...explicit, reaches: reachesAt(explicit.wei), live: asks.length }

  if (asks.length === 0) {
    throw new NoWorkerError(
      `no live worker advertises ${opts.model}${opts.trustMode === 'standard' ? '' : ` in ${opts.trustMode} mode`} right now, ` +
        'so there is no ask to price against. GET /v1/models lists what is on offer.',
    )
  }
  const max = asks.reduce((m, a) => (a > m ? a : m))
  const wei = max > opts.cap ? opts.cap : max
  const reaches = reachesAt(wei)
  if (reaches === 0) {
    const min = asks.reduce((m, a) => (a < m ? a : m))
    throw new NoWorkerError(
      `every live ask for ${opts.model} is above the operator bid cap of ${opts.cap} wei/1k (cheapest is ${min}). ` +
        'Raise DUSK_PROXY_MAX_PRICE or pass max_price_per_1k_out.',
    )
  }
  return { wei, source: 'market-max', reaches, live: asks.length }
}
