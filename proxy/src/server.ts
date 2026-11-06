import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { TrustMode, Visibility, WorkerAd } from '@dusk/core'
import type { DeliveredResult, DuskService, Limits } from '@dusk/mcp/src/service'
import { promptFromCompletion, promptFromMessages, RequestError } from './messages'
import { chooseBid, NoWorkerError, type Bid } from './pricing'

export type ProxyDefaults = {
  maxTokens: number
  deadlineSec: number
  visibility: Visibility
  trustMode: TrustMode
  /** Fixed bid in wei/1k output tokens. Unset: bid the highest live ask. */
  price?: bigint
}

export type ProxyOptions = {
  service: DuskService
  ads: () => Promise<WorkerAd[]>
  limits: Limits
  defaults: ProxyDefaults
  apiKey?: string
  /** Seconds each result() call blocks for before the proxy loops. */
  pollSec?: number
  keepAliveMs?: number
  maxBodyBytes?: number
  now?: () => number
  log?: (line: string) => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(message)
  }
}

const scrub = (s: string) => s.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '$1-[redacted]')

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

function errorBody(e: HttpError) {
  return { error: { message: scrub(e.message), type: e.type, code: e.code, param: e.param } }
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, `request body is over ${limit} bytes`, 'invalid_request_error')
    chunks.push(chunk as Buffer)
  }
  let v: unknown
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not valid JSON', 'invalid_request_error')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new HttpError(400, 'request body must be a JSON object', 'invalid_request_error')
  }
  return v as Record<string, unknown>
}

function weiOf(v: unknown, name: string): bigint | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if ((typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) > 0n)) {
    return BigInt(v)
  }
  throw new HttpError(400, `${name} must be a positive integer number of wei`, 'invalid_request_error', null, name)
}

function intOf(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  throw new HttpError(400, `${name} must be a positive integer`, 'invalid_request_error', null, name)
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  throw new HttpError(400, `${name} must be one of ${allowed.join(', ')}`, 'invalid_request_error', null, name)
}

/** Errors service.submit throws before any money moves are the caller's fault. */
const CALLER_FAULT = /must be|operator cap|per-job cap|image model|prompt is empty|below every live ask|nobody is advertising/

type Kind = 'chat' | 'text'

export function createProxyHandler(opts: ProxyOptions) {
  const { service, limits, defaults } = opts
  const pollSec = opts.pollSec ?? 20
  const keepAliveMs = opts.keepAliveMs ?? 15_000
  const maxBody = opts.maxBodyBytes ?? 16 * 1024 * 1024
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const key = opts.apiKey ? Buffer.from(opts.apiKey) : undefined

  function authorised(req: IncomingMessage): boolean {
    if (!key) return true
    const header = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(header)
    const given = Buffer.from(m?.[1]?.trim() ?? '')
    return given.length === key.length && timingSafeEqual(given, key)
  }

  async function liveAds(): Promise<WorkerAd[]> {
    try {
      return await opts.ads()
    } catch {
      // Public Arkiv RPCs blip; one retry before failing the request.
      return opts.ads()
    }
  }

  async function models() {
    const m = await service.market()
    return {
      object: 'list',
      data: m.models
        .filter((r) => r.workers > 0 || r.configured)
        .map((r) => ({
          id: r.model,
          object: 'model',
          created: 0,
          owned_by: 'dusk',
          dusk: {
            workers: r.workers,
            minPricePer1kOut: r.minPricePer1kOut,
            maxPricePer1kOut: r.maxPricePer1kOut,
            trustModes: r.trustModes,
          },
        })),
    }
  }

  async function waitFor(jobId: string): Promise<DeliveredResult> {
    for (;;) {
      const r = await service.result(jobId, pollSec)
      if (r.status === 'delivered') return r
      if (r.status === 'expired') throw new HttpError(504, r.note, 'timeout_error', 'job_expired')
    }
  }

  async function complete(kind: Kind, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) {
    const model = body.model
    if (typeof model !== 'string' || model.trim() === '') {
      throw new HttpError(400, 'model is required', 'invalid_request_error', null, 'model')
    }
    if (body.n !== undefined && body.n !== 1) {
      throw new HttpError(400, 'n must be 1: each Dusk job yields one answer', 'invalid_request_error', null, 'n')
    }
    for (const field of ['tools', 'functions'] as const) {
      const v = body[field]
      if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null) {
        throw new HttpError(400, `${field} are not supported: Dusk workers run plain text completions`, 'invalid_request_error', null, field)
      }
    }

    let prompt: string
    try {
      prompt = kind === 'chat' ? promptFromMessages(body.messages) : promptFromCompletion(body.prompt)
    } catch (e) {
      if (e instanceof RequestError) throw new HttpError(400, e.message, 'invalid_request_error', null, e.param ?? null)
      throw e
    }

    const asked = intOf(body.max_completion_tokens, 'max_completion_tokens') ?? intOf(body.max_tokens, 'max_tokens')
    // Clients often send a large max_tokens by habit; clamp to the operator cap instead of failing.
    const maxTokens = Math.min(asked ?? defaults.maxTokens, limits.maxTokens)
    const deadlineSec = Math.min(intOf(body.deadline_seconds, 'deadline_seconds') ?? defaults.deadlineSec, limits.maxDeadlineSec)
    const visibility = oneOf(body.visibility, 'visibility', ['private', 'public'] as const) ?? defaults.visibility
    const trustMode = oneOf(body.trust_mode, 'trust_mode', ['standard', 'verified'] as const) ?? defaults.trustMode
    const header = req.headers['x-dusk-max-price']
    const requested =
      weiOf(body.max_price_per_1k_out, 'max_price_per_1k_out') ??
      weiOf(Array.isArray(header) ? header[0] : header, 'x-dusk-max-price')

    let bid: Bid
    try {
      bid = chooseBid({ ads: await liveAds(), model, trustMode, cap: limits.maxPricePer1kOut, requested, envPrice: defaults.price })
    } catch (e) {
      if (e instanceof NoWorkerError) throw new HttpError(503, e.message, 'service_unavailable', 'no_worker', 'model')
      throw new HttpError(502, `could not read the worker market: ${e instanceof Error ? e.message : e}`, 'api_error', 'market_unavailable')
    }

    let posted: Awaited<ReturnType<DuskService['submit']>>
    try {
      posted = await service.submit({ prompt, model, maxTokens, maxPricePer1kOut: bid.wei, deadlineSec, visibility, trustMode })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (CALLER_FAULT.test(msg)) throw new HttpError(400, msg, 'invalid_request_error')
      throw new HttpError(502, `posting the job failed: ${msg}`, 'api_error', 'post_failed')
    }
    log(
      `job ${posted.jobId} ${model} bid=${bid.wei} (${bid.source}, reaches ${bid.reaches}/${bid.live}) ` +
        `max_tokens=${maxTokens} escrow=${posted.escrowWei}`,
    )

    const id = `${kind === 'chat' ? 'chatcmpl' : 'cmpl'}-${posted.jobId}`
    const created = Math.floor(now() / 1000)
    const duskHeaders = {
      'x-dusk-job-id': posted.jobId,
      'x-dusk-bid': String(bid.wei),
      'x-dusk-bid-source': bid.source,
      'x-dusk-max-tokens': String(maxTokens),
    }
    const meta = (d: DeliveredResult) => ({
      jobId: d.jobId,
      worker: d.worker,
      bidPer1kOut: String(bid.wei),
      bidSource: bid.source,
      escrowWei: posted.escrowWei,
      verified: d.verified,
      outputHash: d.outputHash,
      latencyMs: d.latencyMs,
    })
    const usage = (d: DeliveredResult) => ({
      prompt_tokens: d.tokensIn,
      completion_tokens: d.tokensOut,
      total_tokens: d.tokensIn + d.tokensOut,
    })
    const finish = (d: DeliveredResult) => (d.truncated ? 'length' : 'stop')

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...duskHeaders,
      })
      const send = (v: unknown) => !res.destroyed && res.write(`data: ${JSON.stringify(v)}\n\n`)
      // SSE comments keep idle-timeout proxies and clients from dropping the connection while a worker runs.
      const ping = setInterval(() => !res.destroyed && res.write(': waiting for a Dusk worker\n\n'), keepAliveMs)
      try {
        const d = await waitFor(posted.jobId)
        const object = kind === 'chat' ? 'chat.completion.chunk' : 'text_completion'
        const base = { id, object, created, model: d.modelServed }
        const includeUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true
        if (kind === 'chat') {
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: d.output }, finish_reason: null, logprobs: null }] })
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish(d), logprobs: null }], dusk: meta(d) })
        } else {
          send({ ...base, choices: [{ index: 0, text: d.output, finish_reason: finish(d), logprobs: null }], dusk: meta(d) })
        }
        if (includeUsage) send({ ...base, choices: [], usage: usage(d) })
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError(502, e instanceof Error ? e.message : String(e), 'api_error')
        send(errorBody(err))
      } finally {
        clearInterval(ping)
        if (!res.destroyed) res.end('data: [DONE]\n\n')
      }
      return
    }

    const d = await waitFor(posted.jobId)
    const choice =
      kind === 'chat'
        ? { index: 0, message: { role: 'assistant', content: d.output, refusal: null }, finish_reason: finish(d), logprobs: null }
        : { index: 0, text: d.output, finish_reason: finish(d), logprobs: null }
    sendJson(
      res,
      200,
      {
        id,
        object: kind === 'chat' ? 'chat.completion' : 'text_completion',
        created,
        model: d.modelServed,
        choices: [choice],
        usage: usage(d),
        dusk: meta(d),
      },
      duskHeaders,
    )
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/'
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return sendJson(res, 200, { ok: true, service: 'dusk-openai-proxy' })
    }
    if (!authorised(req)) {
      throw new HttpError(401, 'missing or wrong API key (Authorization: Bearer <DUSK_PROXY_API_KEY>)', 'invalid_request_error', 'invalid_api_key')
    }
    const p = path.replace(/^\/v1(?=\/)/, '')
    if (req.method === 'GET' && p === '/models') return sendJson(res, 200, await models())
    if (req.method === 'GET' && p.startsWith('/models/')) {
      const wanted = decodeURIComponent(p.slice('/models/'.length))
      const found = (await models()).data.find((m) => m.id === wanted)
      if (!found) throw new HttpError(404, `model ${wanted} has no live worker and is not configured`, 'invalid_request_error', 'model_not_found')
      return sendJson(res, 200, found)
    }
    if (req.method === 'POST' && p === '/chat/completions') return complete('chat', await readJson(req, maxBody), req, res)
    if (req.method === 'POST' && p === '/completions') return complete('text', await readJson(req, maxBody), req, res)
    throw new HttpError(404, `no route for ${req.method} ${path}`, 'invalid_request_error', 'not_found')
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((e: unknown) => {
      const err = e instanceof HttpError ? e : new HttpError(500, e instanceof Error ? e.message : String(e), 'api_error')
      if (err.status >= 500) log(`error ${err.status}: ${scrub(err.message)}`)
      if (res.headersSent) {
        if (!res.destroyed) res.end()
        return
      }
      sendJson(res, err.status, errorBody(err))
    })
  }
}

export function createProxyServer(opts: ProxyOptions): Server {
  const server = createServer(createProxyHandler(opts))
  // A job can take minutes; never cut an idle response socket off from this side.
  server.timeout = 0
  return server
}
