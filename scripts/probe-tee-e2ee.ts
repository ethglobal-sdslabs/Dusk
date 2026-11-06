import 'dotenv/config'
import '@dusk/core/env'
import { writeFileSync } from 'node:fs'
import { createPublicClient, http, recoverMessageAddress, type Address, type Hex } from 'viem'
import { b64url, openChatResponse, sealChatRequest, signedTextE2EE, verifyTranscript } from '@dusk/og/e2ee'

const ROUTER = process.env.OG_ROUTER_CLOUD_URL || 'https://router-api-cloud.0g.ai'
const SK = process.env.OG_INFERE_MAIN ?? ''
const MK = process.env.OG_MANAGE_MAIN ?? ''
const BASE = (process.env.OG_BASE_URL_MAIN ?? 'https://router-api.0g.ai').replace(/\/+$/, '').replace(/\/v1$/, '')
const MODEL = process.env.DUSK_MODEL || '0gm-1.0-35b-a3b'
const LIVE = process.env.PROBE_LIVE === '1'
const MAINNET_RPC = process.env.OG_MAINNET_RPC || 'https://evmrpc.0g.ai'
const INFERENCE_SERVING: Address = '0x47340d900bdFec2BD393c626E12ea0656F938d84'
const OUT = process.env.PROBE_OUT || 'probe-tee-e2ee-result.json'

const SECRETS = [SK, MK].filter((v) => v.length > 0)
const redact = (t: string) => {
  let o = t
  for (const s of SECRETS) o = o.split(s).join('<redacted>')
  return o.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '<redacted>')
}
const say = (...p: unknown[]) =>
  console.log(redact(p.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ')))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

async function balance(): Promise<string | undefined> {
  if (!MK) return undefined
  const r = await fetch(`${BASE}/v1/account/balance`, { headers: { Authorization: `Bearer ${MK}` } })
  return r.ok ? String(((await r.json()) as Record<string, unknown>)['credit_balance']) : `HTTP ${r.status}`
}

async function main(): Promise<void> {
  if (!SK) throw new Error('OG_INFERE_MAIN must be set (mainnet).')
  const result: Record<string, unknown> = { model: MODEL, router: ROUTER, live: LIVE, at: new Date().toISOString() }
  const auth = { Authorization: `Bearer ${SK}` }

  const pr = await fetch(`${ROUTER}/v1/routing/preview`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 8, service_type: 'chatbot' }),
  })
  const previewText = await pr.text()
  say('preview:', pr.status, previewText.slice(0, 1500))
  result.preview = { status: pr.status, body: previewText }
  if (!pr.ok) throw new Error(`route preview failed: HTTP ${pr.status}`)
  const candidates = (JSON.parse(previewText).providers ?? []) as Array<Record<string, any>>
  if (candidates.length === 0) throw new Error('route preview returned no providers')

  const pub = createPublicClient({ transport: http(MAINNET_RPC) })
  let chosen: { cand: Record<string, any>; svc: any; encPub: Buffer } | undefined
  for (const cand of candidates) {
    const svc: any = await pub.readContract({ address: INFERENCE_SERVING, abi: SERVICE_ABI, functionName: 'getService', args: [cand.address] })
    const kr = await fetch(`${svc.url.replace(/\/+$/, '')}/v1/e2ee/pubkey`)
    const kt = await kr.text()
    say(`candidate ${cand.address}: service ${svc.url} (${svc.model}, ${svc.verifiability}), pubkey ${kr.status}`, kt.slice(0, 400))
    if (!kr.ok) continue
    const k = JSON.parse(kt) as Record<string, any>
    const encPub = Buffer.from(k.enc_pub, 'base64url')
    const signerOk = String(k.signer_address).toLowerCase() === String(svc.teeSignerAddress).toLowerCase()
    say('  signer matches on-chain teeSignerAddress:', signerOk, '| acknowledged:', svc.teeSignerAcknowledged, '| kem_id:', k.kem_id, '| v:', k.v)
    if (signerOk && svc.teeSignerAcknowledged && encPub.length === 32) {
      chosen = { cand, svc, encPub }
      break
    }
  }
  if (!chosen) throw new Error('no candidate had an enc key bound to its on-chain TEE signer')
  const { cand, svc, encPub } = chosen
  result.provider = { address: cand.address, identity: cand.provider_identity, modelId: cand.model_id, url: svc.url, teeSigner: svc.teeSignerAddress }

  const model = (cand.model_id as string) || MODEL
  const sealed = sealChatRequest(
    { model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { encPub, signerAddr: svc.teeSignerAddress },
  )
  const body = JSON.stringify(sealed.envelope)
  say('sealed envelope (prompt not visible):', sealed.envelope)
  result.request = sealed.envelope

  if (!LIVE) {
    say('\nDRY RUN — discovery and sealing work. Nothing sent, no credits spent. Re-run with PROBE_LIVE=1.')
    writeFileSync(OUT, redact(JSON.stringify(result, null, 2)))
    return
  }

  result.balanceBefore = await balance()
  const headers: Record<string, string> = {
    ...auth,
    'Content-Type': 'application/json',
    'X-0G-Provider-Address': cand.address,
    'X-0G-Provider-Allow-Fallbacks': 'false',
  }
  if (typeof cand.provider_identity === 'string' && cand.provider_identity !== '') headers['X-0G-Provider-Identity'] = cand.provider_identity
  const t0 = Date.now()
  const res = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers, body })
  const raw = await res.text()
  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => (resHeaders[k] = v))
  say(`completion: ${res.status} (${Date.now() - t0}ms)`, resHeaders, raw.slice(0, 2000))
  result.completion = { status: res.status, headers: resHeaders, raw }
  if (!res.ok) {
    writeFileSync(OUT, redact(JSON.stringify(result, null, 2)))
    throw new Error(`completion failed: HTTP ${res.status}`)
  }

  const frame = JSON.parse(raw) as Record<string, any>
  const opened = openChatResponse(frame, sealed.ephPriv)
  say('opened choices:', opened.choices)
  const ours = signedTextE2EE(sealed.envelope, frame)
  const chatKey = resHeaders['zg-res-key'] ?? frame.id
  await sleep(1500)
  const sr = await fetch(`${svc.url.replace(/\/+$/, '')}/v1/proxy/signature/${encodeURIComponent(chatKey)}?model=${encodeURIComponent(svc.model)}`)
  const st = await sr.text()
  say('signature fetch:', sr.status, st)
  result.signature = { status: sr.status, body: st, ourText: ours }
  if (sr.ok) {
    const s = JSON.parse(st) as { text: string; signature: Hex }
    const recovered = await recoverMessageAddress({ message: s.text, signature: s.signature })
    const checks = {
      ourSignedText: ours,
      theirSignedText: s.text,
      textMatches: s.text === ours,
      recovered,
      signerIsOnChainTee: recovered.toLowerCase() === String(svc.teeSignerAddress).toLowerCase(),
    }
    result.checks = checks
    say('CHECKS:', checks)
  }

  const transcript = { request: sealed.envelope, response: frame, encPub: b64url(encPub), skE: b64url(sealed.skE), ephPriv: b64url(sealed.ephPriv) }
  const v = verifyTranscript(transcript)
  say('VERIFIED TRANSCRIPT:', { model: v.model, maxTokens: v.maxTokens, messages: v.messages, choices: v.choices, signedTextMatches: v.signedText === ours })
  result.transcript = transcript

  await sleep(40_000)
  result.balanceAfter = await balance()
  say('balance before/after (t+40s):', result.balanceBefore, '→', result.balanceAfter)
  writeFileSync(OUT, redact(JSON.stringify(result, null, 2)))
  say(`wrote ${OUT}`)
}

main().catch((e) => {
  say('probe failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
