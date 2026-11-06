import 'dotenv/config'
import '@dusk/core/env'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SECRETS = [process.env.OG_INFERE_MAIN, process.env.OG_MANAGE_MAIN].filter(
  (v): v is string => typeof v === 'string' && v.length > 0,
)

function redact(text: string): string {
  let out = text
  for (const secret of SECRETS) out = out.split(secret).join('<redacted>')
  return out.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '<redacted>')
}

function say(...parts: unknown[]): void {
  console.log(redact(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p, null, 2))).join(' ')))
}

const BASE = (process.env.OG_BASE_URL_MAIN ?? '').replace(/\/+$/, '').replace(/\/v1$/, '')
const INFER = process.env.OG_INFERE_MAIN
const MANAGE = process.env.OG_MANAGE_MAIN
if (!BASE || !INFER) {
  console.error('OG_BASE_URL_MAIN and og.computeKey (OG_INFERE_MAIN) are required.')
  process.exit(1)
}

const MODEL = 'z-image-turbo'
const PROMPT = 'a lighthouse at dusk, watercolor'
const POLL_MS = 2_000
const MAX_POLLS = 150
const TINY_IMAGE_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGiiivKPcP/9k='
const FIXTURES = new URL('../packages/og/test/fixtures/', import.meta.url)

const url = (path: string): string => `${BASE}/v1${path}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function balance(): Promise<string> {
  if (!MANAGE) return '(no management key — balance unknown)'
  const res = await fetch(url('/account/balance'), { headers: { Authorization: `Bearer ${MANAGE}` } })
  const body = (await res.json().catch(() => ({}))) as Record<string, string>
  return body['credit_balance'] ?? `HTTP ${res.status}`
}

async function submit(model: string): Promise<{ status: number; body: unknown; requestId: string | null }> {
  const res = await fetch(url('/async/images/generations'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${INFER}`,
      'Content-Type': 'application/json',
      'X-0G-Provider-Trust-Mode': 'verified',
    },
    body: JSON.stringify({ model, prompt: PROMPT, n: 1, size: '1024x1024', response_format: 'b64_json' }),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
  }
  return { status: res.status, body, requestId: res.headers.get('x-request-id') }
}

function findBase64(v: unknown, path = '$'): Array<{ path: string; value: string }> {
  if (typeof v === 'string') return v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v) ? [{ path, value: v }] : []
  if (Array.isArray(v)) return v.flatMap((x, i) => findBase64(x, `${path}[${i}]`))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => findBase64(x, `${path}.${k}`))
  return []
}

function shapeOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length ? shapeOf(v[0]) : ''}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${k}:${k === 'status' ? JSON.stringify(o[k]) : shapeOf(o[k])}`).join(',')}}`
  }
  return typeof v
}

function shrink(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v) ? TINY_IMAGE_B64 : v
  if (Array.isArray(v)) return v.map(shrink)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]))
  return v
}

function fixture(name: string, body: unknown): void {
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(new URL(name, FIXTURES), redact(JSON.stringify(body, null, 2)) + '\n')
  say(`  wrote fixture ${name}`)
}

async function main(): Promise<void> {
  say('balance before:', await balance())

  const started = Date.now()
  const sub = await submit(MODEL)
  say(`\nsubmit → HTTP ${sub.status} (x-request-id ${sub.requestId ?? 'none'})`)
  say(sub.body)
  if (sub.status >= 300) {
    fixture('image-error-submit.json', sub.body)
    console.error('submit failed — nothing more to measure')
    process.exit(1)
  }
  fixture('image-submit-202.json', sub.body)
  const b = sub.body as Record<string, unknown>
  const jobId = String(b['jobId'] ?? b['job_id'] ?? b['id'] ?? '')
  const provider = b['provider_address'] ?? b['providerAddress']
  if (!jobId) {
    console.error('no job id in the submit response — see body above')
    process.exit(1)
  }

  const seen = new Set<string>()
  let finalBody: unknown
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS)
    const q = provider ? `?provider_address=${encodeURIComponent(String(provider))}` : ''
    const res = await fetch(url(`/async/jobs/${encodeURIComponent(jobId)}${q}`), {
      headers: { Authorization: `Bearer ${INFER}` },
    })
    const body = (await res.json().catch(async () => ({ raw: await res.text() }))) as Record<string, unknown>
    const shape = `${res.status} ${shapeOf(body)}`
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (!seen.has(shape)) {
      seen.add(shape)
      say(`\npoll #${i + 1} at t+${elapsed}s → HTTP ${res.status}, new shape:`)
      say(shrink(body))
      const status = String(body['status'] ?? '')
      if (findBase64(body).length === 0 && !/fail|error/i.test(status)) fixture('image-poll-pending.json', body)
    }
    const status = String(body['status'] ?? '').toLowerCase()
    const blobs = findBase64(body)
    if (blobs.length > 0 || /complete|succeed|success|done|finished/.test(status)) {
      finalBody = body
      say(`\ncompleted at t+${elapsed}s, status ${JSON.stringify(body['status'])}`)
      break
    }
    if (/fail|error|cancel/.test(status) || res.status >= 400) {
      fixture('image-poll-failed.json', body)
      say(`\nterminal failure at t+${elapsed}s`)
      break
    }
  }

  if (finalBody) {
    const blobs = findBase64(finalBody)
    for (const { path, value } of blobs) {
      const bytes = Buffer.from(value, 'base64')
      say(`  image at ${path}: ${bytes.length} bytes, first 8 = ${bytes.subarray(0, 8).toString('hex')}`)
      const out = process.env.DUSK_PROBE_IMAGE_OUT ?? join(tmpdir(), `dusk-probe-image-${Date.now()}.bin`)
      writeFileSync(out, bytes)
      say(`  full image written to ${out}`)
    }
    fixture('image-poll-completed.json', shrink(finalBody))
  }

  say('\nwaiting 40s for settlement…')
  await sleep(40_000)
  say('balance after:', await balance())

  const bad = await submit('z-image-turbo-does-not-exist')
  say(`\nbad model → HTTP ${bad.status}`)
  say(bad.body)
  fixture(`image-error-${bad.status}.json`, bad.body)
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.stack ?? e.message : String(e)))
  process.exit(1)
})
