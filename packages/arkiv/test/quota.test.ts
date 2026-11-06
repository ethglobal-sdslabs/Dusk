import { describe, expect, it } from 'vitest'
import { ArkivQuotaError, asQuotaError, parseQuotaHeaders } from '../src/quota'

function httpError(status: number, body: string, headers: Record<string, string> = {}): Error {
  const error = new Error(`HTTP request failed.\n\nStatus: ${status}\nDetails: ${body}`)
  Object.assign(error, { name: 'HttpRequestError', status, headers: new Headers(headers) })
  return error
}

describe('asQuotaError', () => {
  it('recognises a 429 from the index', () => {
    const quota = asQuotaError(httpError(429, '{"error":"ANON_COST_LIMITED"}'))
    expect(quota).toBeInstanceOf(ArkivQuotaError)
  })

  it('carries the wait the server asked for, in seconds', () => {
    const quota = asQuotaError(httpError(429, 'nope', { 'retry-after': '1740' }))
    expect(quota?.retryAfterSec).toBe(1740)
  })

  it('has no wait when the server named none, rather than inventing one', () => {
    expect(asQuotaError(httpError(429, 'nope'))?.retryAfterSec).toBeUndefined()
  })

  it('ignores a Retry-After that is an HTTP date rather than a count of seconds', () => {
    expect(asQuotaError(httpError(429, 'nope', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))?.retryAfterSec)
      .toBeUndefined()
  })

  it('recognises the refusal by its body even when no status survived the wrapping', () => {
    const wrapped = new Error('query failed: ANON_COST_LIMITED — unauthenticated query budget exhausted')
    expect(asQuotaError(wrapped)).toBeInstanceOf(ArkivQuotaError)
  })

  it('is not a quota error for an ordinary dropped connection', () => {
    expect(asQuotaError(new Error('fetch failed'))).toBeUndefined()
  })

  it('is not a quota error for a revert', () => {
    expect(asQuotaError(new Error('execution reverted: NotOwner'))).toBeUndefined()
  })

  it('is not a quota error for a 500', () => {
    expect(asQuotaError(httpError(500, 'upstream exploded'))).toBeUndefined()
  })

  it('passes an ArkivQuotaError straight through rather than re-wrapping it', () => {
    const original = new ArkivQuotaError(60)
    expect(asQuotaError(original)).toBe(original)
  })

  it('says what happened and what to do, without apologising', () => {
    const quota = new ArkivQuotaError(1740)
    expect(quota.message).toMatch(/budget/i)
    expect(quota.message).toMatch(/29 minutes/)
    expect(quota.message).not.toMatch(/sorry|apolog/i)
  })

  it('still says something useful with no wait to report', () => {
    expect(new ArkivQuotaError().message).toMatch(/budget/i)
  })
})

describe('parseQuotaHeaders', () => {
  const headers = (h: Record<string, string>): Headers => new Headers(h)

  it('reads the used-percent the index volunteers on a keyed request', () => {
    expect(parseQuotaHeaders(headers({ 'arkiv-quota-used-percent': '0' }))).toEqual({ usedPercent: 0 })
  })

  it('reads limit, remaining and reset out of the one ratelimit header', () => {
    expect(parseQuotaHeaders(headers({ ratelimit: 'limit=9999, remaining=9998, reset=1' }))).toEqual({
      limit: 9999,
      remaining: 9998,
      resetSec: 1,
    })
  })

  it('reads both together, which is what a keyed response actually looks like', () => {
    expect(
      parseQuotaHeaders(
        headers({ 'arkiv-quota-used-percent': '37', ratelimit: 'limit=9999, remaining=6300, reset=42' }),
      ),
    ).toEqual({ usedPercent: 37, limit: 9999, remaining: 6300, resetSec: 42 })
  })

  it('says nothing at all when the response carries neither, rather than reporting zeros', () => {
    expect(parseQuotaHeaders(headers({}))).toBeUndefined()
    expect(parseQuotaHeaders(headers({ 'content-type': 'application/json' }))).toBeUndefined()
  })

  it('ignores a malformed field instead of reporting NaN', () => {
    expect(parseQuotaHeaders(headers({ 'arkiv-quota-used-percent': 'lots' }))).toBeUndefined()
    expect(parseQuotaHeaders(headers({ ratelimit: 'limit=lots, remaining=9998' }))).toEqual({ remaining: 9998 })
  })

  it('tolerates the fields in any order and without spaces', () => {
    expect(parseQuotaHeaders(headers({ ratelimit: 'reset=60,limit=600,remaining=599' }))).toEqual({
      limit: 600,
      remaining: 599,
      resetSec: 60,
    })
  })
})

describe('the message a refusal carries', () => {
  it('does not claim the reader was unauthenticated, because since B4 it usually is not', () => {
    const message = new ArkivQuotaError(60).message
    expect(message).not.toMatch(/unauthenticated|no API key|without a key/i)
    expect(message).toMatch(/budget/i)
    expect(message).toMatch(/hub\.arkiv\.network/)
  })
})
