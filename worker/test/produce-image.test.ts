import { describe, expect, it } from 'vitest'
import type { ImagePoll, Job } from '@dusk/core'
import { imageJobInput, ImageInputError } from '@dusk/core'
import { OgHttpError } from '@dusk/og'
import { createImageProducer, IMAGE_POLL_MAX_ITERATIONS } from '../src/produce-image'
import { fakeOgImage } from './fakes'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const INPUT = imageJobInput('a red kite', '1024x1024')
const job = { id: 'job-1', model: 'z-image-turbo', maxTokens: 1, trustMode: 'verified' } as Job
const done = (over: Partial<Extract<ImagePoll, { state: 'completed' }>> = {}): ImagePoll => ({
  state: 'completed',
  images: [JPEG],
  modelServed: 'z-image-turbo',
  outputImages: 1,
  billedUnits: '8800',
  ...over,
})

function clock(start = 0, step = 0) {
  let t = start
  return () => {
    const now = t
    t += step
    return now
  }
}
const instant = async () => {}

describe('createImageProducer', () => {
  it('submits the prompt and size from the input blob, n from maxTokens', async () => {
    const image = fakeOgImage({ polls: [done()] })
    await createImageProducer({ image, now: clock(), sleep: instant })(job, INPUT, { giveUpAt: 1e12 })
    expect(image.submits).toEqual([{ model: 'z-image-turbo', prompt: 'a red kite', n: 1, size: '1024x1024' }])
  })

  it('polls until completed and returns the image bytes with their sniffed type', async () => {
    const image = fakeOgImage({ polls: [{ state: 'pending' }, { state: 'pending' }, done()] })
    const p = await createImageProducer({ image, now: clock(), sleep: instant })(job, INPUT, { giveUpAt: 1e12 })
    expect(p.bytes).toEqual(JPEG)
    expect(p.contentType).toBe('image/jpeg')
    expect(image.pollCount()).toBe(3)
  })

  it("records the Router's billed units, and falls back to images:<n>", async () => {
    const billed = await createImageProducer({ image: fakeOgImage({ polls: [done()] }), now: clock(), sleep: instant })(
      job, INPUT, { giveUpAt: 1e12 },
    )
    expect(billed.creditsSpent).toBe('8800')
    expect(billed.tokensIn).toBe(0)
    expect(billed.tokensOut).toBe(1)
    expect(billed.modelServed).toBe('z-image-turbo')
    const { billedUnits: _b, ...noBill } = done() as Extract<ImagePoll, { state: 'completed' }>
    const proxy = await createImageProducer({ image: fakeOgImage({ polls: [noBill] }), now: clock(), sleep: instant })(
      job, INPUT, { giveUpAt: 1e12 },
    )
    expect(proxy.creditsSpent).toBe('images:1')
  })

  it('refuses bytes that are not an image', async () => {
    const html = new TextEncoder().encode('<html>gateway</html>')
    const run = createImageProducer({ image: fakeOgImage({ polls: [done({ images: [html] })] }), now: clock(), sleep: instant })
    await expect(run(job, INPUT, { giveUpAt: 1e12 })).rejects.toThrow(/billed/)
  })

  it("throws on a failed poll with the provider's reason", async () => {
    const run = createImageProducer({
      image: fakeOgImage({ polls: [{ state: 'failed', reason: 'out of memory' }] }),
      now: clock(),
      sleep: instant,
    })
    await expect(run(job, INPUT, { giveUpAt: 1e12 })).rejects.toThrow(/out of memory/)
  })

  it('never starts a generation it has no time to finish', async () => {
    const image = fakeOgImage({ polls: [done()] })
    const run = createImageProducer({ image, now: clock(5_000), sleep: instant })
    await expect(run(job, INPUT, { giveUpAt: 5_000 })).rejects.toThrow(/time/)
    expect(image.submits).toHaveLength(0)
  })

  it('gives up polling once the delivery margin is reached', async () => {
    const image = fakeOgImage({ polls: [{ state: 'pending' }] })
    const run = createImageProducer({ image, now: clock(0, 2_000), sleep: instant })
    await expect(run(job, INPUT, { giveUpAt: 10_000 })).rejects.toThrow(/billed/)
    expect(image.pollCount()).toBeLessThan(10)
  })

  it('aborts the poll on signal', async () => {
    const ac = new AbortController()
    const image = fakeOgImage({ polls: [{ state: 'pending' }] })
    const sleep = async () => {
      ac.abort()
    }
    const run = createImageProducer({ image, now: clock(), sleep })
    await expect(run(job, INPUT, { giveUpAt: 1e12, signal: ac.signal })).rejects.toThrow(/stop/i)
    expect(image.pollCount()).toBe(1)
  })

  it('stops at IMAGE_POLL_MAX_ITERATIONS even with a frozen clock', async () => {
    const image = fakeOgImage({ polls: [{ state: 'pending' }] })
    const run = createImageProducer({ image, now: () => 0, sleep: instant })
    await expect(run(job, INPUT, { giveUpAt: 1e12 })).rejects.toThrow()
    expect(image.pollCount()).toBe(IMAGE_POLL_MAX_ITERATIONS)
  })

  it('rejects a non-JSON input without calling 0G', async () => {
    const image = fakeOgImage({ polls: [done()] })
    const run = createImageProducer({ image, now: clock(), sleep: instant })
    await expect(run(job, 'a plain text prompt', { giveUpAt: 1e12 })).rejects.toThrow(ImageInputError)
    expect(image.submits).toHaveLength(0)
  })

  it('never puts a key in an error', async () => {
    const image = fakeOgImage({
      submitError: new OgHttpError(401, 'invalid_api_key', undefined, 'Incorrect API key provided: sk-abcdef123'),
    })
    const run = createImageProducer({ image, now: clock(), sleep: instant })
    const err = await run(job, INPUT, { giveUpAt: 1e12 }).catch((e: unknown) => e)
    expect((err as Error).message).not.toMatch(/\b(sk|mk)-/)
  })
})
