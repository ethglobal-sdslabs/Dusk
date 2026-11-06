import { describe, expect, it } from 'vitest'
import type { Job, Receipt } from '@dusk/core'
import { keccak256, toHex } from 'viem'
import { tick } from '../src/loop'
import { fallbackDelayMsFrom, fallbackPrice, reservePricePer1kFrom } from '../src/fallback'
import { newBudget } from '../src/budget'
import { FAKE_WRITER, fakeArkiv, fakeDeps, type FakeDeps } from './fakes'

const INPUT = 'hi'

async function seedJob(deps: FakeDeps, over: Partial<Job> = {}): Promise<Job> {
  const inputRef = await deps.swarm.upload(new TextEncoder().encode(INPUT))
  const job: Job = {
    id: '',
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: 1_000n,
    maxTokens: 16,
    trustMode: 'verified',
    visibility: 'public',
    inputRef,
    inputHash: keccak256(toHex(INPUT)),
    inputChars: INPUT.length,
    buyerPubkey: `0x${'22'.repeat(33)}`,
    escrowId: `0x${'33'.repeat(32)}`,
    status: 'open',
    expiresAt: deps.now() + 600_000,
    ...over,
  }
  const id = await deps.arkiv.put('job', job, { ttlSeconds: 600 })
  return { ...job, id, owner: FAKE_WRITER }
}

const RIVAL_AD = {
  models: ['0gm-1.0-35b-a3b'],
  pricePer1kOut: 1n,
  creditsBucket: '>50%',
  trustModes: ['verified'],
  payout: `0x${'44'.repeat(20)}`,
}

async function fallbackWorker(delayMs: number, { rival = true } = {}) {
  let t = 1_000
  const now = () => t
  const deps = fakeDeps({ now, arkiv: fakeArkiv(now) })
  deps.fallbackDelayMs = delayMs
  if (rival) await deps.arkiv.put('worker', RIVAL_AD, { ttlSeconds: 3600 })
  return { deps, advance: (ms: number) => void (t += ms) }
}

describe('fallback worker', () => {
  it('leaves a fresh job alone so ordinary sellers get first pick', async () => {
    const { deps } = await fallbackWorker(60_000)
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('takes a job once it has sat unclaimed for the whole delay', async () => {
    const { deps, advance } = await fallbackWorker(60_000)
    await seedJob(deps)
    await tick(deps)
    advance(59_998)
    expect((await tick(deps)).claimed).toBe(0)
    advance(2)
    expect(await tick(deps)).toEqual({ claimed: 1, delivered: 1, settled: 0 })
    expect(deps.arkiv.all<Receipt>('receipt')).toHaveLength(1)
  })

  it('starts the wait when it first sees the job, not before', async () => {
    const { deps, advance } = await fallbackWorker(60_000)
    advance(120_000)
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('still yields to a seller that claimed during the wait', async () => {
    const { deps, advance } = await fallbackWorker(60_000)
    const job = await seedJob(deps)
    await tick(deps)
    await deps.arkiv.put(
      'claim',
      { jobId: job.id, workerId: `0x${'cc'.repeat(32)}`, price: 1n, claimedAt: 0 },
      { ttlSeconds: 90 },
    )
    advance(60_000)
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('forgets jobs that are no longer open, so its memory does not grow forever', async () => {
    const { deps } = await fallbackWorker(60_000)
    const job = await seedJob(deps)
    await tick(deps)
    expect(deps.firstSeen?.has(job.id)).toBe(true)
    await deps.arkiv.del(job.id)
    await tick(deps)
    expect(deps.firstSeen?.has(job.id)).toBe(false)
  })

  it('an ordinary worker (no delay) still claims straight away', async () => {
    const deps = fakeDeps()
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(1)
  })
})

describe('fallbackDelayMsFrom', () => {
  it('is off when unset or blank', () => {
    expect(fallbackDelayMsFrom({})).toBeUndefined()
    expect(fallbackDelayMsFrom({ DUSK_FALLBACK_DELAY_SEC: '' })).toBeUndefined()
  })

  it('reads whole seconds as milliseconds', () => {
    expect(fallbackDelayMsFrom({ DUSK_FALLBACK_DELAY_SEC: '60' })).toBe(60_000)
  })

  it.each(['-1', '0', '1.5', 'sixty', '60s'])('refuses %j rather than guessing', (raw) => {
    expect(() => fallbackDelayMsFrom({ DUSK_FALLBACK_DELAY_SEC: raw })).toThrow(/DUSK_FALLBACK_DELAY_SEC/)
  })
})

describe('affordability check (ordinary worker)', () => {
  it('does not claim a job its credits cannot cover, so the buyer is not kept waiting', async () => {
    const deps = fakeDeps({ balance: { creditBalance: '10' } })
    deps.budget = newBudget(1)
    await seedJob(deps, { maxTokens: 64 })
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.arkiv.all('claim')).toHaveLength(0)
  })

  it('claims a job it can cover', async () => {
    const deps = fakeDeps({ balance: { creditBalance: '1000' } })
    deps.budget = newBudget(1)
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(1)
  })

  it('uses the job’s inputChars for a prompt it cannot read before claiming', async () => {
    const deps = fakeDeps({ balance: { creditBalance: '200' } })
    deps.budget = newBudget(1)
    await seedJob(deps, { inputChars: 3000 })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('records what it spent, so the next check counts it before the balance does', async () => {
    const deps = fakeDeps({ balance: { creditBalance: '1000' } })
    deps.budget = newBudget(1)
    await seedJob(deps)
    await tick(deps)
    expect(deps.budget.spends).toHaveLength(1)
    expect(deps.budget.spends[0]).toMatchObject({ tokens: 8, before: 1000n })
  })

  it('still works when the balance cannot be read (no management key)', async () => {
    const deps = fakeDeps()
    deps.og.balance = async () => {
      throw new Error('no management key')
    }
    deps.budget = newBudget(1)
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(1)
  })
})

describe('fallback skips the wait when nobody offers the model', () => {
  it('claims at once if no other live ad serves the job’s model', async () => {
    const { deps } = await fallbackWorker(60_000, { rival: false })
    await deps.arkiv.put(
      'worker',
      { models: ['some-other-model'], pricePer1kOut: 1n, creditsBucket: '>50%', trustModes: ['verified'], payout: `0x${'44'.repeat(20)}` },
      { ttlSeconds: 120 },
    )
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(1)
  })

  it('waits when another seller does offer it', async () => {
    const { deps } = await fallbackWorker(60_000, { rival: false })
    await deps.arkiv.put(
      'worker',
      { models: ['0gm-1.0-35b-a3b'], pricePer1kOut: 1n, creditsBucket: '>50%', trustModes: ['verified'], payout: `0x${'44'.repeat(20)}` },
      { ttlSeconds: 120 },
    )
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('does not count its own ad as another seller', async () => {
    const { deps } = await fallbackWorker(60_000, { rival: false })
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(1)
  })
})

describe('reservePricePer1kFrom — the fallback sells at what its tokens cost', () => {
  it('is off when no reserve is described', () => {
    expect(reservePricePer1kFrom({})).toBeUndefined()
  })

  it('turns "bought X tokens for Y wei" into a price per 1,000 tokens', () => {
    expect(
      reservePricePer1kFrom({ DUSK_RESERVE_TOKENS: '200', DUSK_RESERVE_COST_WEI: '200000' }),
    ).toBe(1_000_000n)
  })

  it('rounds up, so it never sells below cost', () => {
    expect(reservePricePer1kFrom({ DUSK_RESERVE_TOKENS: '3', DUSK_RESERVE_COST_WEI: '1000' })).toBe(333_334n)
  })

  it('wants both halves', () => {
    expect(() => reservePricePer1kFrom({ DUSK_RESERVE_TOKENS: '200' })).toThrow(/DUSK_RESERVE_COST_WEI/)
    expect(() => reservePricePer1kFrom({ DUSK_RESERVE_COST_WEI: '5' })).toThrow(/DUSK_RESERVE_TOKENS/)
  })

  it.each([
    ['0', '100'],
    ['200', '0'],
    ['1.5', '100'],
    ['200', 'abc'],
  ])('refuses tokens=%j cost=%j', (tokens, cost) => {
    expect(() => reservePricePer1kFrom({ DUSK_RESERVE_TOKENS: tokens, DUSK_RESERVE_COST_WEI: cost })).toThrow(
      /DUSK_RESERVE_/,
    )
  })
})

describe('fallbackPrice — what the fallback advertises', () => {
  it('is the reserve cost for the fallback', () => {
    expect(fallbackPrice(60_000, 1_000_000n)).toBe(1_000_000n)
  })

  it('refuses a fallback with no reserve cost', () => {
    expect(() => fallbackPrice(60_000, undefined)).toThrow(/DUSK_RESERVE_TOKENS/)
  })

  it('leaves an ordinary worker on its own price', () => {
    expect(fallbackPrice(undefined, undefined)).toBeUndefined()
  })
})

describe('fallback only serves "model not found" or "too big for everyone"', () => {
  it('does not serve a job others offer the model for but only above the buyer cap', async () => {
    const { deps, advance } = await fallbackWorker(20_000, { rival: false })
    await deps.arkiv.put('worker', { ...RIVAL_AD, pricePer1kOut: 5_000n }, { ttlSeconds: 3600 })
    await seedJob(deps, { maxPricePer1kOut: 1_000n })
    await tick(deps)
    advance(20_000)
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('serves a job others could price but none took within 20s', async () => {
    const { deps, advance } = await fallbackWorker(20_000)
    await seedJob(deps)
    await tick(deps)
    advance(20_000)
    expect((await tick(deps)).claimed).toBe(1)
  })
})

describe('Phase 5 — a piece that must run in order', () => {
  async function deliverPrevious(deps: FakeDeps, jobId: string, text: string, hashOf = text) {
    const outputRef = await deps.swarm.upload(new TextEncoder().encode(text))
    await deps.arkiv.put(
      'receipt',
      {
        jobId,
        escrowId: `0x${'44'.repeat(32)}`,
        worker: `0x${'11'.repeat(20)}`,
        modelServed: '0gm-1.0-35b-a3b',
        creditsSpent: '1',
        tokensIn: 1,
        tokensOut: 1,
        outputRef,
        visibility: 'public',
        outputHash: keccak256(toHex(hashOf)),
        latencyMs: 1,
        trustMode: 'verified',
      },
      { ttlSeconds: 600 },
    )
  }

  it('is not claimed until the piece before it has been delivered', async () => {
    const deps = fakeDeps()
    const first = await seedJob(deps)
    await seedJob(deps, { after: first.id, escrowId: `0x${'34'.repeat(32)}` })
    await deps.arkiv.del(first.id)
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('builds on the previous answer once it is delivered', async () => {
    const deps = fakeDeps()
    const first = await seedJob(deps)
    await deps.arkiv.del(first.id)
    await seedJob(deps, { after: first.id, escrowId: `0x${'34'.repeat(32)}` })
    await deliverPrevious(deps, first.id, 'Lisbon')
    expect((await tick(deps)).delivered).toBe(1)
    expect(deps.og.calls[0]!.messages[0]!.content).toBe("Previous step's answer:\nLisbon\n\nNow:\nhi")
  })

  it('ignores a previous "answer" that does not match its receipt hash', async () => {
    const deps = fakeDeps()
    const first = await seedJob(deps)
    await deps.arkiv.del(first.id)
    await seedJob(deps, { after: first.id, escrowId: `0x${'34'.repeat(32)}` })
    await deliverPrevious(deps, first.id, 'forged', 'Lisbon')
    expect((await tick(deps)).claimed).toBe(0)
  })
})

describe('TEE-verified jobs', () => {
  // The escrow's verifier rejects a commit with no TEE proof, refunding the buyer. A
  // worker that cannot produce one would spend credits for nothing, so it never claims.
  it('a worker without TEE proofs leaves a TEE job for one that has them', async () => {
    const deps = fakeDeps()
    deps.provesTee = false
    await seedJob(deps, { trustMode: 'private' })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('a worker with TEE proofs takes it', async () => {
    const deps = fakeDeps()
    deps.provesTee = true
    await seedJob(deps, { trustMode: 'private' })
    expect((await tick(deps)).claimed).toBe(1)
  })

  it('any worker still takes a verified (TeeTLS) job, which no proof can cover', async () => {
    const deps = fakeDeps()
    deps.provesTee = false
    await seedJob(deps, { trustMode: 'verified' })
    expect((await tick(deps)).claimed).toBe(1)
  })

  it('any worker still takes a standard job', async () => {
    const deps = fakeDeps()
    deps.provesTee = false
    await seedJob(deps, { trustMode: 'standard' })
    expect((await tick(deps)).claimed).toBe(1)
  })
})
