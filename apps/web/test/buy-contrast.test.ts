import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, over } from '../src/lib/color'
import { PALE, ZENITH } from '../src/three/sky.glsl'
import { groundColors, panelSurface } from '../src/three/sky'
import { CSS, worstOverCycle } from './css'

function disabledAlpha(): number {
  const m =
    /button:disabled\s*\{[^}]*?(?:^|[\s;{])color:\s*color-mix\(in srgb,\s*var\(--pale\)\s*(\d+)%,\s*transparent\)/m.exec(
      CSS,
    )
  if (!m) throw new Error('could not find the disabled button label colour in globals.css')
  return Number(m[1]) / 100
}

describe('buttons', () => {
  it('reads comfortably when filled, dark on light', () => {
    expect(contrastRatio(ZENITH, PALE)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps a disabled label above the floor on a panel', () => {
    const alpha = disabledAlpha()
    expect(
      worstOverCycle((p) => {
        const surface = panelSurface(p)
        return contrastRatio(over(hexToRgb(PALE), surface, alpha), surface)
      }),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps a disabled label above the floor on the ground, where the form actually sits', () => {
    const alpha = disabledAlpha()
    expect(
      worstOverCycle((p) => {
        const ground = groundColors(p)[0]
        return contrastRatio(over(hexToRgb(PALE), ground, alpha), ground)
      }),
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('a field that is wrong', () => {
  it('marks the input with --ember and says why in --ember-text', () => {
    expect(CSS).toMatch(/aria-invalid='true'\][\s\S]*?border-color:\s*var\(--ember\)/)
    expect(CSS).toMatch(/\.field-error\s*\{[^}]*color:\s*var\(--ember-text\)/)
  })
})
