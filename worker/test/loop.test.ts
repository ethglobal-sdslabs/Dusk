import { describe, expect, it, vi } from 'vitest'
import type { Claim, Deal, Grant, Job, Receipt, TeeProof, WorkerAd } from '@dusk/core'
import type { Address } from 'viem'
import { escrowDeadlineSec, jobPriceWei } from '@dusk/core'
import { keccak256, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { seal, unseal, UnsealError } from '@dusk/crypto'
import { claimJob, heartbeat, runJob, runWorker, settleDue, tick } from '../src/loop'
import { ArkivQuotaError } from '@dusk/arkiv'
import {
  FAKE_WRITER,
  fakeArkiv,
  fakeDeps,
  fakeEscrow,
  revert,
  type FakeDeps,
  type FakeEscrow,
} from './fakes'

const JOB_INPUT = 'summarise this'

const dump = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))

async function seedJob(deps: FakeDeps, over: Partial<Job> = {}): Promise<Job> {
  const inputRef = await deps.swarm.upload(new TextEncoder().encode(JOB_INPUT))
  const job: Job = {
    id: '',
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1_000n,
    maxTokens: 16,
    trustMode: 'verified',
    visibility: 'public',
    inputRef,
    inputHash: keccak256(toHex(JOB_INPUT)),
    buyerPubkey: `0x${'22'.repeat(33)}`,
    escrowId: `0x${'33'.repeat(32)}`,
    status: 'open',
    expiresAt: deps.now() + 600_000,
    ...over,
  }
  const id = await deps.arkiv.put('job', job, { ttlSeconds: 600 })
  return { ...job, id, owner: FAKE_WRITER }
}

async function seedAuthGrant(
  deps: FakeDeps,
  job: Job,
  escrow: FakeEscrow,
  over: Partial<Grant> = {},
): Promise<string> {
  const owner = job.owner ?? FAKE_WRITER
  return deps.arkiv.putAs(
    owner,
    'grant',
    {
      jobId: job.id,
      workerId: deps.workerId,
      commitAuth: escrow.authFor(owner, job.escrowId, escrow.signer),
      ...over,
    },
    { ttlSeconds: deps.config.ttl.grant },
  )
}

async function seedJobAs(
  deps: FakeDeps,
  owner: Address,
  over: Partial<Job> = {},
): Promise<Job> {
  const base = await seedJob(deps, over)
  await deps.arkiv.del(base.id)
  const id = await deps.arkiv.putAs(owner, 'job', base, { ttlSeconds: 600 })
  return { ...base, id, owner }
}

describe('heartbeat', () => {
  it('advertises a coarse bucket, never an exact balance', async () => {
    const deps = fakeDeps({ balance: { creditBalance: '7' }, dayStartCredits: 100n })
    await heartbeat(deps)
    const [ad] = deps.arkiv.all<WorkerAd>('worker')
    expect(ad!.creditsBucket).toBe('<10%')
    expect(dump(ad)).not.toContain('"7"')
  })

  it('advertises only the models it was told it can serve', async () => {
    const deps = fakeDeps({ models: ['served-model'] })
    await heartbeat(deps)
    expect(deps.arkiv.all<WorkerAd>('worker')[0]!.models).toEqual(['served-model'])
  })

  it('publishes one ad and does not touch the chain again while it is fresh', async () => {
    const deps = fakeDeps()
    const first = await heartbeat(deps)
    expect(await heartbeat(deps)).toBe(first)
    expect(await heartbeat(deps)).toBe(first)
    expect(deps.arkiv.all<WorkerAd>('worker')).toHaveLength(1)
    expect(deps.arkiv.extensions).toHaveLength(0)
  })

  it('renews the same ad once it is past half its TTL', async () => {
    let t = 1_000
    const deps = fakeDeps({ now: () => t })
    const first = await heartbeat(deps)
    t += (deps.config.ttl.worker / 2 + 1) * 1000
    expect(await heartbeat(deps)).toBe(first)
    expect(deps.arkiv.extensions.filter((e) => e.id === first)).toHaveLength(1)
    expect(deps.arkiv.all<WorkerAd>('worker')).toHaveLength(1)
  })

  it('writes a fresh ad if the old one expired while the worker was idle', async () => {
    let t = 1_000
    const deps = fakeDeps({ now: () => t })
    const first = await heartbeat(deps)
    t += (deps.config.ttl.worker + 10) * 1000
    const second = await heartbeat(deps)
    expect(second).not.toBe(first)
  })

  it('never writes an api key into the ad', async () => {
    const deps = fakeDeps()
    await heartbeat(deps)
    expect(dump(deps.arkiv.all<WorkerAd>('worker'))).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('claimJob', () => {
  it('writes a claim and wins when it is the only one', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = await claimJob(deps, job)
    expect(claim?.jobId).toBe(job.id)
    expect(deps.arkiv.all<Claim>('claim')).toHaveLength(1)
  })

  it('yields to an older claim and removes its own', async () => {
    const deps = fakeDeps({ now: () => 5_000 })
    const job = await seedJob(deps)
    await deps.arkiv.put(
      'claim',
      { jobId: job.id, workerId: `0x${'bb'.repeat(32)}`, price: 1n, claimedAt: 1_000 },
      { ttlSeconds: 90 },
    )
    expect(await claimJob(deps, job)).toBeNull()
    const mine = deps.arkiv.all<Claim>('claim').filter((c) => c.workerId === deps.workerId)
    expect(mine).toHaveLength(0)
    expect(deps.arkiv.deletions).toHaveLength(1)
  })

  it('lets exactly one of two workers tied on claimedAt win', async () => {
    const shared = fakeArkiv(() => 1_000)
    const a = fakeDeps({ arkiv: shared, workerId: `0x${'a1'.repeat(32)}`, now: () => 1_000 })
    const b = fakeDeps({ arkiv: shared, workerId: `0x${'b2'.repeat(32)}`, now: () => 1_000 })
    const job = await seedJob(a)
    const results = [await claimJob(a, job), await claimJob(b, job)]
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('runJob', () => {
  it('refuses to deliver a substituted model, even with no escrow configured', async () => {
    const deps = fakeDeps({ completion: { modelServed: 'substitute-model' } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await expect(runJob(deps, job, claim)).rejects.toThrow(/served substitute-model/)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
  })

  it('records the served model on the receipt when it matches the request', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    const r = await runJob(deps, job, claim)
    expect(r.modelServed).toBe(job.model)
  })

  it('sends the job input from swarm to the model', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await runJob(deps, job, claim)
    expect(deps.og.calls[0]!.messages.at(-1)!.content).toContain(JOB_INPUT)
  })

  it('uploads the output so the receipt ref downloads back to it', async () => {
    const deps = fakeDeps({ completion: { text: 'the answer' } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    const r = await runJob(deps, job, claim)
    expect(new TextDecoder().decode(await deps.swarm.download(r.outputRef))).toBe('the answer')
  })

  it('refuses to deliver an empty completion and writes no receipt', async () => {
    const deps = fakeDeps({ completion: { text: '   ' } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await expect(runJob(deps, job, claim)).rejects.toThrow()
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
  })

  it('does not spend a swarm upload on an empty completion', async () => {
    const deps = fakeDeps({ completion: { text: '' } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    const before = deps.swarm.uploads.length
    await expect(runJob(deps, job, claim)).rejects.toThrow()
    expect(deps.swarm.uploads).toHaveLength(before)
  })

  it('releases the claim when the completion fails, so another worker can take it', async () => {
    const deps = fakeDeps({ completionError: new Error('provider_error') })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await expect(runJob(deps, job, claim)).rejects.toThrow()
    expect(deps.arkiv.deletions).toContain(claim.id)
  })

  it('renews the claim while a slow job runs', async () => {
    const deps = fakeDeps({ completionDelayMs: 1_200, config: { ttl: { worker: 120, claim: 2, grant: 300, receipt: 604800 } } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await runJob(deps, job, claim)
    expect(deps.arkiv.extensions.filter((e) => e.id === claim.id).length).toBeGreaterThanOrEqual(1)
  })

  it('stops renewing once the job finishes', async () => {
    const deps = fakeDeps({ completionDelayMs: 1_200, config: { ttl: { worker: 120, claim: 2, grant: 300, receipt: 604800 } } })
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    await runJob(deps, job, claim)
    const before = deps.arkiv.extensions.length
    expect(before).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 1_500))
    expect(deps.arkiv.extensions.length).toBe(before)
    
  })

  it('never writes an api key into the receipt', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    expect(dump(await runJob(deps, job, claim))).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('runJob — escrow commit', () => {
  function fundedDeal(deps: FakeDeps, job: Job, over: Partial<Deal> = {}): Deal {
    return {
      buyer: FAKE_WRITER,
      worker: `0x${'00'.repeat(20)}`,
      amount: jobPriceWei(deps.pricePer1kOut, job.maxTokens),
      outputHash: `0x${'00'.repeat(32)}`,
      commitAtSec: 0,
      deadlineSec: escrowDeadlineSec(job.expiresAt),
      state: 'funded',
      ...over,
    }
  }

  it('commits the receipt output hash, after the swarm upload and before the receipt', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!

    const order: string[] = []
    const upload = deps.swarm.upload.bind(deps.swarm)
    deps.swarm.upload = (async (...args: Parameters<typeof upload>) => {
      const r = await upload(...args)
      order.push('upload')
      return r
    }) as typeof deps.swarm.upload
    const commit = escrow.commit.bind(escrow)
    escrow.commit = (async (...args: Parameters<typeof commit>) => {
      const r = await commit(...args)
      order.push('commit')
      return r
    }) as typeof escrow.commit
    const put = deps.arkiv.put.bind(deps.arkiv)
    deps.arkiv.put = (async (...args: Parameters<typeof put>) => {
      const r = await put(...args)
      if (args[0] === 'receipt') order.push('receipt')
      return r
    }) as typeof deps.arkiv.put

    const receipt = await runJob(deps, job, claim)

    expect(escrow.commits[0]).toEqual({ jobId: job.escrowId, outputHash: receipt.outputHash })
    expect(order).toEqual(['upload', 'commit', 'receipt'])
  })

  it('writes no receipt when commit reverts NotFunded — another worker won the race', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!
    escrow.failNext('commit', revert('NotFunded'))

    await expect(runJob(deps, job, claim)).rejects.toThrow(/NotFunded/)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
  })

  it('releases the claim when commit is refused, so the job looks free immediately', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!
    escrow.failNext('commit', revert('NotFunded'))

    await expect(runJob(deps, job, claim)).rejects.toThrow()
    expect(deps.arkiv.deletions).toContain(claim.id)
  })

  it('says in the tick error that the completion was billed and the race lost', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    escrow.failNext('commit', revert('NotFunded'))

    const r = await tick(deps)
    expect(r.error).toMatch(/billed/)
  })

  it('commits nothing when the completion is not deliverable', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow, completion: { text: '' } })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!

    await expect(runJob(deps, job, claim)).rejects.toThrow()
    expect(escrow.commits).toHaveLength(0)
  })

  it('delivers nothing when 0G served a different model than the job asked for', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow, completion: { modelServed: 'some-other-model' } })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!

    await expect(runJob(deps, job, claim)).rejects.toThrow(/served some-other-model/i)
    expect(deps.og.calls).toHaveLength(1)
    expect(escrow.commits).toHaveLength(0)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
  })

  it('ignores a grant addressed to another worker, and spends nothing finding out', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({
      escrow,
      now: () => Date.now(),
      config: { ttl: { worker: 120, claim: 2, grant: 300, receipt: 604_800 } },
    })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    const claim = (await claimJob(deps, job))!
    await seedAuthGrant(deps, job, escrow, { workerId: `0x${'ee'.repeat(32)}` })

    await expect(runJob(deps, job, claim)).rejects.toThrow(/no usable grant from its buyer/i)

    expect(deps.og.calls).toHaveLength(0)
    expect(escrow.commits).toHaveLength(0)
  })

  it('refuses a grant whose commitAuth the chain would reject, before spending a credit', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({
      escrow,
      now: () => Date.now(),
      config: { ttl: { worker: 120, claim: 2, grant: 300, receipt: 604_800 } },
    })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    const claim = (await claimJob(deps, job))!
    const owner = job.owner ?? FAKE_WRITER
    await seedAuthGrant(deps, job, escrow, {
      commitAuth: escrow.authFor(owner, `0x${'ab'.repeat(32)}`, escrow.signer),
    })

    await expect(runJob(deps, job, claim)).rejects.toThrow(/would refuse.*NotAuthorised/i)

    expect(deps.og.calls).toHaveLength(0)
    expect(escrow.commits).toHaveLength(0)
  })

  it('still delivers and receipts with no escrow configured, as at Gate 1', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!

    const r = await runJob(deps, job, claim)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(1)
    expect(r.outputHash).toBe(deps.arkiv.all<Receipt>('receipt')[0]!.outputHash)
  })

  it('logs the escrow id on an ambiguous (non-revert) commit failure, and still releases the claim', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!
    escrow.failNext('commit', new Error('timed out waiting for receipt'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runJob(deps, job, claim)).rejects.toThrow()

    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
    expect(deps.arkiv.deletions).toContain(claim.id)
    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain(job.escrowId)
    errorSpy.mockRestore()
  })

  it('logs the committed escrow id when the receipt write fails after a successful commit', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const claim = (await claimJob(deps, job))!
    const put = deps.arkiv.put.bind(deps.arkiv)
    deps.arkiv.put = (async (...args: Parameters<typeof put>) => {
      if (args[0] === 'receipt') throw new Error('arkiv put: fetch failed')
      return put(...args)
    }) as typeof deps.arkiv.put
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runJob(deps, job, claim)).rejects.toThrow(/fetch failed/)

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain(job.escrowId)
    expect(logged).toContain(escrow.commits[0]!.outputHash)
    expect(logged).toMatch(/settle/i)
    expect(deps.arkiv.deletions).toContain(claim.id)
    errorSpy.mockRestore()
  })

  it('logs no escrow recovery line when a receipt write fails with no escrow configured', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    const claim = (await claimJob(deps, job))!
    const put = deps.arkiv.put.bind(deps.arkiv)
    deps.arkiv.put = (async (...args: Parameters<typeof put>) => {
      if (args[0] === 'receipt') throw new Error('arkiv put: fetch failed')
      return put(...args)
    }) as typeof deps.arkiv.put
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runJob(deps, job, claim)).rejects.toThrow(/fetch failed/)

    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).not.toMatch(/withdraw/i)
    errorSpy.mockRestore()
  })
})

describe('tick', () => {
  it('ignores a job whose model it cannot serve', async () => {
    const deps = fakeDeps({ models: ['other-model'] })
    await seedJob(deps, { model: 'unservable' })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('ignores a job priced below its own price', async () => {
    const deps = fakeDeps({ pricePer1kOut: 1_000n })
    await seedJob(deps, { maxPricePer1kOut: 10n })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('ignores a job that has already outlived its own expiry', async () => {
    const deps = fakeDeps({ now: () => 10_000 })
    await seedJob(deps, { expiresAt: 5_000 })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('claims and delivers a job it can serve', async () => {
    const deps = fakeDeps()
    await seedJob(deps)
    const result = await tick(deps)
    expect(result).toEqual({ claimed: 1, delivered: 1, settled: 0 })
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(1)
  })

  it('skips a job another worker already holds a live claim on', async () => {
    const deps = fakeDeps()
    const job = await seedJob(deps)
    await deps.arkiv.put(
      'claim',
      { jobId: job.id, workerId: `0x${'cc'.repeat(32)}`, price: 1n, claimedAt: 0 },
      { ttlSeconds: 90 },
    )
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('surfaces why a claimed job was not delivered', async () => {
    const deps = fakeDeps({ completionError: new Error('provider_error upstream') })
    await seedJob(deps)
    const r = await tick(deps)
    expect(r).toMatchObject({ claimed: 1, delivered: 0 })
    expect(r.error).toContain('provider_error upstream')
  })

  describe('a billed attempt that fails is not retried by the same worker', () => {
    it('after the output upload fails, it does not claim or bill the job again', async () => {
      let t = 1_000
      const deps = fakeDeps({ now: () => t })
      await seedJob(deps)
      const upload = deps.swarm.upload
      deps.swarm.upload = async () => {
        throw new Error('swarm 503')
      }

      expect(await tick(deps)).toMatchObject({ claimed: 1, delivered: 0 })
      expect(deps.og.calls).toHaveLength(1)

      deps.swarm.upload = upload
      t += 5_000
      expect((await tick(deps)).claimed).toBe(0)
      t += 200_000
      expect((await tick(deps)).claimed).toBe(0)
      expect(deps.og.calls).toHaveLength(1)
    })

    it('after the completion itself throws, it does not bill the job again', async () => {
      let t = 1_000
      const deps = fakeDeps({ now: () => t, completionError: new Error('signature fetch failed') })
      await seedJob(deps)

      expect(await tick(deps)).toMatchObject({ claimed: 1, delivered: 0 })
      t += 5_000
      expect((await tick(deps)).claimed).toBe(0)
      expect(deps.og.calls).toHaveLength(1)
    })

    it('still releases the claim, so another worker can serve the job', async () => {
      const shared = fakeArkiv(() => 1_000)
      const first = fakeDeps({ arkiv: shared, completionError: new Error('provider_error') })
      await seedJob(first)
      expect(await tick(first)).toMatchObject({ claimed: 1, delivered: 0 })

      const second = fakeDeps({ arkiv: shared, swarm: first.swarm, workerId: `0x${'b2'.repeat(32)}` })
      expect(await tick(second)).toMatchObject({ claimed: 1, delivered: 1 })
    })
  })

  it('reports no error on a clean delivery', async () => {
    const deps = fakeDeps()
    await seedJob(deps)
    expect((await tick(deps)).error).toBeUndefined()
  })

  it('does not re-run a job that already has a receipt', async () => {
    let t = 1_000
    const deps = fakeDeps({ now: () => t })
    await seedJob(deps)

    expect(await tick(deps)).toEqual({ claimed: 1, delivered: 1, settled: 0 })
    expect(deps.og.calls).toHaveLength(1)

    t += 92_000
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(1)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(1)
  })

  it('lets a second worker take a job whose claim TTL expired', async () => {
    const shared = fakeArkiv(() => 1_000)
    const dead = fakeDeps({ arkiv: shared, workerId: `0x${'d1'.repeat(32)}`, now: () => 1_000 })
    const job = await seedJob(dead)
    expect(await claimJob(dead, job)).not.toBeNull()

    const t = 1_000 + 91_000
    const fresh = fakeDeps({
      arkiv: fakeArkiv(() => t),
      workerId: `0x${'f2'.repeat(32)}`,
      now: () => t,
    })
    fresh.arkiv.rows.push(...shared.rows)
    expect(await claimJob(fresh, job)).not.toBeNull()
  })
})

describe('tick — funding and delivery margin', () => {
  function fundedDeal(deps: FakeDeps, job: Job, over: Partial<Deal> = {}): Deal {
    return {
      buyer: FAKE_WRITER,
      worker: `0x${'00'.repeat(20)}`,
      amount: jobPriceWei(deps.pricePer1kOut, job.maxTokens),
      outputHash: `0x${'00'.repeat(32)}`,
      commitAtSec: 0,
      deadlineSec: escrowDeadlineSec(job.expiresAt),
      state: 'funded',
      ...over,
    }
  }

  it('skips a job whose deal was never funded, without spending a completion', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    await seedJob(deps)
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('writes a receipt naming the address the chain will actually pay', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)

    const r = await tick(deps)
    expect(r.delivered).toBe(1)

    const [receipt] = deps.arkiv.all<Receipt>('receipt')
    expect(receipt!.worker.toLowerCase()).toBe(escrow.signer.toLowerCase())
    const deal = await escrow.deal(job.escrowId)
    expect(deal.worker.toLowerCase()).toBe(receipt!.worker.toLowerCase())
  })

  describe('a forged receipt cannot hide a funded job', () => {
    const griefer: Address = `0x${'9e'.repeat(20)}`

    it('serves a funded job even when a stranger wrote a receipt for it', async () => {
      const escrow = fakeEscrow()
      const deps = fakeDeps({ escrow })
      const job = await seedJob(deps)
      escrow.deals.set(job.escrowId, fundedDeal(deps, job))
      await seedAuthGrant(deps, job, escrow)

      await deps.arkiv.putAs(
        griefer,
        'receipt',
        {
          jobId: job.id,
          worker: griefer,
          modelServed: job.model,
          outputHash: `0x${'5c'.repeat(32)}`,
          trustMode: 'verified',
          escrowId: job.escrowId,
          outputRef: 'de'.repeat(32),
          creditsSpent: 'tokens:1/1',
          latencyMs: 10,
        },
        { ttlSeconds: 604_800 },
      )

      const r = await tick(deps)
      expect(r.delivered).toBe(1)
    })

    it('still skips a job whose deal the chain says is already committed', async () => {
      const escrow = fakeEscrow()
      const deps = fakeDeps({ escrow })
      const job = await seedJob(deps)
      escrow.deals.set(job.escrowId, fundedDeal(deps, job, { state: 'committed' }))

      const r = await tick(deps)
      expect(r.claimed).toBe(0)
      expect(deps.og.calls).toHaveLength(0)
    })

    it('without escrow, ignores a receipt whose output hash is zero', async () => {
      const deps = fakeDeps()
      const job = await seedJob(deps)
      await deps.arkiv.putAs(
        griefer,
        'receipt',
        {
          jobId: job.id,
          worker: griefer,
          modelServed: job.model,
          outputHash: `0x${'00'.repeat(32)}`,
          trustMode: 'verified',
          escrowId: job.escrowId,
          outputRef: 'nonsense',
          creditsSpent: '0',
          latencyMs: 0,
        },
        { ttlSeconds: 604_800 },
      )

      const r = await tick(deps)
      expect(r.delivered).toBe(1)
    })

    it('without escrow, still honours a real receipt from a previous tick', async () => {
      const deps = fakeDeps()
      const job = await seedJob(deps)

      const first = await tick(deps)
      expect(first.delivered).toBe(1)

      for (const c of deps.arkiv.all<Claim>('claim')) await deps.arkiv.del(c.id)
      const second = await tick(deps)

      expect(second.claimed).toBe(0)
      expect(deps.og.calls).toHaveLength(1)
    })
  })

  it('skips a job funded below its own advertised price', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job, { amount: 0n }))
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('asks Arkiv only for the claims on the job it is considering', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)

    await tick(deps)

    const claimQueries = deps.arkiv.queries.filter((q) => q.kind === 'claim')
    expect(claimQueries.length).toBeGreaterThan(0)
    for (const q of claimQueries) expect(q.filter).toBeDefined()
  })

  it('skips a job already committed by another worker', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job, { state: 'committed' }))
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('will not serve a job that reuses someone else’s escrow id', async () => {
    const attacker: Address = `0x${'ba'.repeat(20)}`
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })

    const victim = await seedJob(deps)
    escrow.deals.set(victim.escrowId, fundedDeal(deps, victim))

    const stolen = await seedJobAs(deps, attacker, {
      escrowId: victim.escrowId,
      maxTokens: 1,
      expiresAt: victim.expiresAt - 60_000,
    })
    await deps.arkiv.del(victim.id)

    const r = await tick(deps)

    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
    expect(escrow.commits).toHaveLength(0)
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(0)
    expect(stolen.owner).toBe(attacker)
  })

  it('skips a job whose on-chain deadline undercuts the entity expiry', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(
      job.escrowId,
      fundedDeal(deps, job, { deadlineSec: escrowDeadlineSec(job.expiresAt) - 1 }),
    )
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('does not claim when the funding read itself fails — unknown is not funded', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    escrow.deal = async () => {
      throw new Error('rpc blip')
    }
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('refuses a job inside the delivery margin, because commit would revert DeadlinePassed', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow, now: () => 1_000 })
    const job = await seedJob(deps, { expiresAt: deps.now() + 5_000 })
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('treats a job with exactly the margin remaining as too late to start', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow, now: () => 1_000 })
    const job = await seedJob(deps, { expiresAt: deps.now() + deps.deliverMarginMs })
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    const r = await tick(deps)
    expect(r.claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('takes the same job when it has room to finish', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow, now: () => 1_000 })
    const job = await seedJob(deps, { expiresAt: deps.now() + deps.deliverMarginMs + 1 })
    escrow.deals.set(job.escrowId, fundedDeal(deps, job))
    await seedAuthGrant(deps, job, escrow)
    const r = await tick(deps)
    expect(r).toEqual({ claimed: 1, delivered: 1, settled: 0 })
  })

  it('claims an unfunded job when no escrow is configured, as at Gate 1', async () => {
    const deps = fakeDeps()
    await seedJob(deps)
    expect((await tick(deps)).delivered).toBe(1)
  })
})

describe('settleDue / tick — collecting money', () => {
  async function seedReceipt(
    deps: FakeDeps,
    job: Job,
    over: Partial<Receipt> = {},
  ): Promise<Receipt> {
    const receipt: Omit<Receipt, 'id'> = {
      jobId: job.id,
      escrowId: job.escrowId,
      worker: deps.payout,
      modelServed: job.model,
      creditsSpent: 'tokens:1/1',
      tokensIn: 1,
      tokensOut: 1,
      outputRef: 'a'.repeat(64),
      outputHash: `0x${'aa'.repeat(32)}`,
      latencyMs: 10,
      trustMode: 'verified',
      ...over,
    }
    const id = await deps.arkiv.put('receipt', receipt, { ttlSeconds: deps.config.ttl.receipt })
    return { ...receipt, id }
  }

  function committedDeal(
    escrow: FakeEscrow,
    job: Job,
    commitAtSec: number,
    over: Partial<Deal> = {},
  ): Deal {
    return {
      buyer: FAKE_WRITER,
      worker: escrow.signer,
      amount: jobPriceWei(1n, job.maxTokens),
      outputHash: `0x${'aa'.repeat(32)}`,
      commitAtSec,
      deadlineSec: escrowDeadlineSec(job.expiresAt),
      state: 'committed',
      ...over,
    }
  }

  it('withdraws a committed deal in the same second it was committed', async () => {
    const t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, committedDeal(escrow, job, Math.floor(t / 1000)))
    await seedReceipt(deps, job)

    const r = await tick(deps)
    expect(escrow.settlements).toContain(job.escrowId)
    expect(r.settled).toBe(1)
  })

  it('settles only deals that will pay this worker', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(
      job.escrowId,
      committedDeal(escrow, job, Math.floor(t / 1000), { worker: `0x${'99'.repeat(20)}` }),
    )
    await seedReceipt(deps, job)

    t += 61_000
    const r = await tick(deps)
    expect(escrow.settlements).toHaveLength(0)
    expect(r.settled).toBe(0)
  })

  it('ignores a receipt belonging to a different payout, even though the fake would return it', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, committedDeal(escrow, job, Math.floor(t / 1000)))
    await seedReceipt(deps, job, { worker: `0x${'88'.repeat(20)}` })

    t += 61_000
    const r = await tick(deps)
    expect(escrow.settlements).toHaveLength(0)
    expect(r.settled).toBe(0)
  })

  it('tolerates a settled deal rather than throwing out of tick', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, committedDeal(escrow, job, Math.floor(t / 1000)))
    await seedReceipt(deps, job)
    escrow.failNext('settle', revert('NotCommitted'))

    t += 61_000
    await expect(tick(deps)).resolves.toMatchObject({ settled: 0 })
  })

  it('tolerates a deal that reads refunded rather than committed', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(
      job.escrowId,
      committedDeal(escrow, job, Math.floor(t / 1000), { state: 'refunded', amount: 0n }),
    )
    await seedReceipt(deps, job)

    t += 61_000
    const r = await tick(deps)
    expect(escrow.settlements).toHaveLength(0)
    expect(r.settled).toBe(0)
  })

  it('tolerates one receipt\'s deal() read failing without blocking an unrelated claim', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })

    const staleJob = await seedJob(deps, { escrowId: `0x${'ab'.repeat(32)}` })
    await seedReceipt(deps, staleJob)
    const realDeal = escrow.deal.bind(escrow)
    escrow.deal = (async (jobId: `0x${string}`) => {
      if (jobId === staleJob.escrowId) throw new Error('rpc blip')
      return realDeal(jobId)
    }) as typeof escrow.deal

    const job = await seedJob(deps, { escrowId: `0x${'cd'.repeat(32)}` })
    escrow.deals.set(job.escrowId, {
      buyer: FAKE_WRITER,
      worker: `0x${'00'.repeat(20)}`,
      amount: jobPriceWei(deps.pricePer1kOut, job.maxTokens),
      outputHash: `0x${'00'.repeat(32)}`,
      commitAtSec: 0,
      deadlineSec: escrowDeadlineSec(job.expiresAt),
      state: 'funded',
    })
    await seedAuthGrant(deps, job, escrow)

    const r = await tick(deps)
    expect(r.delivered).toBe(1)
  })

  it('tolerates the settle pass failing outright — a rejected receipt query', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    const realQuery = deps.arkiv.query.bind(deps.arkiv)
    let receiptQueries = 0
    deps.arkiv.query = (async (kind: Parameters<typeof realQuery>[0], filter?: unknown) => {
      if (kind === 'receipt' && receiptQueries++ === 0) {
        throw new Error('arkiv index unavailable')
      }
      return realQuery(kind, filter as never)
    }) as typeof deps.arkiv.query

    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, {
      buyer: FAKE_WRITER,
      worker: `0x${'00'.repeat(20)}`,
      amount: jobPriceWei(deps.pricePer1kOut, job.maxTokens),
      outputHash: `0x${'00'.repeat(32)}`,
      commitAtSec: 0,
      deadlineSec: escrowDeadlineSec(job.expiresAt),
      state: 'funded',
    })
    await seedAuthGrant(deps, job, escrow)

    const r = await tick(deps)
    expect(r.settled).toBe(0)
    expect(r.delivered).toBe(1)
  })

  it('does not re-read every receipt on every tick', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, committedDeal(escrow, job, Math.floor(t / 1000)))
    await seedReceipt(deps, job)
    t += 61_000

    await tick(deps)
    const n = escrow.reads
    expect(n).toBeGreaterThan(0)

    await deps.arkiv.del(job.id)

    await tick(deps)
    expect(escrow.reads).toBe(n)

    t += 31_000
    await tick(deps)
    expect(escrow.reads).toBeGreaterThan(n)
  })

  it('does nothing when no escrow is configured, as at Gate 1', async () => {
    const deps = fakeDeps()
    expect(await settleDue(deps)).toBe(0)
  })

  it('stays quiet about a terminal revert like NotCommitted', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, committedDeal(escrow, job, Math.floor(t / 1000)))
    await seedReceipt(deps, job)
    escrow.failNext('settle', revert('NotCommitted'))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    t += 61_000
    expect(await settleDue(deps)).toBe(0)

    expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('NotCommitted')
    logSpy.mockRestore()
  })

  it('attributes a failing deal() read to the read, not to a withdraw that never happened', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    await seedReceipt(deps, job)
    escrow.deal = (async () => {
      throw new Error('rpc blip')
    }) as typeof escrow.deal
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    t += 61_000
    expect(await settleDue(deps)).toBe(0)

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain(job.escrowId)
    expect(logged).toMatch(/could not read deal/)
    expect(logged).not.toMatch(/withdraw outcome unknown/)
    errorSpy.mockRestore()
  })

  it('skips a receipt with no escrowId instead of reading deal(undefined)', async () => {
    let t = 1_000
    const now = () => t
    const escrow = fakeEscrow({ now })
    const deps = fakeDeps({ escrow, now })
    const job = await seedJob(deps)
    await seedReceipt(deps, job, { escrowId: undefined as unknown as Receipt['escrowId'] })

    t += 61_000
    expect(await settleDue(deps)).toBe(0)
    expect(escrow.reads).toBe(0)
  })

  it('says so when the settle pass fails outright rather than reporting a silent zero', async () => {
    const escrow = fakeEscrow()
    const deps = fakeDeps({ escrow })
    deps.arkiv.query = (async () => {
      throw new Error('wrong contract address')
    }) as typeof deps.arkiv.query
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await settleDue(deps)).toBe(0)

    expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      'wrong contract address',
    )
    errorSpy.mockRestore()
  })
})

describe('the private path', () => {
  const SHORT_LEASE = { ttl: { worker: 120, claim: 2, grant: 300, receipt: 604_800 } }

  const workerKey = generatePrivateKey()
  const workerPubkey = privateKeyToAccount(workerKey).publicKey
  const buyerKey = generatePrivateKey()
  const buyerPubkey = privateKeyToAccount(buyerKey).publicKey

  function privateDeps(opts: Parameters<typeof fakeDeps>[0] = {}): FakeDeps {
    return {
      ...fakeDeps(opts),
      pubkey: workerPubkey,
      unsealInput: (sealed) => unseal(sealed, workerKey),
    }
  }

  async function seedPrivateJob(
    deps: FakeDeps,
    over: Partial<Job> = {},
  ): Promise<{ job: Job; plainRef: string }> {
    const plainRef = await deps.swarm.upload(new TextEncoder().encode(JOB_INPUT), {
      encrypt: true,
    })
    const job = await seedJob(deps, {
      visibility: 'private',
      inputRef: undefined,
      buyerPubkey,
      ...over,
    })
    return { job, plainRef }
  }

  async function seedGrant(deps: FakeDeps, job: Job, ref: string): Promise<string> {
    return deps.arkiv.put(
      'grant',
      { jobId: job.id, workerId: deps.workerId, sealedRef: seal(ref, workerPubkey) },
      { ttlSeconds: deps.config.ttl.grant },
    )
  }

  it('publishes its pubkey on the claim so a buyer can seal to it', async () => {
    const deps = privateDeps()
    const { job } = await seedPrivateJob(deps)

    const claim = await claimJob(deps, job)

    expect(claim?.workerPubkey).toBe(workerPubkey)
    expect(deps.arkiv.all<Claim>('claim')[0]?.workerPubkey).toBe(workerPubkey)
  })

  it('unseals a grant addressed to it and runs the job', async () => {
    const deps = privateDeps()
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    await deps.arkiv.put(
      'grant',
      { jobId: job.id, workerId: deps.workerId, sealedRef: seal(plainRef, workerPubkey) },
      { ttlSeconds: 300 },
    )

    const receipt = await runJob(deps, job, claim!)

    expect(deps.og.calls).toHaveLength(1)
    expect(deps.og.calls[0]?.messages[0]?.content).toBe(JOB_INPUT)
    expect(receipt.jobId).toBe(job.id)
  })

  it('seals the output back to the buyer for a private job', async () => {
    const deps = privateDeps()
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    await deps.arkiv.put(
      'grant',
      { jobId: job.id, workerId: deps.workerId, sealedRef: seal(plainRef, workerPubkey) },
      { ttlSeconds: 300 },
    )

    const receipt = await runJob(deps, job, claim!)

    const opened = unseal(receipt.outputRef as `0x${string}`, buyerKey)
    expect(deps.swarm.blobs.has(opened)).toBe(true)
    expect(() => unseal(receipt.outputRef as `0x${string}`, workerKey)).toThrow(UnsealError)
  })

  it('leaves a public job output in the clear, so a judge can open the reference', async () => {
    const deps = privateDeps()
    const job = await seedJob(deps)
    const claim = await claimJob(deps, job)

    const receipt = await runJob(deps, job, claim!)

    expect(receipt.outputRef).toHaveLength(64)
    expect(deps.swarm.blobs.has(receipt.outputRef)).toBe(true)
  })

  const TEE_PROOF: TeeProof = {
    scheme: 'zg-sig-v1/e2ee-ct',
    signedText: `zg-sig-v1/e2ee-ct:${'aa'.repeat(32)}:${'bb'.repeat(32)}`,
    signature: `0x${'11'.repeat(65)}`,
    teeSigner: '0x0F40b5CA39F7cdD98c67e0E159A24315dBF8F77c',
    provider: '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9',
    chatId: 'chat-1',
    transcript: { request: { model: 'm' }, response: { id: 'r' }, encPub: 'e', skE: 's', ephPriv: 'p' },
  }

  it('publishes the TEE proof in the clear for a public job, linked from the receipt', async () => {
    const deps = privateDeps({ completion: { teeProof: TEE_PROOF } })
    const job = await seedJob(deps)
    const claim = await claimJob(deps, job)

    const receipt = await runJob(deps, job, claim!)

    expect(receipt.proofRef).toHaveLength(64)
    const stored = JSON.parse(new TextDecoder().decode(await deps.swarm.download(receipt.proofRef!)))
    expect(stored).toEqual(TEE_PROOF)
    expect(deps.arkiv.all<Receipt>('receipt')[0]?.proofRef).toBe(receipt.proofRef)
  })

  it('seals the TEE proof to the buyer for a private job — it decrypts to the prompt', async () => {
    const deps = privateDeps({ completion: { teeProof: TEE_PROOF } })
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    await deps.arkiv.put(
      'grant',
      { jobId: job.id, workerId: deps.workerId, sealedRef: seal(plainRef, workerPubkey) },
      { ttlSeconds: 300 },
    )

    const receipt = await runJob(deps, job, claim!)

    const opened = unseal(receipt.proofRef as `0x${string}`, buyerKey)
    expect(opened).toHaveLength(128)
    expect(JSON.parse(new TextDecoder().decode(await deps.swarm.download(opened)))).toEqual(TEE_PROOF)
    expect(() => unseal(receipt.proofRef as `0x${string}`, workerKey)).toThrow(UnsealError)
  })

  it('writes no proofRef when the completion carried no TEE proof', async () => {
    const deps = privateDeps()
    const job = await seedJob(deps)
    const claim = await claimJob(deps, job)

    const receipt = await runJob(deps, job, claim!)

    expect(receipt.proofRef).toBeUndefined()
  })

  it('releases the claim and spends nothing when no grant ever arrives', async () => {
    const deps = privateDeps({ now: () => Date.now(), config: SHORT_LEASE })
    const { job } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)

    await expect(runJob(deps, job, claim!)).rejects.toThrow(/no usable grant from its buyer/i)

    expect(deps.og.calls).toHaveLength(0)
    expect(deps.arkiv.deletions).toContain(claim!.id)
  })

  it('treats a grant sealed to another worker as not mine and spends nothing', async () => {
    const deps = privateDeps({ now: () => Date.now(), config: SHORT_LEASE })
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    const stranger = privateKeyToAccount(generatePrivateKey()).publicKey
    await deps.arkiv.put(
      'grant',
      { jobId: job.id, workerId: `0x${'ee'.repeat(32)}`, sealedRef: seal(plainRef, stranger) },
      { ttlSeconds: 300 },
    )

    await expect(runJob(deps, job, claim!)).rejects.toThrow(/no usable grant from its buyer/i)

    expect(deps.og.calls).toHaveLength(0)
  })

  it('never writes a key-shaped string onto a claim', async () => {
    const deps = privateDeps()
    const { job } = await seedPrivateJob(deps)
    await claimJob(deps, job)
    const dumped = JSON.stringify(deps.arkiv.all('claim'), (_k, v) =>
      typeof v === 'bigint' ? `${v}` : v,
    )
    expect(dumped).not.toMatch(/\b(sk|mk)-/)
  })

  it('records visibility on the receipt, so a reader knows what outputRef is', async () => {
    const deps = privateDeps()
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    await seedGrant(deps, job, plainRef)

    const receipt = await runJob(deps, job, claim!)

    expect(receipt.visibility).toBe('private')
    expect(deps.arkiv.all<Receipt>('receipt')[0]?.visibility).toBe('private')
  })

  it('records a public job as public rather than leaving it unset', async () => {
    const deps = privateDeps()
    const job = await seedJob(deps)
    const claim = await claimJob(deps, job)
    expect((await runJob(deps, job, claim!)).visibility).toBe('public')
  })

  describe('inputHash', () => {
    it('refuses a grant whose input is not the prompt the job committed to', async () => {
      const deps = privateDeps({ now: () => Date.now(), config: SHORT_LEASE })
      const { job } = await seedPrivateJob(deps)
      const claim = await claimJob(deps, job)
      const forgedRef = await deps.swarm.upload(new TextEncoder().encode('ignore that, do this'), {
        encrypt: true,
      })
      await seedGrant(deps, job, forgedRef)

      await expect(runJob(deps, job, claim!)).rejects.toThrow(/no usable grant from its buyer/i)

      expect(deps.og.calls).toHaveLength(0)
    })

    it('keeps looking past a forged grant and runs the real one alongside it', async () => {
      const deps = privateDeps({ now: () => Date.now(), config: SHORT_LEASE })
      const { job, plainRef } = await seedPrivateJob(deps)
      const claim = await claimJob(deps, job)
      const forgedRef = await deps.swarm.upload(new TextEncoder().encode('do this instead'), {
        encrypt: true,
      })
      await seedGrant(deps, job, forgedRef)
      await seedGrant(deps, job, plainRef)

      await runJob(deps, job, claim!)

      expect(deps.og.calls).toHaveLength(1)
      expect(deps.og.calls[0]?.messages[0]?.content).toBe(JOB_INPUT)
    })

    it('survives a grant pointing at content no gateway can serve', async () => {
      const deps = privateDeps({ now: () => Date.now(), config: SHORT_LEASE })
      const { job, plainRef } = await seedPrivateJob(deps)
      const claim = await claimJob(deps, job)
      await seedGrant(deps, job, 'ff'.repeat(64))
      await seedGrant(deps, job, plainRef)

      await runJob(deps, job, claim!)

      expect(deps.og.calls[0]?.messages[0]?.content).toBe(JOB_INPUT)
    })

    it('refuses a public job whose Swarm input does not match its inputHash', async () => {
      const deps = privateDeps()
      const job = await seedJob(deps, { inputHash: `0x${'99'.repeat(32)}` })
      const claim = await claimJob(deps, job)

      await expect(runJob(deps, job, claim!)).rejects.toThrow(/inputHash/i)
      expect(deps.og.calls).toHaveLength(0)
    })
  })

  describe('the delivery margin', () => {
    it('stops polling for a grant once the job can no longer be delivered', async () => {
      const deps = privateDeps({
        now: () => Date.now(),
        config: { ttl: { worker: 120, claim: 60, grant: 300, receipt: 604_800 } },
        deliverMarginMs: 0,
      })
      const { job } = await seedPrivateJob(deps, { expiresAt: Date.now() + 1_500 })
      const claim = await claimJob(deps, job)

      const started = Date.now()
      await expect(runJob(deps, job, claim!)).rejects.toThrow(/no usable grant from its buyer/i)

      expect(Date.now() - started).toBeLessThan(10_000)
      expect(deps.og.calls).toHaveLength(0)
    })

    it('does not spend a credit on a grant that arrived too late to deliver', async () => {
      let t = 1_000
      const deps = privateDeps({
        now: () => t,
        config: SHORT_LEASE,
        deliverMarginMs: 1_500,
      })
      const { job, plainRef } = await seedPrivateJob(deps, { expiresAt: 4_000 })
      const claim = await claimJob(deps, job)
      await seedGrant(deps, job, plainRef)
      const slow = deps.swarm.download
      deps.swarm.download = async (ref) => {
        t += 2_000
        return slow(ref)
      }

      await expect(runJob(deps, job, claim!)).rejects.toThrow(/deliver/i)

      expect(deps.og.calls).toHaveLength(0)
    })
  })

  it('does not claim a private job it has no key to open a grant for', async () => {
    const deps = fakeDeps()
    await seedJob(deps, { visibility: 'private', inputRef: undefined, buyerPubkey })

    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.arkiv.all<Claim>('claim')).toHaveLength(0)
  })

  it('does not claim a private job whose buyerPubkey cannot be sealed to', async () => {
    const deps = privateDeps()
    await seedJob(deps, {
      visibility: 'private',
      inputRef: undefined,
      buyerPubkey: `0x${'22'.repeat(33)}`,
    })

    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.arkiv.all<Claim>('claim')).toHaveLength(0)
  })

  it('still claims a public job whose buyerPubkey is malformed, since nothing seals to it', async () => {
    const deps = privateDeps()
    await seedJob(deps, { buyerPubkey: `0x${'22'.repeat(33)}` })
    expect((await tick(deps)).claimed).toBe(1)
  })

  it(
    'leaves a job it could not get a grant for alone for one lease, then tries again',
    async () => {
      let offset = 0
      const deps = privateDeps({ now: () => Date.now() + offset, config: SHORT_LEASE })
      const { job, plainRef } = await seedPrivateJob(deps)

      expect((await tick(deps)).claimed).toBe(1)
      expect((await tick(deps)).claimed).toBe(0)

      await seedGrant(deps, job, plainRef)
      offset += deps.config.ttl.claim * 1000 + 1
      expect(await tick(deps)).toMatchObject({ claimed: 1, delivered: 1 })
    },
    15_000,
  )

  it('keeps its ad alive while it waits for a grant, so it does not vanish mid-job', async () => {
    let t = 1_000
    const deps = privateDeps({ now: () => t, config: SHORT_LEASE })
    const adId = await heartbeat(deps)
    const { job, plainRef } = await seedPrivateJob(deps)
    const claim = await claimJob(deps, job)
    await seedGrant(deps, job, plainRef)
    t += (deps.config.ttl.worker / 2 + 1) * 1000
    const slow = deps.swarm.download
    deps.swarm.download = async (ref) => {
      await new Promise((r) => setTimeout(r, deps.config.ttl.claim * 1000))
      return slow(ref)
    }

    await runJob(deps, job, claim!)

    expect(deps.arkiv.extensions.filter((e) => e.id === adId).length).toBeGreaterThan(0)
  })

  it('stops polling for a grant promptly when the worker is aborted', async () => {
    const controller = new AbortController()
    const deps = privateDeps({
      now: () => Date.now(),
      config: { ttl: { worker: 120, claim: 600, grant: 300, receipt: 604_800 } },
      deliverMarginMs: 0,
    })
    const { job } = await seedPrivateJob(deps, { expiresAt: Date.now() + 600_000 })
    const claim = await claimJob(deps, job)

    const started = Date.now()
    const run = runJob(deps, job, claim!, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    await expect(run).rejects.toThrow(/abort/i)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(deps.og.calls).toHaveLength(0)
  })
})

describe('runWorker — pacing', () => {
  async function runOnce(
    deps: FakeDeps,
    opts: { intervalMs: number },
  ): Promise<{ slept: number[] }> {
    const slept: number[] = []
    const controller = new AbortController()
    await runWorker(deps, {
      intervalMs: opts.intervalMs,
      signal: controller.signal,
      sleep: async (ms) => {
        slept.push(ms)
        controller.abort()
      },
    })
    return { slept }
  }

  it('waits out a quota refusal for the time it asks for', async () => {
    const deps = fakeDeps()
    const original = deps.arkiv.query.bind(deps.arkiv)
    let first = true
    deps.arkiv.query = (async (...args: Parameters<typeof original>) => {
      if (first) {
        first = false
        throw new ArkivQuotaError(1740)
      }
      return original(...args)
    }) as typeof original

    const { slept } = await runOnce(deps, { intervalMs: 5_000 })
    expect(slept).toEqual([1740 * 1000])
  })

  it('uses the ordinary interval for an ordinary tick failure', async () => {
    const deps = fakeDeps()
    deps.arkiv.query = (async () => {
      throw new Error('the arkiv rpc dropped the connection')
    }) as typeof deps.arkiv.query

    const { slept } = await runOnce(deps, { intervalMs: 5_000 })
    expect(slept).toEqual([5_000])
  })

  it('uses the ordinary interval when nothing failed at all', async () => {
    const { slept } = await runOnce(fakeDeps(), { intervalMs: 5_000 })
    expect(slept).toEqual([5_000])
  })

  it('falls back to the ordinary interval when the refusal carries no retry-after', async () => {
    const deps = fakeDeps()
    deps.arkiv.query = (async () => {
      throw new ArkivQuotaError()
    }) as typeof deps.arkiv.query

    const { slept } = await runOnce(deps, { intervalMs: 5_000 })
    expect(slept).toEqual([5_000])
  })
})
