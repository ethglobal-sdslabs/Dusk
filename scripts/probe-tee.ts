import 'dotenv/config'
import '@dusk/core/env'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createPublicClient, http, recoverMessageAddress, type Address, type Hex } from 'viem'

const BASE = (process.env.OG_BASE_URL_MAIN ?? '').replace(/\/+$/, '').replace(/\/v1$/, '')
const SK = process.env.OG_INFERE_MAIN ?? ''
const MK = process.env.OG_MANAGE_MAIN ?? ''
const MODEL = process.env.DUSK_MODEL || '0gm-1.0-35b-a3b'
const TRUST_MODE = process.env.PROBE_TRUST_MODE || 'verified'
const MAINNET_RPC = process.env.OG_MAINNET_RPC || 'https://evmrpc.0g.ai'
const INFERENCE_SERVING: Address = '0x47340d900bdFec2BD393c626E12ea0656F938d84'
const OUT = process.env.PROBE_OUT || 'probe-tee-result.json'

const SECRETS = [SK, MK].filter((v) => v.length > 0)
function redact(text: string): string {
  let out = text
  for (const s of SECRETS) out = out.split(s).join('<redacted>')
  return out.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '<redacted>')
}
function say(...parts: unknown[]): void {
  console.log(redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2))).join(' ')))
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SERVICE_ABI = [
  {
    type: 'function',
    name: 'getService',
    stateMutability: 'view',
    inputs: [{ name: 'provider', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'provider', type: 'address' },
          { name: 'serviceType', type: 'string' },
          { name: 'url', type: 'string' },
          { name: 'inputPrice', type: 'uint256' },
          { name: 'outputPrice', type: 'uint256' },
          { name: 'updatedAt', type: 'uint256' },
          { name: 'model', type: 'string' },
          { name: 'verifiability', type: 'string' },
          { name: 'additionalInfo', type: 'string' },
          { name: 'teeSignerAddress', type: 'address' },
          { name: 'teeSignerAcknowledged', type: 'bool' },
        ],
      },
    ],
  },
] as const

async function balance(): Promise<string | undefined> {
  if (!MK) return undefined
  const res = await fetch(`${BASE}/v1/account/balance`, { headers: { Authorization: `Bearer ${MK}` } })
  if (!res.ok) return `HTTP ${res.status}`
  const b = (await res.json()) as Record<string, unknown>
  return String(b['credit_balance'] ?? JSON.stringify(b))
}

async function fetchSignature(url: string, chatID: string, model: string) {
  const u = `${url.replace(/\/+$/, '')}/v1/proxy/signature/${encodeURIComponent(chatID)}?model=${encodeURIComponent(model)}`
  const res = await fetch(u)
  const body = await res.text()
  return { url: u, status: res.status, body }
}

async function main(): Promise<void> {
  if (!BASE || !SK) throw new Error('OG_BASE_URL_MAIN and OG_INFERE_MAIN must be set (mainnet).')
  const result: Record<string, unknown> = { model: MODEL, trustMode: TRUST_MODE, at: new Date().toISOString() }

  const before = await balance()
  result.balanceBefore = before
  say('balance before:', before ?? '(no mk- key)')

  const requestObj = {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
    verify_tee: true,
  }
  const sentBody = JSON.stringify(requestObj)
  const t0 = Date.now()
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SK}`,
      'Content-Type': 'application/json',
      'X-0G-Provider-Trust-Mode': TRUST_MODE,
    },
    body: sentBody,
  })
  const rawResponse = await res.text()
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  result.completion = { status: res.status, ms: Date.now() - t0, headers, sentBody, rawResponse }
  say('completion status:', res.status, `(${Date.now() - t0}ms)`)
  say('response headers:', headers)
  say('raw response:', rawResponse)
  if (!res.ok) {
    writeFileSync(OUT, redact(JSON.stringify(result, null, 2)))
    throw new Error(`completion failed: HTTP ${res.status}`)
  }

  const parsed = JSON.parse(rawResponse) as Record<string, any>
  const trace = parsed['x_0g_trace'] ?? {}
  const chatID: string | undefined = headers['zg-res-key'] ?? parsed['id']
  const provider: Address | undefined = trace['provider']
  result.chatID = chatID
  result.trace = trace
  say('chat id:', chatID, '| from header:', 'zg-res-key' in headers)
  say('x_0g_trace:', trace)

  let svc: any
  if (provider) {
    const pub = createPublicClient({ transport: http(MAINNET_RPC) })
    svc = await pub.readContract({ address: INFERENCE_SERVING, abi: SERVICE_ABI, functionName: 'getService', args: [provider] })
    const info = (() => {
      try {
        return JSON.parse(svc.additionalInfo)
      } catch {
        return svc.additionalInfo
      }
    })()
    result.service = { ...svc, inputPrice: String(svc.inputPrice), outputPrice: String(svc.outputPrice), updatedAt: String(svc.updatedAt), additionalInfoParsed: info }
    say('service record:', result.service)
  } else {
    say('NO provider in x_0g_trace — cannot look up the service record.')
  }

  if (svc && chatID) {
    let signingAddress: string = svc.teeSignerAddress
    try {
      const info = JSON.parse(svc.additionalInfo)
      const centralized = info.ProviderType === 'centralized'
      if (info.TargetSeparated === true && !centralized && info.TargetTeeAddress) signingAddress = info.TargetTeeAddress
      result.providerType = info.ProviderType ?? 'decentralized'
      result.targetSeparated = info.TargetSeparated ?? false
    } catch {
    }
    result.expectedSigner = signingAddress

    const sig = await fetchSignature(svc.url, chatID, svc.model)
    result.signatureFetch = sig
    say('signature fetch:', sig.status, sig.body)

    if (sig.status === 200) {
      const s = JSON.parse(sig.body) as { text: string; signature: Hex }
      const recovered = await recoverMessageAddress({ message: s.text, signature: s.signature })
      const [reqHash, respHash] = s.text.split(':')
      const { verify_tee: _drop, ...withoutFlag } = requestObj
      const sortedKeys = (o: Record<string, unknown>) =>
        JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))))
      const { x_0g_trace: _t, ...respWithoutTrace } = parsed
      const reqCandidates = {
        'exact bytes sent': sha256(sentBody),
        'sent minus verify_tee': sha256(JSON.stringify(withoutFlag)),
        'sent minus verify_tee, keys sorted': sha256(sortedKeys(withoutFlag)),
      }
      const respCandidates = {
        'exact bytes received': sha256(rawResponse),
        'received minus x_0g_trace (re-serialized)': sha256(JSON.stringify(respWithoutTrace)),
      }
      const checks = {
        signedText: s.text,
        recoveredSigner: recovered,
        signerMatches: recovered.toLowerCase() === signingAddress.toLowerCase(),
        teeSignerAcknowledged: svc.teeSignerAcknowledged,
        requestHashMatches: Object.entries(reqCandidates).filter(([, h]) => h === reqHash).map(([k]) => k),
        responseHashMatches: Object.entries(respCandidates).filter(([, h]) => h === respHash).map(([k]) => k),
        reqCandidates,
        respCandidates,
      }
      result.checks = checks
      say('CHECKS:', checks)
    }
  }

  say('waiting 60s to re-fetch the signature and read the settled balance...')
  await sleep(60_000)
  if (svc && chatID) {
    const again = await fetchSignature(svc.url, chatID, svc.model)
    result.signatureAt60s = { status: again.status, sameBody: again.body === (result.signatureFetch as any)?.body }
    say('signature at t+60s:', result.signatureAt60s)
  }
  const after = await balance()
  result.balanceAfter = after
  say('balance after (t+60s):', after ?? '(no mk- key)')

  writeFileSync(OUT, redact(JSON.stringify(result, null, 2)))
  say(`\nwrote ${OUT}`)
}

main().catch((e) => {
  say('probe failed:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
