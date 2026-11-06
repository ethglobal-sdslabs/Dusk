import { createAdmit, createEnsReader, createIdentityCache, requiredIdentityUnavailable, type IdentityAction, type VerifiedIdentity } from '@dusk/ens'
import { browserEns } from './config'

export type WalletLabel = { text: string; title: string; verified: boolean; note?: string }

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function walletLabel(address: string, identity?: VerifiedIdentity): WalletLabel {
  const plain = { text: short(address), title: address, verified: false }
  if (!identity || identity.wallet.toLowerCase() !== address.toLowerCase() || !identity.name) return plain
  if (identity.status === 'active') return { text: identity.name, title: `${identity.name} · ${address}`, verified: true }
  if (identity.status === 'mismatch') return { ...plain, note: `${identity.name} does not resolve to this wallet.` }
  return plain
}

let cache: ReturnType<typeof createIdentityCache> | null | undefined

export function ensDisplayCache(): ReturnType<typeof createIdentityCache> | null {
  if (cache !== undefined) return cache
  try {
    const config = browserEns()
    cache = config ? createIdentityCache(createEnsReader(config), { ttlMs: 5 * 60_000, maxConcurrent: 4 }) : null
  } catch {
    cache = null
  }
  return cache
}

export function identityFor(address: string): Promise<VerifiedIdentity> | null {
  const c = ensDisplayCache()
  return c ? c.get(address as `0x${string}`) : null
}

export function invalidateWalletIdentity(address: `0x${string}`): void {
  ensDisplayCache()?.forget(address)
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dusk:identity-changed', { detail: address }))
}

export type Admit = (action: IdentityAction, wallet: `0x${string}`) => Promise<{ allowed: boolean; reason?: string }>

export function browserAdmit(env?: Record<string, string | undefined>): Admit | undefined {
  try {
    const config = browserEns(env)
    if (config === null) return undefined
    if (!config.controller) return requiredIdentityUnavailable
    return createAdmit({ ...config, mode: 'application-enforced' }, createEnsReader(config)) ?? requiredIdentityUnavailable
  } catch { return requiredIdentityUnavailable }
}
