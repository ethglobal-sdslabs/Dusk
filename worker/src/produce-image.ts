import type { ImageContentType, ImagePoll, Job, OgImageClient, TrustMode } from '@dusk/core'
import { parseImageJobInput, sniffImage } from '@dusk/core'
import { redactKeyish } from '@dusk/og'
import type { Producer } from './loop'

export const IMAGE_POLL_MS = 2_000

export const IMAGE_POLL_MAX_ITERATIONS = 300

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
}

function fail(message: string): Error {
  return new Error(redactKeyish(message))
}

export function createImageProducer(args: {
  image: OgImageClient
  now: () => number
  trustMode?: TrustMode
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}): Producer {
  const sleep = args.sleep ?? abortableSleep

  return async (job: Job, input: string, opts) => {
    const { prompt, size } = parseImageJobInput(input)
    if (args.now() >= opts.giveUpAt) {
      throw fail(
        `image job ${job.id}: no time left to generate and still deliver before its deadline. ` +
          'Not starting a generation nobody could be paid for.',
      )
    }

    const started = args.now()
    let submission
    try {
      submission = await args.image.submitImage(
        { model: job.model, prompt, n: job.maxTokens, size },
        args.trustMode ?? job.trustMode,
      )
    } catch (e) {
      throw fail(`image job ${job.id}: submit failed — ${e instanceof Error ? e.message : String(e)}`)
    }

    let poll: ImagePoll = { state: 'pending' }
    for (let i = 0; i < IMAGE_POLL_MAX_ITERATIONS; i++) {
      poll = await args.image.pollImage(submission)
      if (poll.state !== 'pending') break
      if (opts.signal?.aborted) {
        throw fail(`image job ${job.id}: stopped while waiting for 0G. The generation may still be billed.`)
      }
      if (args.now() >= opts.giveUpAt) {
        throw fail(
          `image job ${job.id}: still generating at the delivery deadline. Giving up so the ` +
            'claim is released; the generation may still be billed.',
        )
      }
      await sleep(IMAGE_POLL_MS, opts.signal)
      if (opts.signal?.aborted) {
        throw fail(`image job ${job.id}: stopped while waiting for 0G. The generation may still be billed.`)
      }
    }

    if (poll.state === 'pending') {
      throw fail(
        `image job ${job.id}: no result after ${IMAGE_POLL_MAX_ITERATIONS} polls. The generation ` +
          'may still be billed.',
      )
    }
    if (poll.state === 'failed') {
      throw fail(`image job ${job.id}: 0G reported the generation failed — ${poll.reason}`)
    }

    const bytes = poll.images[0]!
    const contentType: ImageContentType | null = sniffImage(bytes)
    if (!contentType) {
      throw fail(
        `image job ${job.id}: 0G completed with ${bytes.length} bytes that are not an image. ` +
          'It was billed. Refusing to deliver or commit it.',
      )
    }

    return {
      bytes,
      contentType,
      modelServed: job.model,
      tokensIn: 0,
      tokensOut: poll.outputImages,
      creditsSpent: poll.billedUnits ?? `images:${poll.outputImages}`,
      latencyMs: args.now() - started,
    }
  }
}
