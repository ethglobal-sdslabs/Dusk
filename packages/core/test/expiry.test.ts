import { describe, expect, it } from 'vitest'
import { assertBlockAligned, driftRatio, secondsToBlocks, TtlAlignmentError } from '../src/expiry'

describe('assertBlockAligned', () => {
  it('accepts every TTL the design uses', () => {
    for (const s of [120, 90, 300, 604800]) expect(assertBlockAligned(s)).toBe(s)
  })
  it('rejects an odd duration with the offending value in the message', () => {
    expect(() => assertBlockAligned(91)).toThrow(/91/)
  })
  it('rejects zero and negatives', () => {
    expect(() => assertBlockAligned(0)).toThrow(TtlAlignmentError)
    expect(() => assertBlockAligned(-2)).toThrow(TtlAlignmentError)
  })
  it('rejects non-integers', () => {
    expect(() => assertBlockAligned(2.5)).toThrow(TtlAlignmentError)
  })
})

describe('secondsToBlocks', () => {
  it('converts the claim TTL to 45 blocks', () => {
    expect(secondsToBlocks(90)).toBe(45n)
  })
})

describe('driftRatio', () => {
  it('is 1 when the chain runs at nominal', () => {
    expect(driftRatio(2, 2)).toBe(1)
  })
  it('exceeds 1 when the chain runs slow, so a lease outlives its intent', () => {
    expect(driftRatio(2, 3)).toBeCloseTo(1.5)
  })
})
