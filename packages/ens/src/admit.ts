import type { Address } from 'viem'
import { loadEnsConfig, type EnsConfig } from './config'
import { admission, type IdentityAction } from './policy'
import type { VerifiedIdentity } from './read'

export function createAdmit(
  config: EnsConfig,
  reader: { identityOf(wallet: Address): Promise<VerifiedIdentity> },
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ((action: IdentityAction, wallet: Address) => Promise<AdmitVerdict>) | null {
  if (config.mode === 'off' || !config.registry) return null
  const registry = config.registry
  const remembered = new Map<string, { at: number; ttl: number; verdict: AdmitVerdict }>()
  return async (action, wallet) => {
    const key = `${action}:${wallet.toLowerCase()}`
    const hit = remembered.get(key)
    if (hit && now() >= hit.at && now() - hit.at < hit.ttl) return hit.verdict
    let snapshot = await reader.identityOf(wallet)
    for (let attempt = 1; snapshot.status === 'unknown' && attempt < UNKNOWN_READ_ATTEMPTS; attempt++) {
      await sleep(UNKNOWN_RETRY_MS * attempt)
      snapshot = await reader.identityOf(wallet)
    }
    const checkedNow = now()
    const decided = admission({ mode: config.mode, action, wallet, chainId: config.chainId, registry, snapshot, now: checkedNow })
    const verdict: AdmitVerdict = !decided.allowed && snapshot.status === 'unknown' ? { ...decided, retryable: true } : decided
    const remaining = Number.isFinite(snapshot.checkedAt) && snapshot.checkedAt <= checkedNow ? Math.max(0, snapshot.checkedAt + REMEMBER_MS - checkedNow) : 0
    remembered.set(key, { at: checkedNow, verdict, ttl: Math.min(remaining, snapshot.status === 'unknown' ? UNKNOWN_REMEMBER_MS : REMEMBER_MS) })
    return verdict
  }
}

export type AdmitVerdict = { allowed: boolean; reason?: string; retryable?: true }

const REMEMBER_MS = 15_000
const UNKNOWN_READ_ATTEMPTS = 3
const UNKNOWN_RETRY_MS = 1_500
const UNKNOWN_REMEMBER_MS = 5_000

export function admitFromEnv(
  env: Record<string, string | undefined>,
  makeReader: (config: EnsConfig) => { identityOf(wallet: Address): Promise<VerifiedIdentity> },
): ((action: IdentityAction, wallet: Address) => Promise<AdmitVerdict>) | undefined {
  const mode = env.ENS_MODE?.trim()
  if (!mode || mode === 'off') return undefined
  try {
    const config = loadEnsConfig(env)
    if (!config.controller || !config.registry || !config.universalResolver) return requiredIdentityUnavailable
    return createAdmit({ ...config, mode: 'application-enforced' }, makeReader(config)) ?? requiredIdentityUnavailable
  } catch { return requiredIdentityUnavailable }
}

export async function requiredIdentityUnavailable(action: IdentityAction, _wallet: Address) {
  return ['browse', 'refund', 'settle-existing'].includes(action) ? { allowed: true } :
    { allowed: false, reason: 'A verified Dusk name is required for this wallet. Name registration or verification is currently unavailable.' }
}
