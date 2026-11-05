import type { ModelInfo, ModelPricing, TrustMode } from '@dusk/core'

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const neuron = (v: unknown): bigint | undefined =>
  typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : undefined

const usd = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function pricingOf(neuronBlock: unknown, usdBlock: unknown): ModelPricing | undefined {
  const n = (typeof neuronBlock === 'object' && neuronBlock !== null ? neuronBlock : {}) as Record<string, unknown>
  const u = (typeof usdBlock === 'object' && usdBlock !== null ? usdBlock : {}) as Record<string, unknown>
  const fields: ModelPricing = {
    inNeuronPerToken: neuron(n['prompt']),
    outNeuronPerToken: neuron(n['completion']),
    perImageNeuron: neuron(n['image']),
    inUsdPerToken: usd(u['prompt']),
    outUsdPerToken: usd(u['completion']),
    perImageUsd: usd(u['image']),
  }
  const present = Object.entries(fields).filter(([, v]) => v !== undefined)
  return present.length === 0 ? undefined : (Object.fromEntries(present) as ModelPricing)
}

export function parseCatalog(body: unknown): ModelInfo[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const out: ModelInfo[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as {
      id?: unknown
      architecture?: { input_modalities?: unknown; output_modalities?: unknown }
      pricing?: unknown
      pricing_usd?: unknown
      verifiability?: unknown
    }
    if (typeof e.id !== 'string' || e.id === '') continue
    const pricing = pricingOf(e.pricing, e.pricing_usd)
    out.push({
      id: e.id,
      inputModalities: strings(e.architecture?.input_modalities),
      outputModalities: strings(e.architecture?.output_modalities),
      ...(pricing ? { pricing } : {}),
      ...(typeof e.verifiability === 'string' && e.verifiability !== '' ? { verifiability: e.verifiability } : {}),
    })
  }
  return out
}

const answersInText = (m: ModelInfo): boolean => m.outputModalities.length === 1 && m.outputModalities[0] === 'text'

export function imageInputModels(models: readonly ModelInfo[]): string[] {
  return models.filter((m) => answersInText(m) && m.inputModalities.includes('image')).map((m) => m.id)
}

export function textOutputModels(models: readonly ModelInfo[]): string[] {
  return models.filter(answersInText).map((m) => m.id)
}

export function trustTier(m: ModelInfo): TrustMode {
  if (m.verifiability === 'TeeML') return 'private'
  if (m.verifiability === 'TeeTLS') return 'verified'
  return 'standard'
}

export async function fetchCatalog(baseUrl: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const res = await fetch(`${base}/v1/models`, signal ? { signal } : {})
  if (!res.ok) throw new Error(`0G /v1/models answered ${res.status}`)
  return parseCatalog(await res.json())
}
