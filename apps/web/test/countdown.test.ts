import { describe, expect, it } from 'vitest'
import type { ClockConfig } from '@dusk/core'
import { formatCountdown, timeToReset } from '../src/lib/countdown'

describe('formatCountdown', () => {
  it('is fixed-width hours:minutes:seconds', () => {
    expect(formatCountdown(0)).toBe('00:00:00')
    expect(formatCountdown(1_000)).toBe('00:00:01')
    expect(formatCountdown(61_000)).toBe('00:01:01')
    expect(formatCountdown(3_723_000)).toBe('01:02:03')
    expect(formatCountdown(86_399_000)).toBe('23:59:59')
  })

  it('floors rather than rounds, so it never shows a second that has not elapsed', () => {
    expect(formatCountdown(1_999)).toBe('00:00:01')
  })

  it('shows zero rather than a negative, for the instant between the last tick and the reset', () => {
    expect(formatCountdown(-5_000)).toBe('00:00:00')
  })

  it('keeps counting past a day instead of wrapping to zero', () => {
    expect(formatCountdown(90_000_000)).toBe('25:00:00')
  })
})

describe('timeToReset', () => {
  const daily: ClockConfig = { resetAt: 'daily-utc-midnight' }

  it('reads the same clock the worker reads', () => {
    const now = new Date(Date.UTC(2026, 9, 30, 20, 17, 49))
    expect(timeToReset(daily, now)).toEqual({ ms: 13_331_000, label: '03:42:11' })
  })

  it('follows a compressed demo clock', () => {
    const fast: ClockConfig = { resetAt: { everySeconds: 300 } }
    expect(timeToReset(fast, new Date(240_000)).label).toBe('00:01:00')
  })
})
