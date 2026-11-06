import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ALL_CSS, SPACE_CSS } from './css'
import { contrastRatio, hexToRgb, over } from '../src/lib/color'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')
}

function classesIn(path: string): string[] {
  const seen = new Set<string>()
  for (const match of source(path).matchAll(/className="([^"{}]+)"/g)) {
    for (const name of (match[1] ?? '').split(/\s+/)) if (name !== '') seen.add(name)
  }
  return [...seen]
}

function hasRule(css: string, className: string): boolean {
  return new RegExp(`\\.${className}(?![\\w-])`).test(css)
}

describe('the wallet controls are styled', () => {
  it('declares a rule for every wallet class the landing nav uses', () => {
    const walletClasses = classesIn('components/VortexLanding.tsx').filter((c) => c.includes('wallet'))

    expect(walletClasses).toContain('vortex-wallet-button')
    for (const className of walletClasses) {
      expect(hasRule(ALL_CSS, className), `${className} has no CSS rule`).toBe(true)
    }
  })

  it('declares a rule for the wallet row on /buy and /earn', () => {
    expect(hasRule(ALL_CSS, 'wallet-row')).toBe(true)
  })

  it('overrides the browser’s default button chrome on the landing nav', () => {
    const rule = SPACE_CSS.match(/\.vortex-wallet-button\s*\{([^}]*)\}/)?.[1] ?? ''

    for (const property of ['font', 'color', 'background', 'border', 'border-radius', 'padding', 'cursor']) {
      expect(rule, `vortex-wallet-button declares no ${property}`).toMatch(
        new RegExp(`(^|;)\\s*${property}(-[a-z]+)?\\s*:`),
      )
    }
  })

  it('stops the nav from flinging the wallet button into the centre', () => {
    expect(SPACE_CSS).toMatch(/\.vortex-nav-end\s*\{[^}]*display:\s*flex/)
    expect(source('components/VortexLanding.tsx')).toContain('vortex-nav-end')
  })

  it('keeps the button’s label readable on the nav’s own background', () => {
    const rule = SPACE_CSS.match(/\.vortex-wallet-button\s*\{([^}]*)\}/)?.[1] ?? ''
    const color = rule.match(/(^|;)\s*color:\s*(#[0-9a-f]{6})/i)?.[2]
    const background = rule.match(/(^|;)\s*background:\s*(#[0-9a-f]{6,8})/i)?.[2]
    expect(color, 'no literal colour to measure').toBeDefined()
    expect(background, 'no literal background to measure').toBeDefined()

    const bar = over(hexToRgb('#03050a'), hexToRgb('#000000'), 1)
    const surface = over(hexToRgb(background!.slice(0, 7)), bar, background!.length > 7 ? parseInt(background!.slice(7, 9), 16) / 255 : 1)

    expect(contrastRatio(hexToRgb(color!), surface)).toBeGreaterThanOrEqual(4.5)
  })
})
