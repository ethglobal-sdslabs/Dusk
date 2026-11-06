import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { resolvePayout } from '../src/payout'

const SIGNER: Address = `0x${'ee'.repeat(20)}`
const ARKIV: Address = `0x${'11'.repeat(20)}`
const OTHER: Address = `0x${'99'.repeat(20)}`

describe('resolvePayout', () => {
  it('defaults to the escrow signer when escrow is configured', () => {
    expect(resolvePayout({ escrowSigner: SIGNER, arkivAddress: ARKIV })).toBe(SIGNER)
  })

  it('falls back to the Arkiv address in Gate 1 no-money mode', () => {
    expect(resolvePayout({ arkivAddress: ARKIV })).toBe(ARKIV)
  })

  it('refuses to start when DUSK_PAYOUT_ADDRESS differs from the escrow signer', () => {
    expect(() =>
      resolvePayout({ escrowSigner: SIGNER, arkivAddress: ARKIV, configured: OTHER }),
    ).toThrow(/DUSK_PAYOUT_ADDRESS/)
  })

  it('names both addresses in the refusal, so the operator can see which is which', () => {
    const err = (() => {
      try {
        resolvePayout({ escrowSigner: SIGNER, arkivAddress: ARKIV, configured: OTHER })
      } catch (e) {
        return e as Error
      }
    })()!
    expect(err.message).toContain(OTHER)
    expect(err.message).toContain(SIGNER)
  })

  it('accepts a configured address equal to the signer, case-insensitively', () => {
    const upper = SIGNER.toUpperCase().replace('0X', '0x') as Address
    expect(resolvePayout({ escrowSigner: SIGNER, arkivAddress: ARKIV, configured: upper })).toBe(
      SIGNER,
    )
  })

  it('honours DUSK_PAYOUT_ADDRESS when no escrow is configured', () => {
    expect(resolvePayout({ arkivAddress: ARKIV, configured: OTHER })).toBe(OTHER)
  })

  it('refuses a malformed DUSK_PAYOUT_ADDRESS even with no escrow configured', () => {
    expect(() =>
      resolvePayout({ arkivAddress: ARKIV, configured: '0xnot-an-address' as Address }),
    ).toThrow(/DUSK_PAYOUT_ADDRESS/)
  })

  it('refuses a malformed DUSK_PAYOUT_ADDRESS with escrow configured, naming the value', () => {
    const bad = '0xnot-an-address' as Address
    expect(() => resolvePayout({ escrowSigner: SIGNER, arkivAddress: ARKIV, configured: bad })).toThrow(
      /0xnot-an-address/,
    )
  })
})
