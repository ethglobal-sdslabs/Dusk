import { describe, expect, it } from 'vitest'
import { hexToRgb, smoothstep, type Rgb } from '../src/lib/color'
import { skyRamp } from '../src/three/sky'
import {
  ATMOSPHERE,
  EMBER,
  HORIZON_Y,
  LASTLIGHT,
  SKY_FRAGMENT_SHADER,
  SKY_TOKENS,
  VIOLET,
  ZENITH,
} from '../src/three/sky.glsl'

const F = String.raw`([0-9]*\.?[0-9]+)`

function constants(pattern: RegExp, label: string): number[] {
  const match = pattern.exec(SKY_FRAGMENT_SHADER)
  if (!match) {
    throw new Error(
      `could not find ${label} in SKY_FRAGMENT_SHADER. The shader's structure changed, so ` +
        `this test is no longer reading the curve it thinks it is — update the pattern and ` +
        `re-check that skyRamp still mirrors it.`,
    )
  }
  return match.slice(1).map(Number)
}

const shader = (() => {
  const [brightnessAmount, brightnessFrom, brightnessTo] = constants(
    new RegExp(String.raw`float brightness = 1\.0 - ${F} \* smoothstep\(${F}, ${F}, d\);`),
    'the brightness curve',
  ) as [number, number, number]
  const [glowNear, glowFar, glowFrom, glowTo] = constants(
    new RegExp(String.raw`float glow = mix\(${F}, ${F}, smoothstep\(${F}, ${F}, d\)\);`),
    'the glow collapse',
  ) as [number, number, number, number]
  const [violetFrom, violetTo] = constants(
    new RegExp(String.raw`float violetAmount = smoothstep\(${F}, ${F}, d\);`),
    'the violet band',
  ) as [number, number]
  const [sliverFrom, sliverTo] = constants(
    new RegExp(String.raw`float sliver = smoothstep\(${F}, ${F}, d\);`),
    'the last-light sliver',
  ) as [number, number]
  const [upperNear, upperFar, upperFrom, upperTo] = constants(
    new RegExp(String.raw`float upper = mix\(${F}, ${F}, smoothstep\(${F}, ${F}, d\)\);`),
    'the upper band',
  ) as [number, number, number, number]
  const [groundDeepScale] = constants(
    new RegExp(String.raw`vec3 groundDeep = ZENITH \* ${F};`),
    'the deep ground colour',
  ) as [number]
  const [groundNearScale, groundNearTrace] = constants(
    new RegExp(String.raw`vec3 groundNear = mix\(ZENITH \* ${F}, horizon, ${F}\);`),
    'the near-horizon ground colour',
  ) as [number, number]
  const [horizon] = constants(new RegExp(String.raw`const float HORIZON = ${F};`), 'the horizon height') as [number]
  const [groundCurveFrom, groundCurveTo] = constants(
    new RegExp(String.raw`mix\(groundDeep, groundNear, smoothstep\(${F}, ${F}, g\)\)`),
    "the ground's own curve",
  ) as [number, number]
  const [glowSplit] = constants(new RegExp(String.raw`if \(s < glow \* ${F}\)`), 'the ember split') as [number]
  const [glowRest] = constants(
    new RegExp(String.raw`\(s - glow \* [0-9.]+\) / max\(glow \* ${F},`),
    'the remainder of the glow band',
  ) as [number]

  return {
    brightnessAmount,
    brightnessFrom,
    brightnessTo,
    glowNear,
    glowFar,
    glowFrom,
    glowTo,
    violetFrom,
    violetTo,
    sliverFrom,
    sliverTo,
    upperNear,
    upperFar,
    upperFrom,
    upperTo,
    groundDeepScale,
    groundNearScale,
    groundNearTrace,
    horizon,
    groundCurveFrom,
    groundCurveTo,
    glowSplit,
    glowRest,
  }
})()

const zenith = hexToRgb(ZENITH)
const atmosphere = hexToRgb(ATMOSPHERE)
const violet = hexToRgb(VIOLET)
const ember = hexToRgb(EMBER)
const lastlight = hexToRgb(LASTLIGHT)

function glslMix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function scale(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k]
}

function shaderColorAt(progress: number, y: number): Rgb {
  const s = shader
  const d = Math.min(1, Math.max(0, progress))

  const brightness = 1 - s.brightnessAmount * smoothstep(s.brightnessFrom, s.brightnessTo, d)
  const glow = s.glowNear + (s.glowFar - s.glowNear) * smoothstep(s.glowFrom, s.glowTo, d)
  const violetAmount = smoothstep(s.violetFrom, s.violetTo, d)
  const sliver = smoothstep(s.sliverFrom, s.sliverTo, d)

  const horizon = glslMix(ember, lastlight, sliver)
  const band = glslMix(atmosphere, violet, violetAmount)
  const upper = s.upperNear + (s.upperFar - s.upperNear) * smoothstep(s.upperFrom, s.upperTo, d)

  const groundDeep = scale(zenith, s.groundDeepScale)
  const groundNear = glslMix(scale(zenith, s.groundNearScale), horizon, s.groundNearTrace)

  const yy = Math.min(1, Math.max(0, y))
  let colour: Rgb
  if (yy < s.horizon) {
    const g = yy / s.horizon
    colour = glslMix(groundDeep, groundNear, smoothstep(s.groundCurveFrom, s.groundCurveTo, g))
  } else {
    const t = (yy - s.horizon) / (1 - s.horizon)
    if (t < glow * s.glowSplit) {
      colour = glslMix(horizon, ember, t / Math.max(glow * s.glowSplit, 0.0001))
    } else if (t < glow) {
      colour = glslMix(ember, band, (t - glow * s.glowSplit) / Math.max(glow * s.glowRest, 0.0001))
    } else if (t < upper) {
      colour = glslMix(band, atmosphere, (t - glow) / Math.max(upper - glow, 0.0001))
    } else {
      colour = glslMix(atmosphere, zenith, (t - upper) / Math.max(1 - upper, 0.0001))
    }
  }

  return scale(colour, brightness)
}

function cssColorAt(progress: number, y: number): Rgb {
  const stops = skyRamp(progress)
  let i = 0
  for (let k = 0; k < stops.length; k++) if (stops[k]!.at <= y) i = k
  const lo = stops[i]!
  const hi = stops[Math.min(i + 1, stops.length - 1)]!
  const span = hi.at - lo.at
  const t = span > 0 ? (y - lo.at) / span : 0
  return glslMix(lo.color, hi.color, t)
}

const PROGRESSES = [0, 0.1, 0.25, 0.3, 0.45, 0.55, 0.7, 0.85, 0.95, 0.98, 1]

const HEIGHTS = [
  0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, HORIZON_Y - 0.001, HORIZON_Y, HORIZON_Y + 0.001, 0.5, 0.55, 0.6, 0.65,
  0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1,
]

function worstDeviation(filter: (y: number) => boolean): { max: number; at: string } {
  let max = 0
  let at = 'nowhere'
  for (const progress of PROGRESSES) {
    for (const y of HEIGHTS) {
      if (!filter(y)) continue
      const a = shaderColorAt(progress, y)
      const b = cssColorAt(progress, y)
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(a[c]! - b[c]!)
        if (delta > max) {
          max = delta
          at = `progress ${progress}, y ${y}, channel ${'rgb'[c]} (shader ${a[c]!.toFixed(2)} vs css ${b[c]!.toFixed(2)})`
        }
      }
    }
  }
  return { max, at }
}

describe('the TypeScript ramp and the GLSL ramp', () => {
  it('shares the six colour tokens, as the generated `const vec3` declarations', () => {
    for (const [name, hex] of Object.entries(SKY_TOKENS)) {
      const [r, g, b] = hexToRgb(hex)
      const declaration = new RegExp(String.raw`const vec3 ${name} = vec3\(${F}, ${F}, ${F}\);`).exec(
        SKY_FRAGMENT_SHADER,
      )
      expect(declaration, `${name} is not declared in the shader`).not.toBeNull()
      const channels = declaration!.slice(1).map(Number).map((v) => v * 255)
      expect(channels[0]).toBeCloseTo(r, 1)
      expect(channels[1]).toBeCloseTo(g, 1)
      expect(channels[2]).toBeCloseTo(b, 1)
    }
  })

  it('puts the horizon at the same height', () => {
    expect(shader.horizon).toBeCloseTo(HORIZON_Y, 5)
  })

  it('agrees above the horizon, where both are piecewise-linear over the same four stops', () => {
    const { max, at } = worstDeviation((y) => y >= HORIZON_Y)
    expect(max, `worst above-horizon deviation at ${at}`).toBeLessThan(1)
  })

  it('agrees below the horizon within the known cost of approximating a smoothstep', () => {
    const { max, at } = worstDeviation((y) => y < HORIZON_Y)
    expect(max, `worst below-horizon deviation at ${at}`).toBeLessThan(4)
  })

  it('never disagrees about which half of the page it is painting', () => {
    for (const progress of PROGRESSES) {
      const groundShader = shaderColorAt(progress, 0.1)
      const groundCss = cssColorAt(progress, 0.1)
      const glowShader = shaderColorAt(progress, HORIZON_Y + 0.01)
      const glowCss = cssColorAt(progress, HORIZON_Y + 0.01)
      const sum = (c: Rgb) => c[0] + c[1] + c[2]
      expect(sum(groundShader)).toBeLessThan(sum(glowShader))
      expect(sum(groundCss)).toBeLessThan(sum(glowCss))
    }
  })
})
