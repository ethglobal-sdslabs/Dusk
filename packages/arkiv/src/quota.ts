export type ArkivQuota = {
  usedPercent?: number
  limit?: number
  remaining?: number
  resetSec?: number
}

function numberOf(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export function parseQuotaHeaders(headers: Headers): ArkivQuota | undefined {
  const usedPercent = numberOf(headers.get('arkiv-quota-used-percent'))
  const rateLimit = headers.get('ratelimit') ?? ''
  const field = (name: string): number | undefined =>
    numberOf(new RegExp(`\\b${name}\\s*=\\s*([^,\\s]+)`).exec(rateLimit)?.[1])

  const quota: ArkivQuota = {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(field('limit') !== undefined ? { limit: field('limit') } : {}),
    ...(field('remaining') !== undefined ? { remaining: field('remaining') } : {}),
    ...(field('reset') !== undefined ? { resetSec: field('reset') } : {}),
  }
  return Object.keys(quota).length === 0 ? undefined : quota
}

function retryAfterOf(error: unknown): number | undefined {
  const headers = (error as { headers?: Headers }).headers
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : undefined
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

export class ArkivQuotaError extends Error {
  override readonly name = 'ArkivQuotaError'
  readonly retryAfterSec: number | undefined

  constructor(retryAfterSec?: number) {
    super(
      'Arkiv refused the query: its read budget is used up' +
        (retryAfterSec === undefined ? '.' : ` and resets in about ${humanWait(retryAfterSec)}.`) +
        ' A hub key from https://hub.arkiv.network raises the ceiling (measured: 600 per' +
        ' 60s anonymous, 9999 per 1s keyed).',
    )
    this.retryAfterSec = retryAfterSec
  }
}

export function humanWait(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} seconds`
  return `${Math.round(seconds / 60)} minutes`
}

export function asQuotaError(error: unknown): ArkivQuotaError | undefined {
  if (error instanceof ArkivQuotaError) return error

  const status = (error as { status?: number }).status
  const message = error instanceof Error ? error.message : String(error)
  const refused = status === 429 || /\b429\b|ANON_COST_LIMITED|query budget exhausted/i.test(message)
  if (!refused) return undefined

  return new ArkivQuotaError(retryAfterOf(error))
}
