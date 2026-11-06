import { describe, expect, it } from 'vitest'
import { ConfigError } from '@dusk/core'
import { browserPricing } from '../src/lib/config'

const ALL = {
  NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_IN: '0.1',
  NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_OUT: '0.4',
  NEXT_PUBLIC_DUSK_0G_USD: '2.5',
}

describe('browserPricing', () => {
  it('reads all three', () => {
    expect(browserPricing(ALL)).toEqual({ usdPer1mIn: 0.1, usdPer1mOut: 0.4, usdPer0g: 2.5 })
  })

  it('is null when none are set, so the page says "not configured"', () => {
    expect(browserPricing({})).toBeNull()
    expect(browserPricing({ NEXT_PUBLIC_DUSK_0G_USD: '' })).toBeNull()
  })

  it('refuses a partial set rather than guessing the rest', () => {
    expect(() => browserPricing({ NEXT_PUBLIC_DUSK_0G_USD: '2.5' })).toThrow(ConfigError)
  })

  it('refuses a value that is not a non-negative number', () => {
    expect(() => browserPricing({ ...ALL, NEXT_PUBLIC_DUSK_0G_USD: 'abc' })).toThrow(/NEXT_PUBLIC_DUSK_0G_USD/)
    expect(() => browserPricing({ ...ALL, NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_OUT: '-1' })).toThrow(ConfigError)
  })
})
