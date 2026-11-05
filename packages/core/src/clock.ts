export type ClockConfig = {
  resetAt: 'daily-utc-midnight' | { everySeconds: number }
}

const SECONDS_PER_DAY = 86_400

function intervalSeconds(clock: ClockConfig): number {
  const { resetAt } = clock
  if (resetAt === 'daily-utc-midnight') return SECONDS_PER_DAY
  if (!Number.isInteger(resetAt.everySeconds) || resetAt.everySeconds <= 0) {
    throw new Error(
      `clock.resetAt.everySeconds must be a positive whole number of seconds, got ` +
        `${resetAt.everySeconds}`,
    )
  }
  return resetAt.everySeconds
}

export function nextCreditReset(clock: ClockConfig, now: Date): Date {
  const intervalMs = intervalSeconds(clock) * 1000
  const t = now.getTime()
  return new Date(Math.floor(t / intervalMs) * intervalMs + intervalMs)
}

export function msUntilCreditReset(clock: ClockConfig, now: Date): number {
  return nextCreditReset(clock, now).getTime() - now.getTime()
}

export function creditDayStart(clock: ClockConfig, now: Date): Date {
  return new Date(nextCreditReset(clock, now).getTime() - intervalSeconds(clock) * 1000)
}
