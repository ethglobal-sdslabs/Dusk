import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOgImageClient } from '../src/image'
import { OgHttpError } from '../src/client'

const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

type Call = { url: string; init: RequestInit }

function stubFetch(status: number, body: string): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

const client = (baseUrl = 'https://router.example') =>
  createOgImageClient({ baseUrl, inferKey: 'sk-test-key-123456' })

afterEach(() => vi.unstubAllGlobals())

describe('createOgImageClient', () => {
  it('submits to /v1/async/images/generations with b64_json and the trust header', async () => {
    const calls = stubFetch(202, fixtureText('image-submit-202.json'))
    const sub = await client().submitImage(
      { model: 'z-image-turbo', prompt: 'a cat', n: 1, size: '1024x1024' },
      'verified',
    )
    expect(sub.jobId).toBe('be0f9f8c-1f2d-45b7-a392-62d68fb1edd0')
    const [call] = calls
    expect(call!.url).toBe('https://router.example/v1/async/images/generations')
    expect(call!.init.method).toBe('POST')
    expect(JSON.parse(String(call!.init.body))).toEqual({
      model: 'z-image-turbo',
      prompt: 'a cat',
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
    })
    const headers = call!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk-test-key-123456')
    expect(headers['X-0G-Provider-Trust-Mode']).toBe('verified')
  })

  it('polls /v1/async/jobs/{id} with provider_address', async () => {
    const calls = stubFetch(200, fixtureText('image-poll-completed.json'))
    const poll = await client().pollImage({ jobId: 'job-1', providerAddress: '0xabc' })
    expect(poll.state).toBe('completed')
    expect(calls[0]!.url).toBe('https://router.example/v1/async/jobs/job-1?provider_address=0xabc')
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-test-key-123456',
    )
  })

  it('polls without a query string when no provider is known', async () => {
    const calls = stubFetch(200, fixtureText('image-poll-pending.json'))
    await client().pollImage({ jobId: 'job-1' })
    expect(calls[0]!.url).toBe('https://router.example/v1/async/jobs/job-1')
  })

  it('turns a non-2xx into a scrubbed OgHttpError', async () => {
    stubFetch(
      401,
      JSON.stringify({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-abcdef' } }),
    )
    const err = await client()
      .submitImage({ model: 'z-image-turbo', prompt: 'a cat', n: 1, size: '1024x1024' }, 'verified')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OgHttpError)
    expect((err as Error).message).not.toMatch(/\b(sk|mk)-/)
  })

  it('reads the recorded 404 for an unknown model as an OgHttpError', async () => {
    stubFetch(404, fixtureText('image-error-404.json'))
    const err = await client()
      .submitImage({ model: 'nope', prompt: 'a cat', n: 1, size: '1024x1024' }, 'verified')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OgHttpError)
    expect((err as OgHttpError).status).toBe(404)
    expect((err as OgHttpError).code).toBe('model_not_found')
  })

  it('tolerates a base url with or without /v1', async () => {
    const calls = stubFetch(200, fixtureText('image-poll-pending.json'))
    await client('https://router.example/v1/').pollImage({ jobId: 'j' })
    expect(calls[0]!.url).toBe('https://router.example/v1/async/jobs/j')
  })
})
