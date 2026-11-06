
export const ZENITH = '#020307'
export const ATMOSPHERE = '#080b12'
export const VIOLET = '#12131c'
export const EMBER = '#364153'
export const LASTLIGHT = '#C9D7EF'
export const PALE = '#D8DCE8'

export const SKY_TOKENS = {
  ZENITH,
  ATMOSPHERE,
  VIOLET,
  EMBER,
  LASTLIGHT,
} as const

export type SkyTokenName = keyof typeof SKY_TOKENS

function glslVec3(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  return `vec3(${channels.map((c) => (c / 255).toFixed(5)).join(', ')})`
}

export const SKY_GLSL_TOKENS: string = Object.entries(SKY_TOKENS)
  .map(([name, hex]) => `const vec3 ${name} = ${glslVec3(hex)};  // ${hex}`)
  .join('\n')

export const HORIZON_Y = 0.44

export const GLOW_MAX_FRACTION = 0.42

export const SKY_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const SKY_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUv;
uniform float uProgress;

${SKY_GLSL_TOKENS}

const float HORIZON = ${HORIZON_Y.toFixed(5)};

void main() {
  float d = clamp(uProgress, 0.0, 1.0);

  float brightness = 1.0 - 0.90 * smoothstep(0.30, 1.0, d);
  float glow = mix(${GLOW_MAX_FRACTION.toFixed(2)}, 0.07, smoothstep(0.25, 1.0, d));
  float violetAmount = smoothstep(0.55, 0.98, d);
  float sliver = smoothstep(0.45, 1.0, d);

  vec3 horizon = mix(EMBER, LASTLIGHT, sliver);
  vec3 band = mix(ATMOSPHERE, VIOLET, violetAmount);
  float upper = mix(0.62, 0.50, smoothstep(0.25, 1.0, d));

  vec3 groundDeep = ZENITH * 0.45;
  vec3 groundNear = mix(ZENITH * 0.70, horizon, 1.0);

  float y = clamp(vUv.y, 0.0, 1.0);
  vec3 colour;
  if (y < HORIZON) {
    float g = y / HORIZON;
    colour = mix(groundDeep, groundNear, smoothstep(0.55, 1.0, g));
  } else {
    float s = (y - HORIZON) / (1.0 - HORIZON);
    if (s < glow * 0.45) {
      colour = mix(horizon, EMBER, s / max(glow * 0.45, 0.0001));
    } else if (s < glow) {
      colour = mix(EMBER, band, (s - glow * 0.45) / max(glow * 0.55, 0.0001));
    } else if (s < upper) {
      colour = mix(band, ATMOSPHERE, (s - glow) / max(upper - glow, 0.0001));
    } else {
      colour = mix(ATMOSPHERE, ZENITH, (s - upper) / max(1.0 - upper, 0.0001));
    }
  }

  gl_FragColor = vec4(colour * brightness, 1.0);
}
`
