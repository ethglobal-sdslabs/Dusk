import type { ImagePoll, ImageSubmission } from '@dusk/core'
import { redactKeyish } from './redact'

export class ImageJobError extends Error {
  constructor(detail: string) {
    super(redactKeyish(detail))
    this.name = 'ImageJobError'
  }
}

const COMPLETED = /^(completed|succeeded|success|done|finished)$/i
const FAILED = /^(failed|failure|error|errored|cancelled|canceled|expired)$/i

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseImageSubmit(body: unknown): ImageSubmission {
  const b = isObj(body) ? body : {}
  const jobId = b['jobId'] ?? b['job_id'] ?? b['id']
  if (typeof jobId !== 'string' || jobId === '') {
    throw new ImageJobError('the image submit returned no job id to poll. Nothing was generated.')
  }
  const provider = b['provider_address'] ?? b['providerAddress']
  return typeof provider === 'string' && provider !== ''
    ? { jobId, providerAddress: provider }
    : { jobId }
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function failureReason(b: Obj): string {
  const err = b['error']
  const message =
    (isObj(err) && typeof err['message'] === 'string' && err['message']) ||
    (typeof err === 'string' && err) ||
    (typeof b['message'] === 'string' && b['message']) ||
    `status ${String(b['status'])}`
  return redactKeyish(message)
}

export function parseImagePoll(body: unknown, requestedModel: string): ImagePoll {
  const b = isObj(body) ? body : {}
  const status = typeof b['status'] === 'string' ? b['status'] : ''

  if (FAILED.test(status)) return { state: 'failed', reason: failureReason(b) }
  if (!COMPLETED.test(status)) return { state: 'pending' }

  const inner = isObj(b['data']) ? b['data'] : {}
  const items = Array.isArray(inner['data']) ? inner['data'] : []
  const images = items
    .map((item) => (isObj(item) && typeof item['b64_json'] === 'string' ? item['b64_json'] : ''))
    .filter((b64) => b64.length > 0)
    .map(decodeBase64)
    .filter((bytes) => bytes.length > 0)

  if (images.length === 0) {
    throw new ImageJobError(
      `the image job completed with no base64 image in it (${items.length} item(s)). It was ` +
        'probably billed. Refusing to deliver or commit nothing.',
    )
  }

  const trace = isObj(b['x_0g_trace']) ? b['x_0g_trace'] : {}
  const billing = isObj(trace['billing']) ? trace['billing'] : {}
  const total = billing['total_cost']
  const billedUnits = typeof total === 'string' && /^\d+$/.test(total) ? total : undefined

  return {
    state: 'completed',
    images,
    modelServed: requestedModel,
    outputImages: images.length,
    ...(billedUnits ? { billedUnits } : {}),
  }
}
