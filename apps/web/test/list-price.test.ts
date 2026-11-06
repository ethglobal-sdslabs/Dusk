import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@dusk/core'
import { listPrice, shareOfList } from '../src/lib/list-price'

const OGM: ModelInfo = {
  id: '0gm-1.0-35b-a3b',
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  pricing: { inNeuronPerToken: 548_000_000_000n, outNeuronPerToken: 3_290_000_000_000n, inUsdPerToken: 0.00000008, outUsdPerToken: 0.00000048 },
}
const ZIMG: ModelInfo = {
  id: 'z-image-turbo',
  inputModalities: ['text'],
  outputModalities: ['image'],
  pricing: { perImageNeuron: 60_411_340_000_000_000n, perImageUsd: 0.0088 },
}

describe('listPrice', () => {
  it('turns a text model’s price into wei per 1,000 output tokens, plus USD per million', () => {
    expect(listPrice([OGM], '0gm-1.0-35b-a3b', false)).toEqual({
      unit: '1k-out',
      wei: 3_290_000_000_000_000n,
      usdPer1mIn: 0.08,
      usdPer1mOut: 0.48,
    })
  })
  it('turns an image model’s price into wei per image', () => {
    expect(listPrice([ZIMG], 'z-image-turbo', true)).toEqual({ unit: 'image', wei: 60_411_340_000_000_000n, usd: 0.0088 })
  })
  it('is null for a model the catalog does not list, or one with no price', () => {
    expect(listPrice([OGM], 'typo-model', false)).toBeNull()
    expect(listPrice([{ ...OGM, pricing: undefined }], '0gm-1.0-35b-a3b', false)).toBeNull()
    expect(listPrice(undefined, '0gm-1.0-35b-a3b', false)).toBeNull()
  })
  it('trims the typed name, as the form does', () => {
    expect(listPrice([OGM], ' 0gm-1.0-35b-a3b ', false)).not.toBeNull()
  })
})

describe('shareOfList', () => {
  it('says what fraction of the list price a typed figure is', () => {
    expect(shareOfList(1_645_000_000_000_000n, 3_290_000_000_000_000n)).toBe('50% of list')
  })
  it('keeps a tiny fraction readable instead of rounding it to 0%', () => {
    expect(shareOfList(1_000_000n, 3_290_000_000_000_000n)).toBe('under 0.01% of list')
  })
  it('names a figure above list', () => {
    expect(shareOfList(6_580_000_000_000_000n, 3_290_000_000_000_000n)).toBe('2× list')
  })
  it('is null when there is no list price to compare to', () => {
    expect(shareOfList(5n, 0n)).toBeNull()
  })
})
