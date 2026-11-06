import { ConfigError, estimateInputTokens } from '@dusk/core'

export { estimateInputTokens }

export type Spend = {
  at: number
  model: string
  tokens: number
  before?: bigint
}

export type CreditBudget = {
  defaultUnitsPerToken: number
  unitsPerToken: Map<string, number>
  spends: Spend[]
}

export const SETTLED_AFTER_MS = 45_000
export const UNSETTLED_WINDOW_MS = 60_000
export const MARGIN = 0.1

export function newBudget(defaultUnitsPerToken: number): CreditBudget {
  return { defaultUnitsPerToken, unitsPerToken: new Map(), spends: [] }
}

export function unitsPerToken(b: CreditBudget, model: string): number {
  return b.unitsPerToken.get(model) ?? b.defaultUnitsPerToken
}

export function worstCaseUnits(b: CreditBudget, model: string, inputChars: number, maxTokens: number): number {
  return Math.ceil((estimateInputTokens(inputChars) + maxTokens) * unitsPerToken(b, model))
}

export function unsettledUnits(b: CreditBudget, now: number): number {
  let units = 0
  for (const s of b.spends) {
    if (now - s.at < UNSETTLED_WINDOW_MS) units += s.tokens * unitsPerToken(b, s.model)
  }
  return Math.ceil(units)
}

export function canAfford(
  b: CreditBudget,
  balance: bigint,
  model: string,
  inputChars: number,
  maxTokens: number,
  now: number,
): boolean {
  const need = Math.ceil(worstCaseUnits(b, model, inputChars, maxTokens) * (1 + MARGIN))
  return Number(balance) - unsettledUnits(b, now) >= need
}

export function recordSpend(b: CreditBudget, spend: Spend): void {
  b.spends.push(spend)
}

export function learnFromBalance(b: CreditBudget, balance: bigint, now: number): void {
  for (const s of b.spends) {
    if (s.before === undefined || now - s.at < SETTLED_AFTER_MS) continue
    const alone = b.spends.every((o) => o === s || Math.abs(o.at - s.at) >= UNSETTLED_WINDOW_MS)
    const drop = s.before - balance
    if (alone && drop > 0n && s.tokens > 0) {
      const measured = Number(drop) / s.tokens
      const old = b.unitsPerToken.get(s.model)
      b.unitsPerToken.set(s.model, old === undefined ? measured : (old + measured) / 2)
    }
    delete s.before
  }
  b.spends = b.spends.filter((s) => s.before !== undefined || now - s.at < UNSETTLED_WINDOW_MS)
}

export const UNITS_PER_TOKEN_ENV = 'DUSK_UNITS_PER_TOKEN'

export function defaultUnitsPerTokenFrom(env: Record<string, string | undefined>): number {
  const raw = env[UNITS_PER_TOKEN_ENV]?.trim()
  if (!raw) return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${UNITS_PER_TOKEN_ENV} must be a positive number of credit units, got "${raw}".`)
  }
  return n
}
