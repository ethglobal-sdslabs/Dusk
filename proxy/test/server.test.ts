import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { Job, WorkerAd } from '@dusk/core'
import { MODEL, setup } from '../../mcp/test/setup'
import { createProxyServer, type ProxyDefaults } from '../src/server'

const LIMITS = { maxTokens: 1024, maxPricePer1kOut: 10_000_000n, maxEscrowWei: 10n ** 15n, maxDeadlineSec: 3600 }
const DEFAULTS: ProxyDefaults = { maxTokens: 256, deadlineSec: 600, visibility: 'private', trustMode: 'standard' }

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

async function start(opts: { answer?: string | null; apiKey?: string; defaults?: Partial<ProxyDefaults> } = {}) {
  const answer = opts.answer === undefined ? 'the cat sat' : opts.answer
  let deliver: ((job: Job, text: string) => Promise<void>) | undefined
  const posted: Job[] = []
  const t = setup({
    authorise: async (_d, job) => {
      posted.push(job as Job)
      if (answer !== null) await deliver!(job as Job, answer)
      return null
    },
  })
  deliver = t.deliver
  server = createProxyServer({
    service: t.service,
    ads: () => t.arkiv.query<WorkerAd>('worker'),
    limits: LIMITS,
    defaults: { ...DEFAULTS, ...opts.defaults },
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    pollSec: 20,
    keepAliveMs: 5,
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const jobs = () => posted
  return { t, url, post, jobs }
}

const chat = { model: MODEL, messages: [{ role: 'user', content: 'summarise: the cat sat on the mat' }] }

describe('POST /v1/chat/completions', () => {
  it('bids the highest live ask when no price is given and returns an OpenAI chat completion', async () => {
    const p = await start()
    await p.t.advertise(1500n)
    await p.t.advertise(900n)
    await p.t.advertise(4000n)
    const res = await p.post('/chat/completions', chat)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-dusk-bid')).toBe('4000')
    expect(res.headers.get('x-dusk-bid-source')).toBe('market-max')
    const body = await res.json()
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'the cat sat' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      dusk: { bidPer1kOut: '4000', bidSource: 'market-max', verified: 'escrow-commit' },
    })
    expect(p.jobs()[0]!.maxPricePer1kOut).toBe(4000n)
    expect(p.jobs()[0]!.maxTokens).toBe(256)
  })

  it('uses an explicit price from the body, the header, or the env default', async () => {
    const p = await start({ defaults: { price: 7000n } })
    await p.t.advertise(900n)
    expect((await p.post('/chat/completions', { ...chat, max_price_per_1k_out: '1000' })).headers.get('x-dusk-bid')).toBe('1000')
    expect((await p.post('/chat/completions', chat, { 'x-dusk-max-price': '1200' })).headers.get('x-dusk-bid')).toBe('1200')
    const env = await p.post('/chat/completions', chat)
    expect(env.headers.get('x-dusk-bid')).toBe('7000')
    expect(env.headers.get('x-dusk-bid-source')).toBe('env')
  })

  it('clamps max_tokens to the operator cap', async () => {
    const p = await start()
    await p.t.advertise(900n)
    const res = await p.post('/chat/completions', { ...chat, max_tokens: 100_000 })
    expect(res.status).toBe(200)
    expect(p.jobs()[0]!.maxTokens).toBe(1024)
  })

  it('streams the answer as SSE chunks ending in [DONE]', async () => {
    const p = await start()
    await p.t.advertise(900n)
    const res = await p.post('/chat/completions', { ...chat, stream: true, stream_options: { include_usage: true } })
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const events = (await res.text())
      .split('\n\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
    expect(events.at(-1)).toBe('[DONE]')
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'the cat sat' })
    expect(chunks[1].choices[0].finish_reason).toBe('stop')
    expect(chunks[2]).toMatchObject({ choices: [], usage: { total_tokens: 8 } })
  })

  it('answers 503 without posting when no worker serves the model', async () => {
    const p = await start()
    const res = await p.post('/chat/completions', chat)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatchObject({ code: 'no_worker', type: 'service_unavailable' })
    expect(p.jobs()).toHaveLength(0)
  })

  it('answers 400 for an explicit bid below every ask, before posting', async () => {
    const p = await start()
    await p.t.advertise(900n)
    const res = await p.post('/chat/completions', { ...chat, max_price_per_1k_out: 10 })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/below every live ask/)
    expect(p.jobs()).toHaveLength(0)
  })

  it('answers 504 when the job expires undelivered', async () => {
    const p = await start({ answer: null })
    await p.t.advertise(900n)
    const res = await p.post('/chat/completions', { ...chat, deadline_seconds: 60 })
    expect(res.status).toBe(504)
    expect((await res.json()).error.code).toBe('job_expired')
  })

  it('rejects tools and n > 1', async () => {
    const p = await start()
    await p.t.advertise(900n)
    expect((await p.post('/chat/completions', { ...chat, tools: [{ type: 'function' }] })).status).toBe(400)
    expect((await p.post('/chat/completions', { ...chat, n: 2 })).status).toBe(400)
    expect(p.jobs()).toHaveLength(0)
  })
})

describe('POST /v1/completions', () => {
  it('returns a text_completion', async () => {
    const p = await start()
    await p.t.advertise(900n)
    const body = await (await p.post('/completions', { model: MODEL, prompt: 'say hi' })).json()
    expect(body).toMatchObject({ object: 'text_completion', choices: [{ text: 'the cat sat', finish_reason: 'stop' }] })
  })
})

describe('GET /v1/models', () => {
  it('lists models with live workers and their asks', async () => {
    const p = await start()
    await p.t.advertise(900n, [MODEL, 'other'])
    const body = await (await fetch(p.url + '/models')).json()
    expect(body.object).toBe('list')
    expect(body.data.map((m: { id: string }) => m.id).sort()).toEqual([MODEL, 'other'].sort())
    expect(body.data[0]).toMatchObject({ object: 'model', owned_by: 'dusk', dusk: { workers: 1, maxPricePer1kOut: '900' } })
    expect((await fetch(p.url + '/models/nope')).status).toBe(404)
  })
})

describe('auth', () => {
  it('requires the bearer key when one is configured, but not for /health', async () => {
    const p = await start({ apiKey: 'secret-key' })
    expect((await fetch(p.url + '/models')).status).toBe(401)
    expect((await fetch(p.url + '/models', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(p.url + '/models', { headers: { authorization: 'Bearer secret-key' } })).status).toBe(200)
    expect((await fetch(p.url.replace('/v1', '/health'))).status).toBe(200)
  })
})
