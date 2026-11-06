import type { ModelInfo, TrustMode } from '@dusk/core'
import { trustTier } from '@dusk/og'

export type ModelGroupTier = TrustMode | 'other'

export interface ModelGroup {
  tier: ModelGroupTier
  label: string
  models: string[]
}

const LABELS: Record<ModelGroupTier, string> = {
  private: 'Private · TeeML',
  verified: 'Verified · TeeTLS',
  standard: 'Standard',
  other: 'Not in 0G’s catalog',
}
const ORDER: ModelGroupTier[] = ['private', 'verified', 'standard', 'other']

export function modelOptionGroups(catalog: readonly ModelInfo[] | null | undefined, extras: readonly string[]): ModelGroup[] {
  const byId = new Map((catalog ?? []).map((m) => [m.id, m]))
  const buckets = new Map<ModelGroupTier, Set<string>>(ORDER.map((t) => [t, new Set<string>()]))
  const add = (id: string) => {
    const info = byId.get(id)
    buckets.get(info ? trustTier(info) : 'other')!.add(id)
  }
  const chat = (catalog ?? []).filter(
    (m) => m.inputModalities.includes('text') && m.outputModalities.length === 1 && m.outputModalities[0] === 'text',
  )
  for (const { id } of chat) add(id)
  for (const raw of extras) {
    const id = raw.trim()
    if (id !== '' && ![...buckets.values()].some((b) => b.has(id))) add(id)
  }
  return ORDER.flatMap((tier) => {
    const models = [...buckets.get(tier)!]
    if (tier !== 'other') models.sort()
    return models.length === 0 ? [] : [{ tier, label: LABELS[tier], models }]
  })
}

/**
 * The trust tier a `/buy` job is posted on.
 *
 * `private` (0G's TeeML tier) when the model runs in a TeeML enclave: that is the only
 * tier a worker can prove what ran on (`@dusk/og/sealed`), so it is the tier that asks for
 * a proof — a proving worker takes it and the escrow's verifier holds it to one. Anything
 * else stays `standard`, which every provider serves and the verifier lets settle
 * normally: asking for a proof there would leave the job unservable and refunded.
 * Image jobs too, since there is no TEE transcript for image output. An unread catalog
 * makes no claim, so the job is `standard` rather than one nobody can serve.
 */
export function jobTrustMode(model: string, catalog: readonly ModelInfo[] | null | undefined, isImage: boolean): TrustMode {
  if (isImage || !catalog) return 'standard'
  const info = catalog.find((m) => m.id === model)
  return info && trustTier(info) === 'private' ? 'private' : 'standard'
}
