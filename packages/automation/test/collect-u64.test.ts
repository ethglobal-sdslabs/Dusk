import { describe, expect, it } from 'vitest'
import { u64Number } from '../src/collect'

describe('u64Number — a u64 Arkiv attribute as the RPC returns it', () => {
  it('reads the hex string Arkiv actually sends (measured live: latency_ms 0x8ca0)', () => {
    expect(u64Number('0x8ca0')).toBe(36_000)
  })
  it('also reads decimal strings and numbers', () => {
    expect(u64Number('36000')).toBe(36_000)
    expect(u64Number(36_000)).toBe(36_000)
  })
  it('refuses anything else rather than guessing', () => {
    for (const v of [undefined, null, '', 'abc', '-1', -1, 1.5, {}]) expect(u64Number(v)).toBeUndefined()
  })
})
