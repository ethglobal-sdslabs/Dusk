import type { ImagePoll, ImageRequest, ImageSubmission, OgImageClient, TrustMode } from '@dusk/core'
import type { OgClientConfig } from './client'
import { readError } from './client'
import { parseImagePoll, parseImageSubmit } from './image-parse'

export function createOgImageClient(cfg: OgClientConfig): OgImageClient {
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = (path: string): string => `${base}/v1${path}`
  const timeoutMs = cfg.timeoutMs ?? 120_000
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs)
  const modelOf = new Map<string, string>()

  return {
    async submitImage(req: ImageRequest, mode: TrustMode): Promise<ImageSubmission> {
      const res = await fetch(url('/async/images/generations'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.inferKey}`,
          'Content-Type': 'application/json',
          'X-0G-Provider-Trust-Mode': mode,
        },
        signal: signal(),
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          n: req.n,
          size: req.size,
          response_format: 'b64_json',
        }),
      })
      if (!res.ok) await readError(res)
      const sub = parseImageSubmit(await res.json())
      modelOf.set(sub.jobId, req.model)
      return sub
    },

    async pollImage(sub: ImageSubmission): Promise<ImagePoll> {
      const query = sub.providerAddress
        ? `?provider_address=${encodeURIComponent(sub.providerAddress)}`
        : ''
      const res = await fetch(url(`/async/jobs/${encodeURIComponent(sub.jobId)}${query}`), {
        headers: { Authorization: `Bearer ${cfg.inferKey}` },
        signal: signal(),
      })
      if (!res.ok) await readError(res)
      const poll = parseImagePoll(await res.json(), modelOf.get(sub.jobId) ?? 'unknown')
      if (poll.state !== 'pending') modelOf.delete(sub.jobId)
      return poll
    },
  }
}
