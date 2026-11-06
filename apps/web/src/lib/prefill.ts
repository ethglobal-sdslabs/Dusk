import type { Address } from 'viem'

export interface Prefill {
  buyerAddress?: Address
  workerAddress?: Address
  ogComputeKey?: string
  ogAccessKey?: string
}

export const EMPTY_PREFILL: Prefill = Object.freeze({})

export const PREFILL_ENDPOINT = '/api/config'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const OG_KEY = /^\S+$/

function pick(body: Record<string, unknown>, field: string, shape: RegExp): string | undefined {
  const raw = body[field]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return shape.test(trimmed) ? trimmed : undefined
}

export async function fetchPrefill(fetchImpl: typeof fetch = fetch): Promise<Prefill> {
  let body: unknown
  try {
    const response = await fetchImpl(PREFILL_ENDPOINT, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return EMPTY_PREFILL
    body = await response.json()
  } catch {
    return EMPTY_PREFILL
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) return EMPTY_PREFILL
  return browserCredentials(body as Record<string, unknown>)
}

export function browserCredentials(input: object): Prefill {
  const object = input as Record<string, unknown>

  const buyerAddress = pick(object, 'buyerAddress', ADDRESS)
  const workerAddress = pick(object, 'workerAddress', ADDRESS)
  const ogComputeKey = pick(object, 'ogComputeKey', OG_KEY)
  const ogAccessKey = pick(object, 'ogAccessKey', OG_KEY)

  return {
    ...(buyerAddress ? { buyerAddress: buyerAddress as Address } : {}),
    ...(workerAddress ? { workerAddress: workerAddress as Address } : {}),
    ...(ogComputeKey ? { ogComputeKey } : {}),
    ...(ogAccessKey ? { ogAccessKey } : {}),
  }
}
