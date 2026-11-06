import type { ModelInfo } from '@dusk/core'

export type ListPrice =
  | { unit: '1k-out'; wei: bigint; usdPer1mIn?: number; usdPer1mOut?: number }
  | { unit: 'image'; wei: bigint; usd?: number }

const perMillion = (usdPerToken: number | undefined): number | undefined =>
  usdPerToken === undefined ? undefined : Number((usdPerToken * 1e6).toPrecision(12))

export function listPrice(catalog: readonly ModelInfo[] | null | undefined, model: string, isImage: boolean): ListPrice | null {
  const info = catalog?.find((m) => m.id === model.trim())
  const p = info?.pricing
  if (!p) return null
  if (isImage) {
    if (p.perImageNeuron === undefined) return null
    return { unit: 'image', wei: p.perImageNeuron, ...(p.perImageUsd !== undefined ? { usd: p.perImageUsd } : {}) }
  }
  if (p.outNeuronPerToken === undefined) return null
  const usdPer1mIn = perMillion(p.inUsdPerToken)
  const usdPer1mOut = perMillion(p.outUsdPerToken)
  return {
    unit: '1k-out',
    wei: p.outNeuronPerToken * 1000n,
    ...(usdPer1mIn !== undefined ? { usdPer1mIn } : {}),
    ...(usdPer1mOut !== undefined ? { usdPer1mOut } : {}),
  }
}

export function shareOfList(typed: bigint, list: bigint): string | null {
  if (list <= 0n) return null
  if (typed >= list) {
    const times = Number((typed * 100n) / list) / 100
    return times === 1 ? 'at list' : `${Number(times.toPrecision(3))}× list`
  }
  const basisPoints = (typed * 10_000n) / list
  if (basisPoints === 0n) return 'under 0.01% of list'
  const pct = Number(basisPoints) / 100
  return `${Number(pct.toPrecision(pct < 1 ? 2 : 3))}% of list`
}

export function weiAsOg(wei: bigint): string {
  const og = Number(wei) / 1e18
  if (og === 0) return '0'
  return og >= 1 ? og.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(Number(og.toPrecision(3)))
}
