import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOgClient, OG_KEY_SHAPED, OgHttpError, redactKeyish } from '../src/index'

const FAKE_KEY = 'sk-abc123DEF_456'

function stubFetch(init: { status: number; statusText?: string; body?: unknown }): void {
  vi.stubGlobal('fetch', async () => ({
    ok: false,
    status: init.status,
    statusText: init.statusText ?? '',
    json: async () => {
      if (init.body === undefined) throw new SyntaxError('not json')
      return init.body
    },
  }))
}

function ogClient() {
  return createOgClient({ baseUrl: 'https://router.example/v1', inferKey: FAKE_KEY })
}

const COMPLETION = {
  model: 'test-model',
  maxTokens: 8,
  messages: [{ role: 'user' as const, content: 'hi' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('redactKeyish', () => {
  it('removes a key quoted inside a Router auth message', () => {
    const msg = `Incorrect API key provided: ${FAKE_KEY}. You can find your API key at …`
    expect(redactKeyish(msg)).not.toMatch(OG_KEY_SHAPED)
    expect(redactKeyish(msg)).toContain('You can find your API key at')
  })

  it('removes a key followed by punctuation, quotes, or end of string', () => {
    for (const msg of [`key "sk-abc123".`, `(mk-abc123)`, `key: sk-abc123`, `sk-abc123`]) {
      expect(redactKeyish(msg)).not.toMatch(OG_KEY_SHAPED)
    }
  })

  it('leaves words that merely end in the prefix alone', () => {
    expect(redactKeyish('risk-free and mask-off')).toBe('risk-free and mask-off')
  })

  it('replaces with something that is not itself key-shaped', () => {
    expect(redactKeyish(FAKE_KEY)).not.toMatch(OG_KEY_SHAPED)
    expect(redactKeyish(FAKE_KEY)).not.toMatch(/\b(sk|mk)-/)
  })

  it('redacts a shouted prefix too', () => {
    expect(redactKeyish('SK-ABC123')).not.toMatch(/\b(sk|mk)-/i)
  })
})

describe('OgHttpError', () => {
  it('does not carry the key the Router quoted back at us', async () => {
    stubFetch({
      status: 401,
      body: {
        error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${FAKE_KEY}.` },
        request_id: 'req_1',
      },
    })
    const error = await ogClient()
      .complete(COMPLETION, 'verified')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(OgHttpError)
    expect((error as Error).message).not.toMatch(/\b(sk|mk)-/)
    expect((error as Error).message).toContain('invalid_api_key')
    expect((error as OgHttpError).status).toBe(401)
  })

  it('does not carry a key the Router put in the error code', async () => {
    stubFetch({ status: 401, body: { error: { code: `invalid key ${FAKE_KEY}`, message: 'nope' } } })
    const error = await ogClient()
      .complete(COMPLETION, 'verified')
      .catch((e: unknown) => e)

    expect((error as Error).message).not.toMatch(/\b(sk|mk)-/)
  })

  it('still produces a usable message when the error body is not JSON', async () => {
    stubFetch({ status: 502, statusText: `${FAKE_KEY} upstream died` })
    const error = await ogClient()
      .complete(COMPLETION, 'verified')
      .catch((e: unknown) => e)

    expect((error as Error).message).not.toMatch(/\b(sk|mk)-/)
    expect((error as OgHttpError).status).toBe(502)
  })

  it('does not carry a key a proxy echoed into request_id', async () => {
    stubFetch({
      status: 400,
      body: { error: { code: 'bad_request', message: 'nope' }, request_id: `req_${FAKE_KEY}` },
    })
    const error = await ogClient()
      .complete(COMPLETION, 'verified')
      .catch((e: unknown) => e)

    expect((error as Error).message).not.toMatch(/\b(sk|mk)-/)
  })

  it('scrubs the models() path as well, which takes no key but shares readError', async () => {
    stubFetch({ status: 500, body: { error: { message: `boom ${FAKE_KEY}` } } })
    const error = await ogClient()
      .models()
      .catch((e: unknown) => e)

    expect((error as Error).message).not.toMatch(/\b(sk|mk)-/)
  })
})
