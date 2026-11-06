import type { Address } from 'viem'
import type { EnsMode } from './config'

export type IdentityStatus = 'active' | 'unnamed' | 'expired' | 'revoked' | 'banned' | 'mismatch' | 'unknown'
export type IdentitySnapshot = {
  wallet: Address
  chainId: number
  registry: Address
  status: IdentityStatus
  name?: string
  generation?: bigint
  checkedAt: number
}
export type IdentityAction = 'browse' | 'refund' | 'settle-existing' | 'register' | 'new-job' | 'new-claim' | 'new-grant'

export function admission(args: {
  mode: EnsMode; action: IdentityAction; wallet: Address; chainId: number; registry: Address
  snapshot?: IdentitySnapshot; now: number; maxAgeMs?: number
}): { allowed: boolean; reason?: string } {
  if (['browse', 'refund', 'settle-existing'].includes(args.action) || args.mode === 'off') return { allowed: true }
  const s = args.snapshot
  const valid = s && s.wallet.toLowerCase() === args.wallet.toLowerCase() && s.chainId === args.chainId &&
    s.registry.toLowerCase() === args.registry.toLowerCase() && Number.isFinite(s.checkedAt) &&
    Number.isFinite(args.now) && s.checkedAt <= args.now && args.now - s.checkedAt <= (args.maxAgeMs ?? 15_000)
  if (!valid) return args.mode === 'application-enforced' || args.action === 'register'
    ? { allowed: false, reason: 'Identity status could not be verified. Retry before starting new work.' } : { allowed: true }
  if (s.status === 'banned' || s.status === 'revoked') return { allowed: false, reason: 'This wallet cannot start new work or register another Dusk name.' }
  if (args.action === 'register') return s.status === 'unnamed' || s.status === 'expired'
    ? { allowed: true } : { allowed: false, reason: s.status === 'active' ? 'This wallet already has a name.' : 'Identity must be verified before registration.' }
  if (args.mode === 'application-enforced' && s.status !== 'active') return { allowed: false, reason: 'An active, verified Dusk identity is required for new work.' }
  return { allowed: true }
}
