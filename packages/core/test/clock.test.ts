import { describe, expect, it } from 'vitest'
import { creditDayStart, msUntilCreditReset, nextCreditReset } from '../src/clock'

describe('nextCreditReset', () => {
  it('returns the next UTC midnight', () => {
    expect(
      nextCreditReset({ resetAt: 'daily-utc-midnight' }, new Date('2026-10-29T13:45:00Z')),
    ).toEqual(new Date('2026-10-30T00:00:00Z'))
  })
  it('returns the following midnight when already exactly at midnight', () => {
    expect(
      nextCreditReset({ resetAt: 'daily-utc-midnight' }, new Date('2026-10-29T00:00:00Z')),
    ).toEqual(new Date('2026-10-30T00:00:00Z'))
  })
  it('honours a fast demo clock', () => {
    expect(
      nextCreditReset({ resetAt: { everySeconds: 300 } }, new Date('2026-10-29T13:45:10Z')),
    ).toEqual(new Date('2026-10-29T13:50:00Z'))
  })
})

describe('msUntilCreditReset', () => {
  it('is always positive', () => {
    expect(
      msUntilCreditReset({ resetAt: 'daily-utc-midnight' }, new Date('2026-10-29T23:59:59Z')),
    ).toBe(1000)
  })
})

describe('creditDayStart', () => {
  it('is the UTC midnight this credit day began at', () => {
    expect(
      creditDayStart({ resetAt: 'daily-utc-midnight' }, new Date('2026-10-29T13:45:00Z')),
    ).toEqual(new Date('2026-10-29T00:00:00Z'))
  })
  it('is the instant itself when sitting exactly on a reset, since that day has begun', () => {
    expect(
      creditDayStart({ resetAt: 'daily-utc-midnight' }, new Date('2026-10-29T00:00:00Z')),
    ).toEqual(new Date('2026-10-29T00:00:00Z'))
  })
  it('honours a fast demo clock', () => {
    expect(
      creditDayStart({ resetAt: { everySeconds: 300 } }, new Date('2026-10-29T13:45:10Z')),
    ).toEqual(new Date('2026-10-29T13:45:00Z'))
  })
})
