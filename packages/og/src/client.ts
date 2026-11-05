import type { Address } from 'viem'
import type { Balance, CompletionRequest, CompletionResult, ModelInfo, OgClient, TrustMode } from '@dusk/core'
import { parseCatalog } from './catalog'
import { parseCompletion } from './parse'
import { redactKeyish } from './redact'

export class OgHttpError extends Error {
  readonly code: string

  constructor(
    readonly status: number,
    code: string,
    readonly requestId: string | undefined,
    detail: string,
  ) {
    const safeCode = redactKeyish(code)
    const safeDetail = redactKeyish(detail)
    const safeRequestId = requestId === undefined ? undefined : redactKeyish(requestId)
    super(
      `0G ${status} ${safeCode}: ${safeDetail}` +
        `${safeRequestId ? ` (request_id ${safeRequestId})` : ''}`,
    )
    this.name = 'OgHttpError'
    this.code = safeCode
  }
}

export type OgClientConfig = {
  baseUrl: string
  inferKey: string
  manageKey?: string
  timeoutMs?: number
}

export async function readError(res: Response): Promise<never> {
  let code = 'error'
  let detail = res.statusText
  let requestId: string | undefined
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string }
      request_id?: string
    }
    code = body.error?.code ?? code
    detail = body.error?.message ?? detail
    requestId = body.request_id
  } catch {
  }
  throw new OgHttpError(res.status, code, requestId, detail)
}

export function createOgClient(cfg: OgClientConfig): OgClient {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = (path: string): string => `${base}/v1${path}`
  const timeoutMs = cfg.timeoutMs ?? 120_000
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs)

  return {
    async models(): Promise<string[]> {
      const res = await fetch(url('/models'), { signal: signal() })
      if (!res.ok) await readError(res)
      const body = (await res.json()) as { data?: Array<{ id?: string }> }
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    },

    async catalog(): Promise<ModelInfo[]> {
      const res = await fetch(url('/models'), { signal: signal() })
      if (!res.ok) await readError(res)
      return parseCatalog(await res.json())
    },

    async complete(req: CompletionRequest, mode: TrustMode): Promise<CompletionResult> {
      const started = Date.now()
      const res = await fetch(url('/chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.inferKey}`,
          'Content-Type': 'application/json',
          'X-0G-Provider-Trust-Mode': mode,
        },
        signal: signal(),
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          messages: req.messages,
        }),
      })
      if (!res.ok) await readError(res)
      return parseCompletion(await res.json(), req.model, Date.now() - started)
    },

    async balance(): Promise<Balance> {
      if (!cfg.manageKey) {
        throw new Error(
          'balance() needs the 0G management key with account:read. The inference key is ' +
            'refused with 403 insufficient_scope, and that error does not explain itself.',
        )
      }
      const res = await fetch(url('/account/balance'), {
        headers: { Authorization: `Bearer ${cfg.manageKey}` },
        signal: signal(),
      })
      if (!res.ok) await readError(res)
      const b = (await res.json()) as Record<string, string>
      return {
        address: (b['address'] ?? '0x') as Address,
        currency: b['currency'] ?? 'unknown',
        depositBalance: b['deposit_balance'] ?? '0',
        creditBalance: b['credit_balance'] ?? '0',
        pendingCharge: b['pending_charge'] ?? '0',
        totalBalance: b['total_balance'] ?? '0',
        ...(b['unsettled_charge'] !== undefined ? { unsettledCharge: b['unsettled_charge'] } : {}),
      }
    },
  }
}

export async function verifiedModels(
  client: OgClient,
  candidates: string[],
  opts: { all?: boolean; maxTokens?: number } = {},
): Promise<string[]> {
  const served: string[] = []
  for (const model of candidates) {
    try {
      await client.complete(
        { model, maxTokens: opts.maxTokens ?? 8, messages: [{ role: 'user', content: 'hi' }] },
        'standard',
      )
      served.push(model)
      if (!opts.all) break
    } catch {
    }
  }
  return served
}
