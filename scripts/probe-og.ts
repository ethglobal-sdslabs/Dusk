import 'dotenv/config'
import '@dusk/core/env'

const SECRETS = [
  process.env.OG_INFERE,
  process.env.OG_MANAGE,
  process.env.OG_INFERE_MAIN,
].filter((v): v is string => typeof v === 'string' && v.length > 0)

function redact(text: string): string {
  let out = text
  for (const secret of SECRETS) out = out.split(secret).join('<redacted>')
  return out.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '<redacted>')
}

function say(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2)))
    .join(' ')
  console.log(redact(line))
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1${path}`
}

type Env = {
  label: string
  base: string | undefined
  infer: string | undefined
  manage: string | undefined
}

const ENVIRONMENTS: Env[] = [
  {
    label: 'testnet',
    base: process.env.OG_BASE_URL,
    infer: process.env.OG_INFERE,
    manage: process.env.OG_MANAGE,
  },
  {
    label: 'mainnet',
    base: process.env.OG_BASE_URL_MAIN,
    infer: process.env.OG_INFERE_MAIN,
    manage: undefined,
  },
]

const PREFERRED_MODEL = '0gm-1.0-35b-a3b'

const MAX_MODELS_TRIED = 3

const MAX_TOKENS = 16

type ModelOutcome = { model: string; status: number; detail: string }
type Result = {
  label: string
  advertised: string[]
  balance: string
  outcomes: ModelOutcome[]
  servedInference: boolean
}

async function listModels(base: string): Promise<string[]> {
  const res = await fetch(endpoint(base, '/models'))
  const body = (await res.json()) as { data?: Array<{ id?: string }> }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`)
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
}

async function tryCompletion(base: string, key: string, model: string): Promise<ModelOutcome> {
  const res = await fetch(endpoint(base, '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  const body = (await res.json()) as {
    error?: { code?: string; message?: string }
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    choices?: Array<{
      finish_reason?: string
      message?: { content?: string; reasoning_content?: string }
    }>
  }

  if (!res.ok) {
    return {
      model,
      status: res.status,
      detail: `${body.error?.code ?? 'error'} — ${body.error?.message ?? 'no message'}`,
    }
  }

  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? ''
  const reasoning = choice?.message?.reasoning_content ?? ''
  const served = content.trim().length > 0 || reasoning.trim().length > 0
  const shown = content.trim().length > 0 ? content : `(reasoning only) ${reasoning}`

  return {
    model,
    status: 200,
    detail: served
      ? `${JSON.stringify(shown.slice(0, 80))} · finish=${choice?.finish_reason} · in=${
          body.usage?.prompt_tokens ?? '?'
        } out=${body.usage?.completion_tokens ?? '?'}`
      : `EMPTY response with no content and no reasoning_content · ${JSON.stringify(body)}`,
  }
}

async function probe(env: Env): Promise<Result | null> {
  const { label, base, infer, manage } = env
  say(`\n═══ ${label} ═══`)
  if (!base || !infer) {
    say(`  skipped — ${label} base url or inference key not set in .env`)
    return null
  }
  say(`  ${base}`)

  const result: Result = {
    label,
    advertised: [],
    balance: 'not read',
    outcomes: [],
    servedInference: false,
  }

  try {
    result.advertised = await listModels(base)
    say(`  models (${result.advertised.length}): ${result.advertised.join(', ')}`)
  } catch (e) {
    say(`  ✗ GET /v1/models failed: ${String(e)}`)
    return result
  }

  if (manage) {
    try {
      const res = await fetch(endpoint(base, '/account/balance'), {
        headers: { Authorization: `Bearer ${manage}` },
      })
      const body = (await res.json()) as Record<string, unknown>
      result.balance = res.ok ? JSON.stringify(body) : `HTTP ${res.status} ${JSON.stringify(body)}`
      say(`  balance: ${result.balance}`)
      if (res.ok && body['credit_balance'] === '0' && body['deposit_balance'] === '0') {
        say(
          '  note: all-zero here while the dashboard shows a balance is the known 0G bug —',
        )
        say(
          '        the dashboard reads the Payment Layer contract, the Router reads its own',
        )
        say('        ledger, and the two can disagree. Not a failure of this script.')
      }
    } catch (e) {
      result.balance = `threw: ${String(e)}`
      say(`  balance: ${result.balance}`)
    }
  } else {
    say('  balance: skipped — no manage (mk-) key for this environment')
  }

  const ordered = [
    ...result.advertised.filter((m) => m === PREFERRED_MODEL),
    ...result.advertised.filter((m) => m !== PREFERRED_MODEL),
  ]
  const attempts = ordered.slice(0, MAX_MODELS_TRIED)
  for (const model of attempts) {
    const outcome = await tryCompletion(base, infer, model)
    result.outcomes.push(outcome)
    const ok = outcome.status === 200 && !outcome.detail.startsWith('EMPTY')
    if (ok) result.servedInference = true
    say(`  ${ok ? '✓' : '✗'} ${model} → HTTP ${outcome.status}: ${outcome.detail}`)
    if (ok) break
  }
  const untried = ordered.length - result.outcomes.length
  if (untried > 0) {
    say(`  (${untried} further advertised model(s) not tried — stopped at first success)`)
  }

  return result
}

const results: Result[] = []
for (const env of ENVIRONMENTS) {
  const r = await probe(env)
  if (r) results.push(r)
}

say('\n═══ summary ═══')
for (const r of results) {
  const tried = r.outcomes.length
  const served = r.outcomes.filter((o) => o.status === 200).length
  const unroutable = r.outcomes.filter((o) => o.status !== 200).length
  say(
    `  ${r.label}: ${r.advertised.length} advertised, ${tried} tried, ${served} served` +
      (unroutable > 0 ? `  ← ${unroutable} advertised but NOT routable` : ''),
  )
}

const green = results.some((r) => r.servedInference)
say('')
if (!green) {
  say('✗ Gate 0 light #1 NOT green — no environment served a completion')
  process.exit(1)
}
const working = results.filter((r) => r.servedInference).map((r) => r.label)
say(`✓ Gate 0 light #1 green — inference served on: ${working.join(', ')}`)
