import { describe, expect, it } from 'vitest'
import type { WorkerAd } from '@dusk/core'
import { chooseBid, NoWorkerError } from '../src/pricing'

const ad = (price: bigint, models = ['m'], trustModes: WorkerAd['trustModes'] = ['standard']): WorkerAd =>
  ({ id: String(price), models, pricePer1kOut: price, trustModes, creditsBucket: '>50%', payout: '0x0' }) as WorkerAd

const base = { model: 'm', trustMode: 'standard' as const, cap: 10_000n }

describe('chooseBid', () => {
  it('bids the highest live ask when no price is set, so every worker can take it', () => {
    const bid = chooseBid({ ...base, ads: [ad(100n), ad(900n), ad(400n), ad(5000n, ['other'])] })
    expect(bid).toEqual({ wei: 900n, source: 'market-max', reaches: 3, live: 3 })
  })

  it('prefers a request price, then the env price, over the market', () => {
    const ads = [ad(100n), ad(900n)]
    expect(chooseBid({ ...base, ads, requested: 150n, envPrice: 2000n })).toMatchObject({ wei: 150n, source: 'request', reaches: 1 })
    expect(chooseBid({ ...base, ads, envPrice: 2000n })).toMatchObject({ wei: 2000n, source: 'env', reaches: 2 })
  })

  it('clamps to the operator cap when the top ask is above it', () => {
    const bid = chooseBid({ ...base, cap: 1000n, ads: [ad(500n), ad(800n), ad(50_000n)] })
    expect(bid).toEqual({ wei: 1000n, source: 'market-max', reaches: 2, live: 3 })
  })

  it('refuses when no worker is live or every ask is over the cap', () => {
    expect(() => chooseBid({ ...base, ads: [] })).toThrow(NoWorkerError)
    expect(() => chooseBid({ ...base, cap: 10n, ads: [ad(500n)] })).toThrow(/above the operator bid cap/)
  })

  it('prices verified jobs only against TEE-capable workers', () => {
    const ads = [ad(100n, ['m'], ['standard', 'verified']), ad(9000n, ['m'], ['standard'])]
    expect(chooseBid({ ...base, trustMode: 'verified', ads })).toMatchObject({ wei: 100n, live: 1 })
    expect(chooseBid({ ...base, ads })).toMatchObject({ wei: 9000n, live: 2 })
  })
})
