import { msUntilCreditReset, nextCreditReset, type ClockConfig } from '@dusk/core'

export function formatCountdown(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export type TimeToReset = { ms: number; label: string }

export function timeToReset(clock: ClockConfig, now: Date): TimeToReset {
  const ms = msUntilCreditReset(clock, now)
  return { ms, label: formatCountdown(ms) }
}

export function resetAt(clock: ClockConfig, now: Date): Date {
  return nextCreditReset(clock, now)
}
