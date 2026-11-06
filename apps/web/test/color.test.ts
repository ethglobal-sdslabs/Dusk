import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, over, rgbToCss } from '../src/lib/color'

describe('hexToRgb', () => {
  it('reads a six-digit hex', () => {
    expect(hexToRgb('#E8B04B')).toEqual([232, 176, 75])
    expect(hexToRgb('#0A0E1A')).toEqual([10, 14, 26])
  })

  it('refuses anything else rather than silently returning black', () => {
    expect(() => hexToRgb('#fff')).toThrow()
    expect(() => hexToRgb('E8B04B')).toThrow()
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG endpoints', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 2)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 6)
  })

  it('does not care which colour is the foreground', () => {
    expect(contrastRatio('#E8B04B', '#1B2240')).toBeCloseTo(contrastRatio('#1B2240', '#E8B04B'), 10)
  })
})

describe('mix and over', () => {
  it('mixes linearly', () => {
    expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128])
    expect(mix([10, 20, 30], [10, 20, 30], 0.7)).toEqual([10, 20, 30])
  })

  it('composites a translucent colour over a backdrop', () => {
    expect(over([255, 255, 255], [0, 0, 0], 1)).toEqual([255, 255, 255])
    expect(over([255, 255, 255], [0, 0, 0], 0)).toEqual([0, 0, 0])
  })
})

describe('rgbToCss', () => {
  it('is a plain rgb() triple', () => {
    expect(rgbToCss([10, 14, 26])).toBe('rgb(10, 14, 26)')
  })
})
