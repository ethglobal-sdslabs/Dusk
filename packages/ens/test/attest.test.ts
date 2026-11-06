import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { coSignRefusal, statusFor, type AdmissionStatus, type VerifiedIdentity } from '../src'

const W = '0x1111111111111111111111111111111111111111' as Address
const C = '0xC0C0000000000000000000000000000000000C0C' as Address
const NOW = 1_800_000_000
const identity = (status: VerifiedIdentity['status'], blockNumber = 1_000n): VerifiedIdentity =>
  ({ wallet: W, chainId: 11155111, registry: C, status, checkedAt: NOW * 1000, blockNumber }) as VerifiedIdentity
const opts = { controller: C, nowSec: NOW, validitySec: 21_600, epoch: 1 }
const mine = (over: Partial<AdmissionStatus> = {}): AdmissionStatus => ({ ...statusFor(identity('active'), opts)!, ...over })

describe('coSignRefusal (audit PE-1)', () => {
  it('co-signs a status matching what this attester reads', () => {
    expect(coSignRefusal(mine({ sourceBlock: 990n }), identity('active'), opts)).toBeNull()
  })
  it('refuses a verdict it does not see, or an unknown read', () => {
    expect(coSignRefusal(mine({ admitted: false }), identity('active'), opts)).toMatch(/admitted/)
    expect(coSignRefusal(mine(), identity('unknown'), opts)).toMatch(/unknown/)
  })
  it('refuses a source block later than the one it read, or far behind it', () => {
    expect(coSignRefusal(mine({ sourceBlock: 2n ** 64n - 1n }), identity('active'), opts)).toMatch(/sourceBlock/)
    expect(coSignRefusal(mine({ sourceBlock: 1_001n }), identity('active'), opts)).toMatch(/sourceBlock/)
    expect(coSignRefusal(mine({ sourceBlock: 1n }), identity('active'), opts)).toMatch(/sourceBlock/)
  })
  it('refuses a validity beyond its own policy, or a foreign chain, controller or epoch', () => {
    expect(coSignRefusal(mine({ validUntil: BigInt(NOW + 21_600 + 3_600) }), identity('active'), opts)).toMatch(/validUntil/)
    expect(coSignRefusal(mine({ sourceChainId: 1n }), identity('active'), opts)).toMatch(/chain|controller|epoch/)
    expect(coSignRefusal(mine({ controller: W }), identity('active'), opts)).toMatch(/chain|controller|epoch/)
    expect(coSignRefusal(mine({ epoch: 2 }), identity('active'), opts)).toMatch(/chain|controller|epoch/)
    expect(coSignRefusal(mine({ wallet: C }), identity('active'), opts)).toMatch(/wallet/)
  })
})
