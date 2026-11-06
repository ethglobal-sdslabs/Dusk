import { describe, expect, it } from 'vitest'
import type { ClockConfig } from '@dusk/core'
import { contrastRatio, hexToRgb, over, relativeLuminance } from '../src/lib/color'
import { HORIZON_Y, LASTLIGHT, PALE } from '../src/three/sky.glsl'
import { groundColors, panelSurface, skyGradientCss, skyProgress, skyRamp } from '../src/three/sky'

const daily: ClockConfig = { resetAt: 'daily-utc-midnight' }
const utc = (h: number, m = 0, s = 0) => new Date(Date.UTC(2026, 9, 30, h, m, s))

const brightest = (progress: number) => Math.max(...skyRamp(progress).map((s) => relativeLuminance(s.color)))

describe('skyProgress', () => {
  it('is 0 at the reset and climbs toward 1 as the credits run out', () => {
    expect(skyProgress(daily, utc(0))).toBe(0)
    expect(skyProgress(daily, utc(12))).toBeCloseTo(0.5, 6)
    expect(skyProgress(daily, utc(23, 59, 59))).toBeGreaterThan(0.999)
    expect(skyProgress(daily, utc(23, 59, 59))).toBeLessThan(1)
  })

  it('follows the configured clock, so a compressed demo day lights the page too', () => {
    const fast: ClockConfig = { resetAt: { everySeconds: 300 } }
    expect(skyProgress(fast, new Date(150_000))).toBeCloseTo(0.5, 6)
    expect(skyProgress(fast, new Date(300_000))).toBe(0)
    expect(skyProgress(fast, new Date(297_000))).toBeCloseTo(0.99, 6)
  })

  it('stays inside [0,1) at every minute of a real day', () => {
    for (let minute = 0; minute < 1440; minute++) {
      const p = skyProgress(daily, new Date(Date.UTC(2026, 9, 30) + minute * 60_000))
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
})

describe('skyRamp', () => {
  it('keeps the space palette dark while retaining a visible horizon', () => {
    expect(brightest(0.5)).toBeGreaterThan(0.005)
    expect(brightest(0.5)).toBeLessThan(0.05)
    expect(brightest(0.993)).toBeLessThan(0.02)
  })

  it('puts the warm line on the horizon, brighter than the ground below and the zenith above', () => {
    for (const progress of [0, 0.3, 0.6, 0.9]) {
      const ramp = skyRamp(progress)
      const warmest = ramp.reduce((a, b) => (b.color[0] > a.color[0] ? b : a))
      expect(warmest.at).toBeCloseTo(HORIZON_Y, 5)
      expect(relativeLuminance(warmest.color)).toBeGreaterThan(relativeLuminance(ramp[0]!.color))
      expect(relativeLuminance(warmest.color)).toBeGreaterThan(relativeLuminance(ramp[ramp.length - 1]!.color))
    }
  })

  it('runs ground-to-zenith with stops in order', () => {
    const ramp = skyRamp(0.3)
    expect(ramp.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!.at).toBeGreaterThanOrEqual(ramp[i - 1]!.at)
    expect(ramp[0]!.at).toBe(0)
    expect(ramp[ramp.length - 1]!.at).toBe(1)
  })

  it('keeps the ground dark enough to read body text against, all day', () => {
    for (let i = 0; i <= 100; i++) {
      for (const ground of groundColors(i / 100)) {
        expect(contrastRatio(PALE, ground)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('skyGradientCss', () => {
  it('is the CSS equivalent of the same ramp, bottom-up', () => {
    const css = skyGradientCss(0.4)
    expect(css.startsWith('linear-gradient(to top,')).toBe(true)
    expect(css.match(/rgb\(/g)?.length).toBe(skyRamp(0.4).length)
  })

  it('moves with the clock, so the no-WebGL page still tells the time', () => {
    expect(skyGradientCss(0.1)).not.toBe(skyGradientCss(0.9))
  })
})

describe('panelSurface', () => {
  it('holds the 4.5:1 floor for body text through the whole cycle', () => {
    for (let i = 0; i <= 100; i++) {
      const surface = panelSurface(i / 100)
      expect(contrastRatio(PALE, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('holds the floor for the amber that means money', () => {
    for (let i = 0; i <= 100; i++) {
      expect(contrastRatio(LASTLIGHT, panelSurface(i / 100))).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('text that is dimmed rather than recoloured', () => {
  const ALPHAS = [1, 0.85, 0.8, 0.78, 0.72]

  it('clears 4.5:1 on a panel at every alpha, through the whole cycle', () => {
    const pale = hexToRgb(PALE)
    for (const alpha of ALPHAS) {
      for (let i = 0; i <= 100; i++) {
        const surface = panelSurface(i / 100)
        const text = over(pale, surface, alpha)
        expect(contrastRatio(text, surface), `--pale at ${alpha} on a panel at progress ${i / 100}`)
          .toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('clears 4.5:1 on the ground at every alpha, through the whole cycle', () => {
    const pale = hexToRgb(PALE)
    for (const alpha of ALPHAS) {
      for (let i = 0; i <= 100; i++) {
        const ground = groundColors(i / 100)[0]
        const text = over(pale, ground, alpha)
        expect(contrastRatio(text, ground), `--pale at ${alpha} on the ground at progress ${i / 100}`)
          .toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
