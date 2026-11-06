import { describe, expect, it } from 'vitest'
import { jobPriceWei, jobTokens, type Job } from '@dusk/core'
import { keccak256, toHex } from 'viem'
import { MODEL, setup } from './setup'

const spec = { prompt: 'summarise: the cat sat', model: MODEL, maxTokens: 64, maxPricePer1kOut: 2000n, deadlineSec: 600 }

describe('market', () => {
  it('groups live asks by model, cheapest first, and states the bid that clears them', async () => {
    const t = setup()
    await t.advertise(1500n)
    await t.advertise(900n)
    await t.advertise(4000n, ['other-model'])
    const m = await t.service.market()
    const row = m.models.find((r) => r.model === MODEL)!
    expect(row.workers).toBe(2)
    expect(row.minPricePer1kOut).toBe('900')
    expect(row.maxPricePer1kOut).toBe('1500')
    expect(row.configured).toBe(true)
    expect(m.models.map((r) => r.model)).toContain('other-model')
  })

  it('lists configured models even when nobody advertises them', async () => {
    const m = await setup().service.market()
    expect(m.models).toEqual([expect.objectContaining({ model: MODEL, workers: 0, configured: true })])
  })
})

describe('submit', () => {
  it('refuses a bid below every live ask before any money moves', async () => {
    const t = setup()
    await t.advertise(5000n)
    await expect(t.service.submit(spec)).rejects.toThrow(/5000/)
    expect(t.escrow!.funded).toHaveLength(0)
    expect(t.arkiv.all('job')).toHaveLength(0)
  })

  it('refuses an empty market unless the caller opts in', async () => {
    const t = setup()
    await expect(t.service.submit(spec)).rejects.toThrow(/nobody/i)
    const posted = await t.service.submit({ ...spec, requireLiveWorker: false })
    expect(posted.jobId).toBeTruthy()
  })

  it('refuses parameters over the operator caps', async () => {
    const t = setup()
    await t.advertise(100n)
    await expect(t.service.submit({ ...spec, maxTokens: 5000 })).rejects.toThrow(/max_tokens/)
    await expect(t.service.submit({ ...spec, maxPricePer1kOut: 10n ** 9n })).rejects.toThrow(/max_price/)
    await expect(t.service.submit({ ...spec, deadlineSec: 7200 })).rejects.toThrow(/deadline/)
    await expect(t.service.submit({ ...spec, model: 'z-image-turbo' })).rejects.toThrow(/image/)
    expect(t.escrow!.funded).toHaveLength(0)
  })

  it('applies the escrow cap to the prompt-inclusive amount postJob funds', async () => {
    const t = setup({ maxEscrowWei: 130n })
    await t.advertise(1000n)
    await expect(t.service.submit(spec)).rejects.toThrow(/per-job cap/)
    expect(t.escrow!.funded).toHaveLength(0)
  })

  it('posts private by default, funds the deal, and starts authorising claimants', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit(spec)
    expect(posted.visibility).toBe('private')
    const expected = jobPriceWei(2000n, jobTokens({ maxTokens: 64, inputChars: spec.prompt.length }))
    expect(posted.escrowWei).toBe(String(expected))
    expect(expected).toBeGreaterThan(128n)
    expect(t.escrow!.funded).toHaveLength(1)
    const job = t.arkiv.all<Job>('job')[0]!
    expect(job.inputRef).toBeUndefined()
    expect(job.trustMode).toBe('standard')
    expect(t.authorised).toHaveLength(1)
    expect(t.authorised[0]!.encryptedRef).toBeTruthy()
  })
})

describe('result', () => {
  it('reports pending, then returns the verified, unsealed answer', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit(spec)
    expect((await t.service.result(posted.jobId, 0)).status).toBe('pending')

    const job = t.arkiv.all<Job>('job')[0]!
    await t.deliver(job, 'The cat sat.')
    const r = await t.service.result(posted.jobId, 0)
    expect(r).toMatchObject({ status: 'delivered', output: 'The cat sat.', verified: 'escrow-commit', tokensOut: 5 })
  })

  it('removes the job entity from Arkiv once the answer is verified and collected', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit(spec)
    await t.service.result(posted.jobId, 0)
    expect(t.arkiv.all<Job>('job').map((j) => j.id)).toEqual([posted.jobId])

    await t.deliver(t.arkiv.all<Job>('job')[0]!, 'The cat sat.')
    expect((await t.service.result(posted.jobId, 0)).status).toBe('delivered')
    expect(t.arkiv.all<Job>('job')).toEqual([])
    expect(t.arkiv.deletions).toContain(posted.jobId)
  })

  it('keeps the job entity listed while the only receipt is unverified', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit({ ...spec, visibility: 'public' })
    await t.deliver(t.arkiv.all<Job>('job')[0]!, 'forged', { commitHash: keccak256(toHex('the real answer')) })
    await t.service.result(posted.jobId, 0)
    expect(t.arkiv.all<Job>('job').map((j) => j.id)).toEqual([posted.jobId])
  })

  it('waits up to wait_seconds for the receipt', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit({ ...spec, visibility: 'public' })
    const job = t.arkiv.all<Job>('job')[0]!
    let polls = 0
    const orig = t.arkiv.query.bind(t.arkiv)
    t.arkiv.query = async (kind, filter) => {
      if (kind === 'receipt' && ++polls === 3) await t.deliver(job, 'late answer')
      return orig(kind, filter)
    }
    const r = await t.service.result(posted.jobId, 30)
    expect(r).toMatchObject({ status: 'delivered', output: 'late answer' })
  })

  it('ignores a receipt whose hash the chain never committed to', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit({ ...spec, visibility: 'public' })
    const job = t.arkiv.all<Job>('job')[0]!
    await t.deliver(job, 'forged', { commitHash: keccak256(toHex('the real answer')) })
    expect((await t.service.result(posted.jobId, 0)).status).toBe('pending')
  })

  it('says expired, with the reclaim path, once the deadline passes undelivered', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit(spec)
    t.tick(601_000)
    const r = await t.service.result(posted.jobId, 0)
    expect(r.status).toBe('expired')
    expect(JSON.stringify(r)).toMatch(/reclaim/)
  })

  it('without escrow, accepts a receipt whose bytes match its own hash', async () => {
    const t = setup({ escrow: false })
    await t.advertise(1000n)
    const posted = await t.service.submit({ ...spec, visibility: 'public' })
    await t.deliver(t.arkiv.all<Job>('job')[0]!, 'free answer')
    expect(await t.service.result(posted.jobId, 0)).toMatchObject({ status: 'delivered', verified: 'hash-only' })
  })

  it('never returns key material in a pending or listed job', async () => {
    const t = setup()
    await t.advertise(1000n)
    const posted = await t.service.submit(spec)
    const text = JSON.stringify([posted, await t.service.result(posted.jobId, 0), t.service.jobs()])
    expect(text).not.toMatch(/\b(sk|mk)-/)
    expect(text).not.toContain(t.authorised[0]!.encryptedRef!)
  })
})
