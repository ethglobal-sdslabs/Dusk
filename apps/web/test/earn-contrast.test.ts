import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb, mix, over, type Rgb } from '../src/lib/color'
import { EMBER, LASTLIGHT, PALE, VIOLET, ZENITH, ATMOSPHERE } from '../src/three/sky.glsl'
import { groundColors, panelSurface } from '../src/three/sky'
import { CSS, worstOverCycle } from './css'

const TOKENS: Record<string, string> = {
  '--zenith': ZENITH,
  '--atmosphere': ATMOSPHERE,
  '--violet': VIOLET,
  '--ember': EMBER,
  '--lastlight': LASTLIGHT,
  '--pale': PALE,
}

const NOT_ON_THE_PAGE: Array<{ selector: string; why: string }> = [
  {
    selector: 'button',
    why: 'a filled button paints its own --pale background; measured in buy-contrast.test.ts',
  },
]

function emberText(): Rgb {
  const m = /--ember-text:\s*color-mix\(in srgb,\s*var\(--ember\)\s*(\d+)%,\s*var\(--pale\)\)/.exec(CSS)
  if (!m) throw new Error('could not resolve --ember-text from globals.css')
  return mix(hexToRgb(EMBER), hexToRgb(PALE), 1 - Number(m[1]) / 100)
}

type Declaration = { selector: string; value: string; token: string; alpha: number }

function declarations(): Declaration[] {
  const out: Declaration[] = []
  for (const block of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (block[1] ?? '').trim().replace(/\s+/g, ' ')
    const body = block[2] ?? ''
    for (const decl of body.matchAll(/(?:^|[\s;{])color:\s*([^;]+);/g)) {
      const value = (decl[1] ?? '').trim()
      const plain = /^var\((--[a-z-]+)\)$/.exec(value)
      const mixed = /^color-mix\(in srgb,\s*var\((--[a-z-]+)\)\s*(\d+)%,\s*transparent\)$/.exec(value)
      if (plain) {
        out.push({ selector, value, token: plain[1]!, alpha: 1 })
      } else if (mixed) {
        out.push({ selector, value, token: mixed[1]!, alpha: Number(mixed[2]) / 100 })
      } else {
        throw new Error(
          `globals.css declares \`color: ${value}\` on \`${selector}\`, which this test cannot ` +
            'resolve — so it cannot be measured, and friction #28 is exactly what an ' +
            'unmeasured text colour costs. Teach this parser the new form, or use a token.',
        )
      }
    }
  }
  return out
}

function backdrops(progress: number): Rgb[] {
  return [panelSurface(progress), groundColors(progress)[0]]
}

describe('every text colour in globals.css', () => {
  const all = declarations()

  it('finds them, so a passing run is not an empty one', () => {
    expect(all.length).toBeGreaterThanOrEqual(10)
  })

  it('resolves every one to a palette token', () => {
    for (const d of all) {
      const known = d.token === '--ember-text' || TOKENS[d.token] !== undefined
      expect(known, `${d.selector} → ${d.value}`).toBe(true)
    }
  })

  it('clears 4.5:1 on both the panel and the ground, at every point in the daily cycle', () => {
    const exempt = new Set(NOT_ON_THE_PAGE.map((e) => e.selector))
    const failures: string[] = []

    for (const d of all) {
      if (exempt.has(d.selector)) continue
      const source = d.token === '--ember-text' ? emberText() : hexToRgb(TOKENS[d.token]!)
      const worst = worstOverCycle((progress) =>
        Math.min(
          ...backdrops(progress).map((backdrop) =>
            contrastRatio(over(source, backdrop, d.alpha), backdrop),
          ),
        ),
      )
      if (worst < 4.5) failures.push(`${d.selector} { color: ${d.value} } → ${worst.toFixed(2)}:1`)
    }

    expect(failures).toEqual([])
  })

  it('exempts only what is measured elsewhere, with a reason', () => {
    for (const entry of NOT_ON_THE_PAGE) {
      expect(all.some((d) => d.selector === entry.selector)).toBe(true)
      expect(entry.why.length).toBeGreaterThan(20)
    }
    expect(NOT_ON_THE_PAGE.length).toBeLessThanOrEqual(2)
  })

  it('still has no green, and no --ember used as text', () => {
    expect(CSS).not.toMatch(/\bgreen\b/i)
    expect(CSS).not.toMatch(/(?:^|[\s;{])color:\s*var\(--ember\)\s*;/m)
  })
})

describe('/earn introduces no unmeasured colour', () => {
  it('adds no stylesheet rule naming an earn-specific class', () => {
    expect(CSS).not.toMatch(/\.earn/)
  })

  it('leaves `strong` with no colour of its own, so it inherits a measured one', () => {
    expect(CSS).not.toMatch(/(?:^|[\s,}])strong\s*\{/)
  })
})
