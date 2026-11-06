import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, type Rgb } from '../src/lib/color'
import { EMBER, PALE } from '../src/three/sky.glsl'
import { groundColors, panelSurface } from '../src/three/sky'
import { CSS, worstOverCycle } from './css'

function emberTextMix(): number {
  const m = /--ember-text:\s*color-mix\(in srgb,\s*var\(--ember\)\s*(\d+)%,\s*var\(--pale\)\)/.exec(CSS)
  if (!m) {
    throw new Error(
      'could not find --ember-text in globals.css as a color-mix of --ember and --pale. ' +
        'If the declaration changed shape, this test is no longer measuring the colour it thinks it is.',
    )
  }
  return Number(m[1]) / 100
}

const emberText = (): Rgb => mix(hexToRgb(EMBER), hexToRgb(PALE), 1 - emberTextMix())

describe('--ember-text', () => {
  it('is a mix of --ember toward --pale, not a seventh colour from nowhere', () => {
    expect(emberTextMix()).toBeGreaterThan(0)
    expect(emberTextMix()).toBeLessThan(1)
  })

  it('clears 4.5:1 on a panel through the whole cycle', () => {
    expect(worstOverCycle((p) => contrastRatio(emberText(), panelSurface(p)))).toBeGreaterThanOrEqual(4.5)
  })

  it('clears 4.5:1 on the ground through the whole cycle', () => {
    expect(worstOverCycle((p) => contrastRatio(emberText(), groundColors(p)[0]))).toBeGreaterThanOrEqual(4.5)
  })

  it('exists because --ember itself does not clear the floor as text', () => {
    expect(worstOverCycle((p) => contrastRatio(EMBER, panelSurface(p)))).toBeLessThan(4.5)
  })

  it('stays cool, matching the monochrome space palette', () => {
    const [r, , b] = emberText()
    expect(r).toBeLessThan(b)
    expect(hexToRgb(PALE)[0]).toBeLessThan(hexToRgb(PALE)[2])
  })

  it('is declared once, so there is one place to change it', () => {
    expect((CSS.match(/--ember-text:/g) ?? []).length).toBe(1)
  })

  it('leaves no --ember text colour behind', () => {
    expect(CSS).not.toMatch(/(?:^|[\s;{])color:\s*var\(--ember\)\s*;/m)
  })
})

describe('the palette gains nothing else', () => {
  it('has no green anywhere', () => {
    expect(CSS).not.toMatch(/\bgreen\b/i)
  })
})
