import type { SwarmRef, SwarmStore } from '@dusk/core'

export const DEFAULT_UPLOAD_URL = 'https://api.gateway.ethswarm.org'
export const DEFAULT_DOWNLOAD_URL = 'https://download.gateway.ethswarm.org'

const SPONSORED_BATCH = '0'.repeat(64)

const DEFAULT_RETRIES = 4

export class SwarmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwarmError'
  }
}

export type SwarmStoreConfig = {
  uploadUrl: string
  downloadUrl: string
  batchId?: string
  retries?: number
  timeoutMs?: number
}

class Transient extends Error {
  constructor(readonly detail: string) {
    super(detail)
  }
}

async function withRetry<T>(
  label: string,
  attempts: number,
  attempt: () => Promise<T>,
): Promise<T> {
  let last = ''
  for (let i = 1; i <= attempts; i++) {
    try {
      return await attempt()
    } catch (e) {
      if (!(e instanceof Transient)) throw e
      last = e.detail
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 400))
    }
  }
  throw new SwarmError(`${label} failed after ${attempts} attempt(s): ${last}`)
}

async function fetchOrTransient(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new Transient(e instanceof Error ? e.message : String(e))
  }
}

export function createSwarmStore(cfg: SwarmStoreConfig): SwarmStore & { uploads: SwarmRef[] } {
  const uploadBase = cfg.uploadUrl.replace(/\/+$/, '')
  const downloadBase = cfg.downloadUrl.replace(/\/+$/, '')
  const batchId = cfg.batchId ?? SPONSORED_BATCH
  const attempts = Math.max(1, cfg.retries ?? DEFAULT_RETRIES)
  const timeoutMs = cfg.timeoutMs ?? 30_000
  const uploads: SwarmRef[] = []

  return {
    uploads,

    async upload(data: Uint8Array, opts?: { encrypt?: boolean; contentType?: string }): Promise<SwarmRef> {
      const headers: Record<string, string> = {
        'Content-Type': opts?.contentType ?? 'application/octet-stream',
        'swarm-postage-batch-id': batchId,
      }
      if (opts?.encrypt) headers['swarm-encrypt'] = 'true'

      const ref = await withRetry('upload', attempts, async () => {
        const res = await fetchOrTransient(`${uploadBase}/bzz`, timeoutMs, {
          method: 'POST',
          headers,
          body: data as BodyInit,
        })
        if (res.status >= 500) throw new Transient(`HTTP ${res.status}`)
        if (!res.ok) {
          throw new SwarmError(`upload failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
        }
        const body = (await res.json().catch(() => ({}))) as { reference?: string }
        if (!body.reference) {
          throw new SwarmError(`upload returned no reference: ${JSON.stringify(body)}`)
        }
        return body.reference
      })

      uploads.push(ref)
      return ref
    },

    async download(ref: SwarmRef): Promise<Uint8Array> {
      return withRetry(`download ${ref.slice(0, 16)}…`, attempts, async () => {
        const res = await fetchOrTransient(`${downloadBase}/bzz/${ref}/`, timeoutMs, {
          redirect: 'follow',
        })

        if (res.status >= 500) throw new Transient(`HTTP ${res.status}`)
        if (!res.ok) {
          throw new SwarmError(`download failed for ${ref.slice(0, 16)}…: HTTP ${res.status}`)
        }

        const contentType = res.headers.get('content-type') ?? ''
        if (/\btext\/html\b/i.test(contentType)) {
          throw new SwarmError(
            `download for ${ref.slice(0, 16)}… returned text/html, not content. Reads must go ` +
              `to a download gateway (${DEFAULT_DOWNLOAD_URL}) with a trailing slash; the ` +
              'upload endpoint serves a landing page with HTTP 200.',
          )
        }

        return new Uint8Array(await res.arrayBuffer())
      })
    },
  }
}
