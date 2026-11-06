import type { CompletionRequest, CompletionResult, OgClient, TeeProof, TrustMode } from '@dusk/core'
import { createPublicClient, http, recoverMessageAddress, type Address, type Hex } from 'viem'
import { createOgClient, OgHttpError, readError, type OgClientConfig } from './client'
import { b64url, openChatResponse, sealChatRequest, signedTextE2EE, unb64 } from './e2ee'
import { parseCompletion } from './parse'
import { redactKeyish } from './redact'

export interface ServiceRecord {
  url: string
  model: string
  verifiability: string
  additionalInfo: string
  teeSignerAddress: Address
  teeSignerAcknowledged: boolean
}

export interface SealedOgConfig extends OgClientConfig {
  routerUrl: string
  readService: (provider: Address) => Promise<ServiceRecord>
  fetch?: typeof fetch
  signatureRetryMs?: number
}

const SIGNATURE_ATTEMPTS = 4
const KEY_TTL_MS = 5 * 60_000

const SERVICE_ABI = [
  {
    type: 'function', name: 'getService', stateMutability: 'view',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'provider', type: 'address' }, { name: 'serviceType', type: 'string' },
      { name: 'url', type: 'string' }, { name: 'inputPrice', type: 'uint256' },
      { name: 'outputPrice', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' },
      { name: 'model', type: 'string' }, { name: 'verifiability', type: 'string' },
      { name: 'additionalInfo', type: 'string' }, { name: 'teeSignerAddress', type: 'address' },
      { name: 'teeSignerAcknowledged', type: 'bool' },
    ] }],
  },
] as const

export function onChainServiceReader(cfg: { rpc: string; servingContract: Address }) {
  const pub = createPublicClient({ transport: http(cfg.rpc) })
  return async (provider: Address): Promise<ServiceRecord> =>
    (await pub.readContract({ address: cfg.servingContract, abi: SERVICE_ABI, functionName: 'getService', args: [provider] })) as ServiceRecord
}

interface Target {
  provider: Address
  providerModel: string
  identity?: string
  service: ServiceRecord
  encPub: Uint8Array
  until: number
}

const fail = (msg: string): never => {
  throw new Error(redactKeyish(msg))
}
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function createSealedOgClient(cfg: SealedOgConfig): OgClient {
  const plain = createOgClient(cfg)
  const doFetch = cfg.fetch ?? fetch
  const router = cfg.routerUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const timeoutMs = cfg.timeoutMs ?? 120_000
  const signal = () => AbortSignal.timeout(timeoutMs)
  const auth = { Authorization: `Bearer ${cfg.inferKey}` }
  const targets = new Map<string, Target>()

  async function discover(model: string, maxTokens: number): Promise<Target> {
    const cached = targets.get(model)
    if (cached && cached.until > Date.now()) return cached

    const pr = await doFetch(`${router}/v1/routing/preview`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, service_type: 'chatbot' }),
      signal: signal(),
    })
    if (!pr.ok) await readError(pr)
    const providers = ((await pr.json()) as { providers?: Array<Record<string, unknown>> }).providers ?? []

    const rejected: string[] = []
    for (const p of providers) {
      const address = p['address'] as Address
      const canonical = p['canonical_id'] as string | undefined
      if (canonical !== undefined && canonical.toLowerCase() !== model.toLowerCase()) continue
      try {
        const service = await cfg.readService(address)
        if (!service.teeSignerAcknowledged) throw new Error('TEE signer not acknowledged on chain')
        if (service.verifiability !== 'TeeML') throw new Error(`verifiability ${service.verifiability}`)
        const info = JSON.parse(service.additionalInfo || '{}') as Record<string, unknown>
        if (info['TargetSeparated'] === true) throw new Error('LLM runs in a separate TEE')
        if (info['ProviderType'] === 'centralized') throw new Error('centralized provider')

        const kr = await doFetch(`${service.url.replace(/\/+$/, '')}/v1/e2ee/pubkey`, { signal: signal() })
        if (!kr.ok) throw new Error(`pubkey HTTP ${kr.status}`)
        const k = (await kr.json()) as Record<string, unknown>
        const encPub = unb64(String(k['enc_pub'] ?? ''))
        if (k['v'] !== 1 || k['kem_id'] !== '0x0020' || encPub.length !== 32) throw new Error('unsupported enc key')
        if (!sameAddr(String(k['signer_address']), service.teeSignerAddress)) throw new Error('enc key signer ≠ on-chain TEE signer')

        const providerModel = (p['model_id'] as string | undefined) || model
        const identity = p['provider_identity']
        const t: Target = {
          provider: address,
          providerModel,
          ...(typeof identity === 'string' && identity !== '' ? { identity } : {}),
          service,
          encPub,
          until: Date.now() + KEY_TTL_MS,
        }
        targets.set(model, t)
        return t
      } catch (e) {
        rejected.push(`${address}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return fail(
      `no TEE provider for ${model} could be verified, so nothing was sent and no credits were spent` +
        (rejected.length ? ` (${rejected.join('; ')})` : ''),
    )
  }

  /**
   * The enclave's signature, tried under each candidate chat id on every attempt; the one
   * the provider answers is the chat id the proof records. Several candidates because a
   * browser cannot read `ZG-Res-Key` (see `chatIdCandidates`). A wrong candidate is only
   * a 404 — what is signed is checked against our own transcript below regardless.
   */
  async function fetchSignature(t: Target, chatIds: string[]): Promise<{ chatId: string; text: string; signature: Hex }> {
    const base = t.service.url.replace(/\/+$/, '')
    let last = ''
    for (let i = 0; i < SIGNATURE_ATTEMPTS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, (cfg.signatureRetryMs ?? 1000) * i))
      for (const chatId of chatIds) {
        try {
          const r = await doFetch(`${base}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(t.service.model)}`, { signal: signal() })
          if (r.ok) {
            const s = (await r.json()) as { text?: unknown; signature?: unknown }
            if (typeof s.text === 'string' && typeof s.signature === 'string') return { chatId, text: s.text, signature: s.signature as Hex }
            last = 'malformed body'
          } else {
            last = `HTTP ${r.status}`
          }
        } catch (e) {
          last = e instanceof Error ? e.message : String(e)
        }
      }
    }
    return fail(`TEE signature for chat ${chatIds.join(' / ')} could not be fetched (${last}). The completion was billed; its result is not delivered unproven.`)
  }

  return {
    models: () => plain.models(),
    balance: () => plain.balance(),

    async complete(req: CompletionRequest, _mode: TrustMode): Promise<CompletionResult> {
      const t = await discover(req.model, req.maxTokens)
      const sealed = sealChatRequest(
        { model: t.providerModel, max_tokens: req.maxTokens, messages: req.messages },
        { encPub: t.encPub, signerAddr: t.service.teeSignerAddress },
      )

      const headers: Record<string, string> = {
        ...auth,
        'Content-Type': 'application/json',
        'X-0G-Provider-Address': t.provider,
        'X-0G-Provider-Allow-Fallbacks': 'false',
        ...(t.identity ? { 'X-0G-Provider-Identity': t.identity } : {}),
      }
      const started = Date.now()
      const res = await doFetch(`${router}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(sealed.envelope),
        signal: signal(),
      })
      if (!res.ok) {
        targets.delete(req.model)
        await readError(res)
      }
      const latencyMs = Date.now() - started
      const frame = (await res.json()) as Record<string, unknown>
      const chatIds = chatIdCandidates(res.headers.get('zg-res-key'), frame['id'])

      const opened = openChatResponse(frame, sealed.ephPriv)
      const { _e2ee: _drop, ...clear } = frame
      const result = parseCompletion({ ...clear, ...opened }, req.model, latencyMs)
      const answered = typeof frame['model'] === 'string' ? (frame['model'] as string) : t.providerModel
      result.modelServed = answered.toLowerCase() === t.providerModel.toLowerCase() ? req.model : answered

      const ours = signedTextE2EE(sealed.envelope, frame)
      if (chatIds.length === 0) fail('the response carried no chat id, so its TEE signature cannot be fetched')
      const sig = await fetchSignature(t, chatIds)
      const chatId = sig.chatId
      if (sig.text !== ours) {
        fail(`TEE signed text does not match this request and response (signed ${sig.text}, computed ${ours}). Not delivered.`)
      }
      const recovered = await recoverMessageAddress({ message: sig.text, signature: sig.signature })
      if (!sameAddr(recovered, t.service.teeSignerAddress)) {
        fail(`TEE signature recovers to ${recovered}, not the on-chain signer ${t.service.teeSignerAddress}. Not delivered.`)
      }

      const teeProof: TeeProof = {
        scheme: 'zg-sig-v1/e2ee-ct',
        signedText: sig.text,
        signature: sig.signature,
        teeSigner: t.service.teeSignerAddress,
        provider: t.provider,
        chatId,
        transcript: {
          request: sealed.envelope,
          response: frame,
          encPub: b64url(t.encPub),
          skE: b64url(sealed.skE),
          ephPriv: b64url(sealed.ephPriv),
        },
      }
      return { ...result, teeProof }
    },
  }
}

export { OgHttpError }

/**
 * One client for a worker that serves both kinds of job: a `private` (TeeML) job goes
 * through the proving client, because the escrow's verifier pays it only on a TEE proof;
 * every other job through the plain one, because the proving client can only reach
 * TeeML providers and a `standard` job on any other model would otherwise be unservable.
 * Reads (models, balance) are the plain client's — they prove nothing either way.
 */
export function routeByTrust(plain: OgClient, proving: OgClient): OgClient {
  return {
    models: () => plain.models(),
    balance: () => plain.balance(),
    complete: (req, mode) => (mode === 'private' ? proving : plain).complete(req, mode),
  }
}

/**
 * Where the enclave's signature may be filed, most likely first.
 *
 * `ZG-Res-Key` when it can be read — always in Node. A browser cannot: the router's
 * `Access-Control-Expose-Headers` does not list it, so `headers.get` returns null there.
 * Measured live, the body `id` is that same key with a `chatcmpl-` prefix, and the
 * signature lives under the key alone — so the stripped id comes next, then the body id
 * as-is in case a provider ever files it that way.
 */
export function chatIdCandidates(header: string | null, bodyId: unknown): string[] {
  const body = typeof bodyId === 'string' ? bodyId : ''
  const all = header ? [header] : [body.replace(/^chatcmpl-/, ''), body]
  return [...new Set(all.filter((id) => id !== ''))]
}
