
export type Rgb = readonly [number, number, number]

export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!match) throw new Error(`expected a six-digit hex colour like #1B2240, got ${JSON.stringify(hex)}`)
  const n = Number.parseInt(match[1]!, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function toRgb(colour: string | Rgb): Rgb {
  return typeof colour === 'string' ? hexToRgb(colour) : colour
}

export function rgbToCss(colour: Rgb): string {
  return `rgb(${Math.round(colour[0])}, ${Math.round(colour[1])}, ${Math.round(colour[2])})`
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

export function over(source: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return mix(backdrop, source, alpha)
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function relativeLuminance(colour: string | Rgb): number {
  const [r, g, b] = toRgb(colour)
  const channel = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
