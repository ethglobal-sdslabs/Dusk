import type { Balance, CompletionResult } from '@dusk/core'

export class EmptyCompletionError extends Error {
  constructor(detail: string) {
    super(
      `0G returned no usable output (${detail}). The request was still billed. ` +
        'Refusing to deliver or commit an empty result.',
    )
    this.name = 'EmptyCompletionError'
  }
}

type RouterResponse = {
  model?: unknown
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
  choices?: Array<{
    finish_reason?: unknown
    message?: { content?: unknown; reasoning_content?: unknown }
  }>
}

function asInt(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function parseCompletion(
  body: unknown,
  requestedModel: string,
  latencyMs: number,
): CompletionResult {
  const res = (body ?? {}) as RouterResponse
  const choice = res.choices?.[0]
  if (!choice) throw new EmptyCompletionError('no choices in the response')

  const content = asText(choice.message?.content)
  const reasoning = asText(choice.message?.reasoning_content)
  const text = content.trim().length > 0 ? content : reasoning
  if (text.trim().length === 0) {
    throw new EmptyCompletionError(
      `content and reasoning_content both empty, finish_reason=${String(choice.finish_reason)}`,
    )
  }

  return {
    text,
    modelServed: typeof res.model === 'string' && res.model ? res.model : requestedModel,
    tokensIn: asInt(res.usage?.prompt_tokens),
    tokensOut: asInt(res.usage?.completion_tokens),
    finishReason: asText(choice.finish_reason) || 'unknown',
    latencyMs,
  }
}

export function creditsSpentOf(
  before: Balance | null,
  after: Balance | null,
  result: CompletionResult,
): string {
  const proxy = `tokens:${result.tokensIn}/${result.tokensOut}`
  if (!before || !after) return proxy
  try {
    const delta = BigInt(before.creditBalance) - BigInt(after.creditBalance)
    return delta > 0n ? delta.toString() : proxy
  } catch {
    return proxy
  }
}
