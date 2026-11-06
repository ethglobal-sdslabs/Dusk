import { describe, expect, it } from 'vitest'
import { OgHttpError } from '@dusk/og'
import type { Balance, CompletionResult, OgClient, OgImageClient } from '@dusk/core'
import {
  installKeyGuard,
  keySafeOg,
  keySafeOgImage,
  OG_KEY_SHAPED,
  parseOgKey,
  redactKeyish,
  scrubError,
} from '../src/lib/worker-browser'

const LEAKY = 'sk-live-abcdef0123456789'
const LEAKY_MANAGE = 'mk-live-abcdef0123456789'

function routerAuthError(): OgHttpError {
  return new OgHttpError(
    401,
    'invalid_api_key',
    'req_01HZ',
    `Incorrect API key provided: ${LEAKY}. You can find your API key at https://0g.ai/account.`,
  )
}

const REAL_ERRORS: Array<[string, unknown]> = [
  ['a Router 401 echoing the key back', routerAuthError()],
  [
    "packages/og's own balance() refusal, which names both prefixes in prose",
    new Error(
      'balance() needs an mk- manage key with account:read. An sk- key gets ' +
        '403 insufficient_scope, and that error does not explain itself.',
    ),
  ],
  ['a browser CORS failure, which carries no status at all', new TypeError('Failed to fetch')],
  ['a thrown string, because not everything thrown is an Error', `boom while using ${LEAKY}`],
  ['the raw key thrown on its own', LEAKY],
  ['an error whose message is only the key', new Error(LEAKY)],
  ['an error carrying the key in a nested cause', new Error('upstream', { cause: new Error(LEAKY) })],
  ['null, which `String(null)` turns into text', null],
]

describe('redactKeyish', () => {
  it('removes a key and leaves the rest of the sentence readable', () => {
    const out = redactKeyish(`Incorrect API key provided: ${LEAKY}. Check your account.`)
    expect(out).not.toMatch(OG_KEY_SHAPED)
    expect(out).not.toContain('abcdef0123456789')
    expect(out).toContain('Incorrect API key provided')
    expect(out).toContain('Check your account.')
  })

  it('removes a management key too', () => {
    expect(redactKeyish(`using ${LEAKY_MANAGE}`)).not.toMatch(OG_KEY_SHAPED)
  })

  it('removes the bare prefix, which is what our own prose contains', () => {
    const out = redactKeyish('needs an mk- manage key; an sk- key gets 403')
    expect(out).not.toMatch(OG_KEY_SHAPED)
    expect(out).toMatch(/manage key/)
  })

  it('is case-insensitive, so a shouted prefix is not a hole', () => {
    expect(redactKeyish('SK-LIVE-ABCDEF').toLowerCase()).not.toMatch(OG_KEY_SHAPED)
  })

  it('leaves text that merely contains those letters alone', () => {
    for (const safe of ['risk-free', 'mask-off', 'task-based', 'disk-bound']) {
      expect(redactKeyish(safe)).toBe(safe)
    }
  })

  it('cannot produce a new match by substitution', () => {
    expect(redactKeyish(`${LEAKY} ${LEAKY}`)).not.toMatch(OG_KEY_SHAPED)
    expect(redactKeyish(LEAKY)).not.toMatch(OG_KEY_SHAPED)
  })

  it('says a key was removed rather than silently dropping it', () => {
    expect(redactKeyish(LEAKY)).toMatch(/key/i)
  })
})

describe('scrubError', () => {
  it('scrubs every error a real session can throw', () => {
    for (const [why, error] of REAL_ERRORS) {
      const scrubbed = scrubError(error)
      expect(scrubbed.message, why).not.toMatch(OG_KEY_SHAPED)
      expect(String(scrubbed), why).not.toMatch(OG_KEY_SHAPED)
      expect(JSON.stringify(scrubbed, Object.getOwnPropertyNames(scrubbed)), why).not.toMatch(
        OG_KEY_SHAPED,
      )
    }
  })

  it('does not keep the original as `cause`, which console.error would print', () => {
    const scrubbed = scrubError(routerAuthError())
    expect(scrubbed.cause).toBeUndefined()
  })

  it('keeps the error useful: the name, and the status when there was one', () => {
    const scrubbed = scrubError(routerAuthError()) as Error & { status?: number }
    expect(scrubbed.name).toBe('OgHttpError')
    expect(scrubbed.status).toBe(401)
    expect(scrubbed.message).toMatch(/401/)
  })

  it('does not copy an arbitrary property across, in case one holds the key', () => {
    const hostile = Object.assign(new Error('nope'), { accessKey: LEAKY, headers: { authorization: `Bearer ${LEAKY}` } })
    const scrubbed = scrubError(hostile)
    expect(JSON.stringify(scrubbed, Object.getOwnPropertyNames(scrubbed))).not.toMatch(OG_KEY_SHAPED)
    expect(Object.keys(scrubbed)).not.toContain('accessKey')
  })

  it('is idempotent, so scrubbing twice is harmless', () => {
    const once = scrubError(routerAuthError())
    expect(scrubError(once).message).toBe(once.message)
  })
})

describe('keySafeOg', () => {
  function leakyOg(): OgClient {
    return {
      async models(): Promise<string[]> {
        throw routerAuthError()
      },
      async complete(): Promise<CompletionResult> {
        throw routerAuthError()
      },
      async balance(): Promise<Balance> {
        throw new Error('balance() needs an mk- manage key with account:read. An sk- key gets 403.')
      },
    }
  }

  it('lets no method reject with a key-shaped message', async () => {
    const og = keySafeOg(leakyOg())
    for (const call of [
      () => og.models(),
      () => og.complete({ model: 'm', maxTokens: 8, messages: [{ role: 'user', content: 'hi' }] }, 'verified'),
      () => og.balance(),
    ]) {
      await expect(call()).rejects.toSatisfy(
        (e: unknown) => !OG_KEY_SHAPED.test(String((e as Error).message)),
      )
    }
  })

  it('passes a success through untouched, so wrapping costs nothing', async () => {
    const result: CompletionResult = {
      text: 'the answer',
      modelServed: 'm',
      tokensIn: 3,
      tokensOut: 5,
      finishReason: 'stop',
      latencyMs: 10,
    }
    const og = keySafeOg({
      async models() {
        return ['m']
      },
      async complete() {
        return result
      },
      async balance() {
        throw new Error('no manage key')
      },
    })
    expect(await og.models()).toEqual(['m'])
    expect(await og.complete({ model: 'm', maxTokens: 8, messages: [] }, 'verified')).toBe(result)
  })

  it('holds no key of its own, so the wrapper is not a second place one lives', () => {
    const og = keySafeOg(leakyOg())
    expect(JSON.stringify(og)).not.toMatch(OG_KEY_SHAPED)
    expect(Object.keys(og).sort()).toEqual(['balance', 'complete', 'models'])
  })
})

describe('installKeyGuard', () => {
  type Listener = (event: { reason?: unknown; message?: string; error?: unknown; preventDefault: () => void }) => void

  function fakeHost() {
    const listeners = new Map<string, Listener>()
    return {
      addEventListener: (type: string, fn: unknown) => listeners.set(type, fn as Listener),
      removeEventListener: (type: string) => listeners.delete(type),
      fire(type: string, event: Record<string, unknown>): boolean {
        let prevented = false
        listeners.get(type)?.({ ...event, preventDefault: () => (prevented = true) } as never)
        return prevented
      },
      types: () => [...listeners.keys()].sort(),
    }
  }

  it('listens for both the ways a failure reaches the console', () => {
    const host = fakeHost()
    installKeyGuard(host, () => {})
    expect(host.types()).toEqual(['error', 'unhandledrejection'])
  })

  it('reports a leaking rejection scrubbed, and suppresses the browser’s own print', () => {
    const host = fakeHost()
    const reported: string[] = []
    installKeyGuard(host, (m) => reported.push(m))

    const prevented = host.fire('unhandledrejection', {
      reason: new Error(`POST /v1/chat/completions failed for ${LEAKY}`),
    })

    expect(prevented).toBe(true)
    expect(reported).toHaveLength(1)
    expect(reported[0]).not.toMatch(OG_KEY_SHAPED)
  })

  it('does not need to suppress an OgHttpError, because that type no longer leaks', () => {
    expect(routerAuthError().message).not.toMatch(OG_KEY_SHAPED)

    const host = fakeHost()
    const reported: string[] = []
    installKeyGuard(host, (m) => reported.push(m))

    const prevented = host.fire('unhandledrejection', { reason: routerAuthError() })

    expect(prevented).toBe(false)
    expect(reported[0]).toContain('invalid_api_key')
    expect(reported[0]).not.toMatch(OG_KEY_SHAPED)
  })

  it('leaves an ordinary failure printable, because debuggability is not optional', () => {
    const host = fakeHost()
    const reported: string[] = []
    installKeyGuard(host, (m) => reported.push(m))

    const prevented = host.fire('unhandledrejection', { reason: new TypeError('Failed to fetch') })

    expect(prevented).toBe(false)
    expect(reported[0]).toContain('Failed to fetch')
  })

  it('catches a leak in a synchronous error event too', () => {
    const host = fakeHost()
    const reported: string[] = []
    installKeyGuard(host, (m) => reported.push(m))

    expect(host.fire('error', { error: new Error(LEAKY), message: `Uncaught Error: ${LEAKY}` })).toBe(true)
    expect(reported[0]).not.toMatch(OG_KEY_SHAPED)
  })

  it('detaches, so a second mount does not report twice', () => {
    const host = fakeHost()
    const stop = installKeyGuard(host, () => {})
    stop()
    expect(host.types()).toEqual([])
  })
})

describe('parseOgKey', () => {
  it('accepts an inference key and says only what kind it is', () => {
    const parsed = parseOgKey(LEAKY, 'infer')
    expect(parsed).toEqual({ ok: true, kind: 'infer' })
  })

  it('accepts a management key in the management field', () => {
    expect(parseOgKey(LEAKY_MANAGE, 'manage')).toEqual({ ok: true, kind: 'manage' })
  })

  it('returns no key on the parsed result, so there is nothing to render by accident', () => {
    expect(JSON.stringify(parseOgKey(LEAKY, 'infer'))).not.toMatch(OG_KEY_SHAPED)
  })

  it('catches the two keys swapped, which is the mistake that actually happens', () => {
    const wrongWay = parseOgKey(LEAKY_MANAGE, 'infer')
    const otherWay = parseOgKey(LEAKY, 'manage')
    expect(wrongWay.ok).toBe(false)
    expect(otherWay.ok).toBe(false)
  })

  it('catches a signing key pasted into a 0G field', () => {
    expect(parseOgKey(`0x${'11'.repeat(32)}`, 'infer').ok).toBe(false)
  })

  it('asks for the key when the field is empty, without calling it an error', () => {
    const parsed = parseOgKey('   ', 'infer')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toMatch(/paste/i)
  })

  it('never echoes the value it rejected, in any branch', () => {
    const pastes = [
      LEAKY,
      LEAKY_MANAGE,
      'sk-',
      `0x${'11'.repeat(32)}`,
      '11'.repeat(32),
      'not-a-key-at-all',
      'Bearer sk-live-abcdef0123456789',
      '',
      '   ',
      'sk-live-abcdef0123456788',
    ]
    for (const paste of pastes) {
      for (const expected of ['infer', 'manage'] as const) {
        const parsed = parseOgKey(paste, expected)
        if (parsed.ok) continue
        expect(parsed.error, paste).not.toMatch(OG_KEY_SHAPED)
        expect(parsed.error, paste).not.toContain('abcdef')
        expect(parsed.error, paste).not.toContain('1111')
        expect(parsed.error, paste).not.toMatch(/sorry|apolog/i)
      }
    }
  })

  it('still tells the holder what to do, in the interface’s voice', () => {
    const parsed = parseOgKey('not-a-key-at-all', 'infer')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.error).toMatch(/0G/)
  })
})

describe('keySafeOgImage', () => {
  const leakyImage = (): OgImageClient => ({
    submitImage: async () => {
      throw routerAuthError()
    },
    pollImage: async () => {
      throw routerAuthError()
    },
  })

  it('scrubs a key from a rejected submit, and sets no cause', async () => {
    const err = await keySafeOgImage(leakyImage())
      .submitImage({ model: 'z-image-turbo', prompt: 'p', n: 1, size: '1024x1024' }, 'verified')
      .catch((e: unknown) => e)
    expect((err as Error).message).not.toMatch(OG_KEY_SHAPED)
    expect((err as Error).cause).toBeUndefined()
  })

  it('scrubs a key from a rejected poll', async () => {
    const err = await keySafeOgImage(leakyImage())
      .pollImage({ jobId: 'j' })
      .catch((e: unknown) => e)
    expect((err as Error).message).not.toMatch(OG_KEY_SHAPED)
  })
})
