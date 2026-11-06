import { describe, expect, it } from 'vitest'
import type { Claim, Deal, Job } from '@dusk/core'
import { encodeChatInput, escrowDeadlineSec, imageJobInput, jobAmountWei } from '@dusk/core'
import { keccak256, toHex } from 'viem'
import { runJob, tick, type Producer } from '../src/loop'
import { FAKE_WRITER, fakeDeps, fakeEscrow, type FakeDeps, type FakeEscrow } from './fakes'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const IMAGE_INPUT = imageJobInput('a red kite', '1024x1024')

async function seed(deps: FakeDeps, input: string, over: Partial<Job> = {}): Promise<Job> {
  const inputRef = await deps.swarm.upload(new TextEncoder().encode(input))
  const job: Job = {
    id: '',
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1_000n,
    maxTokens: 16,
    trustMode: 'verified',
    visibility: 'public',
    inputRef,
    inputHash: keccak256(toHex(input)),
    buyerPubkey: `0x${'22'.repeat(33)}`,
    escrowId: `0x${'33'.repeat(32)}`,
    status: 'open',
    expiresAt: deps.now() + 600_000,
    ...over,
  }
  const id = await deps.arkiv.put('job', job, { ttlSeconds: 600 })
  return { ...job, id, owner: FAKE_WRITER }
}

const seedImageJob = (deps: FakeDeps, over: Partial<Job> = {}) =>
  seed(deps, IMAGE_INPUT, { model: 'z-image-turbo', maxTokens: 1, maxPricePer1kOut: 8_000n, ...over })

async function claimFor(deps: FakeDeps, job: Job): Promise<Claim> {
  const claim = { jobId: job.id, workerId: deps.workerId, price: 1n, claimedAt: deps.now() }
  const id = await deps.arkiv.put('claim', claim, { ttlSeconds: deps.config.ttl.claim })
  return { ...claim, id }
}

async function grant(deps: FakeDeps, job: Job, escrow: FakeEscrow): Promise<void> {
  await deps.arkiv.putAs(
    FAKE_WRITER,
    'grant',
    { jobId: job.id, workerId: deps.workerId, commitAuth: escrow.authFor(FAKE_WRITER, job.escrowId, escrow.signer) },
    { ttlSeconds: deps.config.ttl.grant },
  )
}

function funded(job: Job, amount: bigint): Deal {
  return {
    buyer: FAKE_WRITER,
    worker: `0x${'00'.repeat(20)}`,
    amount,
    outputHash: `0x${'00'.repeat(32)}`,
    commitAtSec: 0,
    deadlineSec: escrowDeadlineSec(job.expiresAt),
    state: 'funded',
  }
}

const imageProducer = (bytes = JPEG): Producer & { inputs: string[] } => {
  const inputs: string[] = []
  const p: Producer = async (_job: Job, input: string) => {
    inputs.push(input)
    return {
      bytes,
      contentType: 'image/jpeg',
      modelServed: 'z-image-turbo',
      tokensIn: 0,
      tokensOut: 1,
      creditsSpent: '8800',
      latencyMs: 2200,
    }
  }
  return Object.assign(p, { inputs })
}

describe('runJob — produce seam', () => {
  it('text output hash is unchanged by the seam', async () => {
    const deps = fakeDeps()
    const job = await seed(deps, 'summarise this')
    const receipt = await runJob(deps, job, await claimFor(deps, job))
    expect(receipt.outputHash).toBe(keccak256(toHex('the answer')))
    expect(receipt.outputHash).toBe(keccak256(new TextEncoder().encode('the answer')))
    expect(receipt.creditsSpent).toBe('tokens:3/5')
  })

  it('uses deps.produce when set, and never calls the text model', async () => {
    const produce = imageProducer()
    const deps = { ...fakeDeps({ models: ['z-image-turbo'] }), produce }
    const job = await seedImageJob(deps)
    const receipt = await runJob(deps, job, await claimFor(deps, job))

    expect(deps.og.calls).toHaveLength(0)
    expect(produce.inputs).toEqual([IMAGE_INPUT])
    expect(deps.swarm.blobs.get(receipt.outputRef)).toEqual(JPEG)
    expect(receipt.outputHash).toBe(keccak256(JPEG))
    expect(receipt.tokensOut).toBe(1)
    expect(receipt.creditsSpent).toBe('8800')
    expect(receipt.modelServed).toBe('z-image-turbo')
    expect(deps.swarm.contentTypes.get(receipt.outputRef)).toBe('image/jpeg')
  })

  it('uploads text as text/plain', async () => {
    const deps = fakeDeps()
    const job = await seed(deps, 'summarise this')
    const receipt = await runJob(deps, job, await claimFor(deps, job))
    expect(deps.swarm.contentTypes.get(receipt.outputRef)).toBe('text/plain; charset=utf-8')
  })

  it('releases the claim when the producer throws', async () => {
    const deps = {
      ...fakeDeps({ models: ['z-image-turbo'] }),
      produce: (async () => {
        throw new Error('generation failed')
      }) as Producer,
    }
    const job = await seedImageJob(deps)
    const claim = await claimFor(deps, job)
    await expect(runJob(deps, job, claim)).rejects.toThrow('generation failed')
    expect(deps.arkiv.deletions).toContain(claim.id)
    expect(await deps.arkiv.query('receipt')).toHaveLength(0)
  })

  it('hands the producer a giveUpAt of expiry minus the delivery margin', async () => {
    let seen = 0
    const deps = {
      ...fakeDeps({ models: ['z-image-turbo'], deliverMarginMs: 90_000 }),
      produce: (async (_j: Job, _i: string, opts: { giveUpAt: number }) => {
        seen = opts.giveUpAt
        throw new Error('stop')
      }) as Producer,
    }
    const job = await seedImageJob(deps)
    await runJob(deps, job, await claimFor(deps, job)).catch(() => {})
    expect(seen).toBe(job.expiresAt - 90_000)
  })
})

describe('tick — image jobs and text workers', () => {
  it('a text worker never claims an image job', async () => {
    const deps = fakeDeps()
    await seedImageJob(deps)
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
    expect(await deps.arkiv.query('claim')).toHaveLength(0)
  })

  it('an image worker never claims a text job', async () => {
    const produce = imageProducer()
    const deps = { ...fakeDeps({ models: ['z-image-turbo'] }), produce }
    await seed(deps, 'summarise this')
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(produce.inputs).toHaveLength(0)
  })

  it('isFundedFor accepts an image deal funded at price × n', async () => {
    const escrow = fakeEscrow()
    const produce = imageProducer()
    const deps = { ...fakeDeps({ models: ['z-image-turbo'], escrow, pricePer1kOut: 8_000n }), produce }
    const job = await seedImageJob(deps)
    const amount = jobAmountWei(job, 8_000n, deps.config.og.imageModels)
    expect(amount).toBe(8_000n)
    escrow.deals.set(job.escrowId, funded(job, amount))
    await grant(deps, job, escrow)

    const r = await tick(deps)
    expect(r.error).toBeUndefined()
    expect(r.delivered).toBe(1)
    expect(escrow.commits[0]?.outputHash).toBe(keccak256(JPEG))
  })

  it('skips an image deal funded at the text rate (price × n / 1000)', async () => {
    const escrow = fakeEscrow()
    const produce = imageProducer()
    const deps = { ...fakeDeps({ models: ['z-image-turbo'], escrow, pricePer1kOut: 8_000n }), produce }
    const job = await seedImageJob(deps)
    escrow.deals.set(job.escrowId, funded(job, 8n))
    await grant(deps, job, escrow)

    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(produce.inputs).toHaveLength(0)
  })
})

describe('runJob — attached input', () => {
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const withImage = encodeChatInput({
    text: 'what colour?',
    attachments: [{ kind: 'image', name: 'dot.png', mime: 'image/png', data: PNG_B64 }],
  })

  it('sends a text-only job as the bare string, exactly as before', async () => {
    const deps = fakeDeps()
    const job = await seed(deps, 'summarise this')
    await runJob(deps, job, await claimFor(deps, job))
    expect(deps.og.calls[0]?.messages).toEqual([{ role: 'user', content: 'summarise this' }])
  })

  it('sends an attached image as an image_url content part', async () => {
    const deps = fakeDeps()
    const job = await seed(deps, withImage)
    await runJob(deps, job, await claimFor(deps, job))
    expect(deps.og.calls[0]?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what colour?' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        ],
      },
    ])
  })

  const CATALOG = [
    { id: '0gm-1.0-35b-a3b', inputModalities: ['text', 'image'], outputModalities: ['text'] },
    { id: 'text-only-model', inputModalities: ['text'], outputModalities: ['text'] },
  ]

  it('refuses an image on a model 0G says does not take images, before any completion, and releases', async () => {
    const deps = fakeDeps({ models: ['text-only-model'], catalog: CATALOG })
    const job = await seed(deps, withImage, { model: 'text-only-model' })
    const claim = await claimFor(deps, job)
    await expect(runJob(deps, job, claim)).rejects.toThrow(/does not take images/)
    expect(deps.og.calls).toHaveLength(0)
    expect(deps.arkiv.deletions).toContain(claim.id)
  })

  it('sends an image to any model the catalog says takes one — no configured list', async () => {
    const deps = fakeDeps({ models: ['qwen2.5-vl-72b-instruct'], catalog: [
      { id: 'qwen2.5-vl-72b-instruct', inputModalities: ['text', 'image'], outputModalities: ['text'] },
    ] })
    const job = await seed(deps, withImage, { model: 'qwen2.5-vl-72b-instruct' })
    await runJob(deps, job, await claimFor(deps, job))
    expect(deps.og.calls).toHaveLength(1)
  })

  it('lets the Router decide when the catalog cannot be read', async () => {
    const deps = fakeDeps({ models: ['some-model'], catalog: 'fail' })
    const job = await seed(deps, withImage, { model: 'some-model' })
    await runJob(deps, job, await claimFor(deps, job))
    expect(deps.og.calls).toHaveLength(1)
  })

  it('refuses an attachment that is not the image it claims to be, before any completion', async () => {
    const deps = fakeDeps()
    const fake = encodeChatInput({
      text: '',
      attachments: [{ kind: 'image', name: 'x.png', mime: 'image/png', data: btoa('<html></html>') }],
    })
    const job = await seed(deps, fake)
    await expect(runJob(deps, job, await claimFor(deps, job))).rejects.toThrow(/not an image/)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('refuses an input over the configured byte cap, before any completion', async () => {
    const deps = fakeDeps({ config: { input: { maxBytes: 100, maxAttachments: 4, maxImagePx: 1568 } } })
    const big = encodeChatInput({ text: '', attachments: [{ kind: 'text', name: 'a.txt', text: 'x'.repeat(200) }] })
    const job = await seed(deps, big)
    await expect(runJob(deps, job, await claimFor(deps, job))).rejects.toThrow(/limit is 100/)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('puts no key-shaped string in the refusal', async () => {
    const deps = fakeDeps({ models: ['text-only-model'], catalog: CATALOG })
    const job = await seed(deps, withImage, { model: 'text-only-model' })
    const err = await runJob(deps, job, await claimFor(deps, job)).catch((e: Error) => e)
    expect(String((err as Error).message)).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('trust mode', () => {
  it('asks 0G for the tier the job names, standard included', async () => {
    const deps = fakeDeps({ models: ['claude-haiku-5.5'] })
    const job = await seed(deps, 'hi', { model: 'claude-haiku-5.5', trustMode: 'standard' })
    await runJob(deps, job, await claimFor(deps, job))
    expect(deps.og.modes).toEqual(['standard'])
  })
})
