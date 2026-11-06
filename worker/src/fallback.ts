import { ConfigError } from '@dusk/core'

export const FALLBACK_DELAY_ENV = 'DUSK_FALLBACK_DELAY_SEC'

export function fallbackDelayMsFrom(env: Record<string, string | undefined>): number | undefined {
  const raw = env[FALLBACK_DELAY_ENV]?.trim()
  if (!raw) return undefined
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ConfigError(`${FALLBACK_DELAY_ENV} must be a positive whole number of seconds, got "${raw}".`)
  }
  return Number(raw) * 1000
}

export const RESERVE_TOKENS_ENV = 'DUSK_RESERVE_TOKENS'
export const RESERVE_COST_ENV = 'DUSK_RESERVE_COST_WEI'

export function reservePricePer1kFrom(env: Record<string, string | undefined>): bigint | undefined {
  const tokens = env[RESERVE_TOKENS_ENV]?.trim()
  const cost = env[RESERVE_COST_ENV]?.trim()
  if (!tokens && !cost) return undefined
  if (!tokens) throw new ConfigError(`${RESERVE_COST_ENV} is set but ${RESERVE_TOKENS_ENV} is not: say how many tokens that bought.`)
  if (!cost) throw new ConfigError(`${RESERVE_TOKENS_ENV} is set but ${RESERVE_COST_ENV} is not: say what those tokens cost, in wei.`)
  for (const [name, raw] of [[RESERVE_TOKENS_ENV, tokens], [RESERVE_COST_ENV, cost]] as const) {
    if (!/^[1-9]\d*$/.test(raw)) throw new ConfigError(`${name} must be a positive whole number, got "${raw}".`)
  }
  return (BigInt(cost) * 1000n + BigInt(tokens) - 1n) / BigInt(tokens)
}

export function fallbackPrice(delayMs: number | undefined, reservePrice: bigint | undefined): bigint | undefined {
  if (delayMs === undefined) return undefined
  if (reservePrice === undefined) {
    throw new ConfigError(
      `${FALLBACK_DELAY_ENV} is set, so this is Dusk's fallback worker, which sells at cost — set ` +
        `${RESERVE_TOKENS_ENV} and ${RESERVE_COST_ENV} ("bought X tokens for Y wei").`,
    )
  }
  return reservePrice
}
