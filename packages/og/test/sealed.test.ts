import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { recoverMessageAddress, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  aadOf,
  b64url,
  hpkeSetupReceiver,
  hpkeSetupSender,
  jcs,
  signedTextE2EE,
  verifyTranscript,
  x25519Public,
} from '../src/e2ee'
import { createSealedOgClient, routeByTrust, type ServiceRecord } from '../src/sealed'

const ROUTER = 'https://router.test'
const PROVIDER_URL = 'https://provider.test'
const PROVIDER: Address = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
const JOB_MODEL = '0gm-1.0-35b-a3b'
const PROVIDER_MODEL = '0GM-1.0-35B-A3B'
const KEY = 'sk-test-0123456789abcdef'

function fakeZeroG(over: {
  pubkeySigner?: Address
  signWith?: `0x${string}`
  tamperText?: boolean
  responseModel?: string
  signatureStatus?: number
  /** A browser: the router does not list `ZG-Res-Key` in Access-Control-Expose-Headers. */
  headerHidden?: boolean
} = {}) {
  const encSk = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const encPub = x25519Public(encSk)
  const teeKey = generatePrivateKey()
  const tee = privateKeyToAccount(teeKey).address
  const signer = privateKeyToAccount(over.signWith ?? teeKey)
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const signatures = new Map<string, { text: string; signature: string }>()
  const seen: { prompt?: unknown; model?: unknown } = {}

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    calls.push({ url, method: init?.method ?? 'GET', headers, ...(init?.body ? { body: String(init.body) } : {}) })

    if (url === `${ROUTER}/v1/routing/preview`) {
      return json({ providers: [{ address: PROVIDER, canonical_id: JOB_MODEL, model_id: PROVIDER_MODEL }] })
    }
    if (url === `${PROVIDER_URL}/v1/e2ee/pubkey`) {
      return json({ v: 1, kem_id: '0x0020', enc_pub: b64url(encPub), signer_address: over.pubkeySigner ?? tee })
    }
    if (url === `${ROUTER}/v1/chat/completions`) {
      const env = JSON.parse(String(init!.body))
      const pt = hpkeSetupReceiver(encSk, Buffer.from(env._e2ee.enc, 'base64url'), Buffer.from('0g-pc/v1/seal'))
        .open(aadOf(env), Buffer.from(env._e2ee.ciphertext, 'base64url'))
      seen.prompt = JSON.parse(Buffer.from(pt).toString()).messages
      seen.model = env.model
      const s = hpkeSetupSender(Buffer.from(env._e2ee.client_eph_pub, 'base64url'), Buffer.from('0g-pc/v1/resp'))
      const frame: Record<string, any> = {
        // Measured live: the body id is the ZG-Res-Key value with a `chatcmpl-` prefix.
        id: 'chatcmpl-chat-1',
        model: over.responseModel ?? env.model,
        usage: { prompt_tokens: 31, completion_tokens: 8 },
        _e2ee: { v: 1, enc: b64url(s.enc), sealed_fields: ['choices'], unbound_fields: ['model', 'x_0g_trace'], final: true },
      }
      const choices = [{ finish_reason: 'length', message: { content: 'the answer' } }]
      frame._e2ee.ciphertext = b64url(s.seal(aadOf(frame), Buffer.from(JSON.stringify({ choices }))))
      const real = signedTextE2EE(env, frame)
      const text = over.tamperText ? real.replace(/.$/, real.endsWith('0') ? '1' : '0') : real
      signatures.set('chat-1', { text, signature: await signer.signMessage({ message: text }) })
      frame.x_0g_trace = { provider: PROVIDER } // router-injected, unbound
      return json(frame, 200, over.headerHidden ? {} : { 'zg-res-key': 'chat-1' })
    }
    if (url.startsWith(`${PROVIDER_URL}/v1/proxy/signature/chat-1`)) {
      if (over.signatureStatus) return json({ error: 'nope' }, over.signatureStatus)
      return json({ ...signatures.get('chat-1'), signing_address: tee, signing_algo: 'ecdsa' })
    }
    return json({ error: { code: 'not_found', message: url } }, 404)
  }

  const service: ServiceRecord = {
    url: PROVIDER_URL,
    model: PROVIDER_MODEL,
    verifiability: 'TeeML',
    additionalInfo: JSON.stringify({ TargetSeparated: false }),
    teeSignerAddress: tee,
    teeSignerAcknowledged: true,
  }
  const client = createSealedOgClient({
    baseUrl: 'https://gateway.test',
    inferKey: KEY,
    routerUrl: ROUTER,
    readService: async () => service,
    fetch: fetchImpl as typeof fetch,
    signatureRetryMs: 1,
  })
  return { client, calls, tee, seen }
}

const REQ = { model: JOB_MODEL, maxTokens: 8, messages: [{ role: 'user' as const, content: 'hi' }] }

describe('createSealedOgClient', () => {
  it('returns the enclave answer with a TEE proof that verifies end to end', async () => {
    const { client, tee, seen } = fakeZeroG()
    const r = await client.complete(REQ, 'verified')

    expect(r.text).toBe('the answer')
    expect(r.modelServed).toBe(JOB_MODEL)
    expect(seen).toEqual({ prompt: REQ.messages, model: PROVIDER_MODEL })

    const p = r.teeProof!
    expect(p.teeSigner).toBe(tee)
    expect(await recoverMessageAddress({ message: p.signedText, signature: p.signature })).toBe(tee)
    const v = verifyTranscript(p.transcript as never)
    expect(v.messages).toEqual(REQ.messages)
    expect(v.model).toBe(PROVIDER_MODEL)
    expect(v.signedText).toBe(p.signedText)
  })

  it('pins the provider, disables fallback, and never sends the prompt in clear', async () => {
    const { client, calls } = fakeZeroG()
    await client.complete(REQ, 'verified')

    const sent = calls.find((c) => c.url === `${ROUTER}/v1/chat/completions`)!
    expect(sent.headers['x-0g-provider-address']).toBe(PROVIDER)
    expect(sent.headers['x-0g-provider-allow-fallbacks']).toBe('false')
    expect(sent.body).not.toContain('"hi"')
    expect(JSON.parse(sent.body!)).not.toHaveProperty('messages')
  })

  it('spends nothing when no provider key is bound to its on-chain TEE signer', async () => {
    const { client, calls } = fakeZeroG({ pubkeySigner: '0x000000000000000000000000000000000000dEaD' })
    await expect(client.complete(REQ, 'verified')).rejects.toThrow(/no TEE provider/i)
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false)
  })

  it('refuses a signature that is not from the on-chain TEE signer', async () => {
    const { client } = fakeZeroG({ signWith: generatePrivateKey() })
    await expect(client.complete(REQ, 'verified')).rejects.toThrow(/signer/i)
  })

  it('refuses a signed text that does not bind this exact request and response', async () => {
    const { client } = fakeZeroG({ tamperText: true })
    await expect(client.complete(REQ, 'verified')).rejects.toThrow(/does not match/i)
  })

  it('refuses when the signature cannot be fetched', async () => {
    const { client } = fakeZeroG({ signatureStatus: 404 })
    await expect(client.complete(REQ, 'verified')).rejects.toThrow(/signature/i)
  })

  it('reports a different served model as such, so the loop can refuse it', async () => {
    const { client } = fakeZeroG({ responseModel: 'other-model' })
    const r = await client.complete(REQ, 'verified')
    expect(r.modelServed).toBe('other-model')
  })

  it('never puts the inference key in an error', async () => {
    const { client } = fakeZeroG({ tamperText: true })
    const err = await client.complete(REQ, 'verified').catch((e: Error) => e)
    expect(String((err as Error).message)).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('routeByTrust — prove only what asked to be proven', () => {
  const fake = (label: string) => {
    const calls: string[] = []
    return {
      calls,
      client: {
        models: async () => [label],
        balance: async () => ({ creditBalance: label }) as never,
        complete: async (_req: unknown, mode: string) => {
          calls.push(mode)
          return { text: label } as never
        },
      },
    }
  }

  it('sends a TEE (private) job through the proving client and every other job through the plain one', async () => {
    const plain = fake('plain')
    const proving = fake('proving')
    const og = routeByTrust(plain.client as never, proving.client as never)
    const req = { model: 'm', maxTokens: 4, messages: [] }
    expect(((await og.complete(req, 'private')) as { text: string }).text).toBe('proving')
    expect(((await og.complete(req, 'standard')) as { text: string }).text).toBe('plain')
    expect(((await og.complete(req, 'verified')) as { text: string }).text).toBe('plain')
    expect(proving.calls).toEqual(['private'])
    expect(plain.calls).toEqual(['standard', 'verified'])
  })

  it('answers model and balance reads from the plain client', async () => {
    const og = routeByTrust(fake('plain').client as never, fake('proving').client as never)
    expect(await og.models()).toEqual(['plain'])
    expect(((await og.balance()) as { creditBalance: string }).creditBalance).toBe('plain')
  })
})

// Found live from the `/earn` tab: a browser cannot read `ZG-Res-Key` (the router does
// not expose it), the body id is `chatcmpl-<that key>`, and the signature lives under the
// key alone. Using the body id as-is lost a billed completion on every browser job.
describe('createSealedOgClient — in a browser, where ZG-Res-Key is not readable', () => {
  it('still finds the signature, from the body id without its chatcmpl- prefix', async () => {
    const { client } = fakeZeroG({ headerHidden: true })
    const r = await client.complete(REQ, 'verified')
    expect(r.teeProof?.chatId).toBe('chat-1')
  })
})
