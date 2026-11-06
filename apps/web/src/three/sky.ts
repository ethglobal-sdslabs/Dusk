import { msUntilCreditReset, nextCreditReset, type ClockConfig } from '@dusk/core'
import { contrastRatio, mix, over, rgbToCss, smoothstep, type Rgb } from '../lib/color'
import { hexToRgb } from '../lib/color'
import { ATMOSPHERE, EMBER, GLOW_MAX_FRACTION, HORIZON_Y, LASTLIGHT, PALE, VIOLET, ZENITH } from './sky.glsl'

const zenith = hexToRgb(ZENITH)
const atmosphere = hexToRgb(ATMOSPHERE)
const violet = hexToRgb(VIOLET)
const ember = hexToRgb(EMBER)
const lastlight = hexToRgb(LASTLIGHT)

function intervalMs(clock: ClockConfig, now: Date): number {
  const next = nextCreditReset(clock, now)
  return nextCreditReset(clock, next).getTime() - next.getTime()
}

export function skyProgress(clock: ClockConfig, now: Date): number {
  const interval = intervalMs(clock, now)
  const remaining = msUntilCreditReset(clock, now)
  return Math.min(1, Math.max(0, 1 - remaining / interval))
}

export type SkyStop = { at: number; color: Rgb }

export function skyRamp(progress: number): SkyStop[] {
  const d = Math.min(1, Math.max(0, progress))

  const brightness = 1 - 0.9 * smoothstep(0.3, 1, d)
  const collapse = smoothstep(0.25, 1, d)
  const glow = GLOW_MAX_FRACTION + (0.07 - GLOW_MAX_FRACTION) * collapse
  const upper = 0.62 + (0.5 - 0.62) * collapse
  const violetAmount = smoothstep(0.55, 0.98, d)
  const sliver = smoothstep(0.45, 1, d)

  const horizon = mix(ember, lastlight, sliver)
  const band = mix(atmosphere, violet, violetAmount)
  const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
  const groundDeep = scale(zenith, 0.45)
  const groundNear = mix(scale(zenith, 0.7), horizon, 1.0)

  const dim = (c: Rgb): Rgb => scale(c, brightness)
  const above = (s: number) => HORIZON_Y + s * (1 - HORIZON_Y)

  return [
    { at: 0, color: dim(groundDeep) },
    { at: HORIZON_Y * 0.55, color: dim(groundDeep) },
    { at: HORIZON_Y * 0.7, color: dim(mix(groundDeep, groundNear, smoothstep(0.55, 1, 0.7))) },
    { at: HORIZON_Y * 0.85, color: dim(mix(groundDeep, groundNear, smoothstep(0.55, 1, 0.85))) },
    { at: HORIZON_Y * 0.925, color: dim(mix(groundDeep, groundNear, smoothstep(0.55, 1, 0.925))) },
    { at: HORIZON_Y, color: dim(groundNear) },
    { at: above(0), color: dim(horizon) },
    { at: above(glow * 0.45), color: dim(ember) },
    { at: above(glow), color: dim(band) },
    { at: above(upper), color: dim(atmosphere) },
    { at: 1, color: dim(zenith) },
  ]
}

export function groundColors(progress: number): [Rgb, Rgb] {
  const ramp = skyRamp(progress)
  return [ramp[0]!.color, ramp.find((stop) => stop.at === HORIZON_Y)!.color]
}

export function skyGradientCss(progress: number): string {
  const stops = skyRamp(progress)
    .map((stop) => `${rgbToCss(stop.color)} ${(stop.at * 100).toFixed(2)}%`)
    .join(', ')
  return `linear-gradient(to top, ${stops})`
}

const PANEL_MIN_OPACITY = 0.72
const PANEL_MAX_OPACITY = 0.97
const PANEL_CONTRAST_TARGET = 4.6

export function panelSurface(progress: number): Rgb {
  const backdrop = skyRamp(progress).reduce<Rgb>(
    (brightest, stop) => (luminanceOrder(stop.color) > luminanceOrder(brightest) ? stop.color : brightest),
    [0, 0, 0],
  )

  for (let opacity = PANEL_MIN_OPACITY; opacity <= PANEL_MAX_OPACITY; opacity += 0.01) {
    const surface = over(atmosphere, backdrop, opacity)
    if (
      contrastRatio(PALE, surface) >= PANEL_CONTRAST_TARGET &&
      contrastRatio(LASTLIGHT, surface) >= PANEL_CONTRAST_TARGET
    ) {
      return surface
    }
  }
  return atmosphere
}

export function panelSurfaceCss(progress: number): string {
  return rgbToCss(panelSurface(progress))
}

function luminanceOrder(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
