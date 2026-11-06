import { describe, expect, it } from 'vitest'
import type { Job, Receipt } from '@dusk/core'
import { planJob } from '@dusk/core'
import { keccak256, toHex } from 'viem'
import { tick } from '../src/loop'
import { newBudget } from '../src/budget'
import { FAKE_WRITER, fakeArkiv, fakeDeps, fakeSwarm, type FakeDeps } from './fakes'
import { joinPieces } from '../../apps/web/src/lib/pieces'

const MODEL = '0gm-1.0-35b-a3b'

function market(start = 1_000) {
  let t = start
  const now = () => t
  const arkiv = fakeArkiv(now)
  const swarm = fakeSwarm()
  const worker = (over: { id: string; balance?: string; models?: string[]; price?: bigint; fallbackDelayMs?: number }) => {
    const deps = fakeDeps({
      now,
      arkiv,
      swarm,
      workerId: `0x${over.id.repeat(32)}`,
      models: over.models ?? [MODEL],
      pricePer1kOut: over.price ?? 1n,
      ...(over.balance ? { balance: { creditBalance: over.balance } } : {}),
    })
    deps.payout = `0x${over.id.repeat(20)}`
    deps.budget = newBudget(1)
    if (over.fallbackDelayMs !== undefined) deps.fallbackDelayMs = over.fallbackDelayMs
    return deps
  }
  return { arkiv, swarm, worker, advance: (ms: number) => void (t += ms), now }
}

async function postPieces(
  deps: FakeDeps,
  prompt: string,
  maxTokens: number,
  opts: { model?: string; serial?: boolean } = {},
): Promise<Job[]> {
  const plan = planJob(prompt, maxTokens, 64)
  if (plan.kind !== 'parallel' && plan.kind !== 'serial') throw new Error(`expected a split, got ${plan.kind}`)
  const parentId = `0x${'5a'.repeat(32)}` as const
  const jobs: Job[] = []
  for (const [index, p] of plan.pieces.entries()) {
    const inputRef = await deps.swarm.upload(new TextEncoder().encode(p.prompt))
    const job: Omit<Job, 'id'> = {
      model: opts.model ?? MODEL,
      maxPricePer1kOut: 1_000n,
      maxTokens: p.maxTokens,
      trustMode: 'verified',
      visibility: 'public',
      inputRef,
      inputHash: keccak256(toHex(p.prompt)),
      inputChars: p.prompt.length,
      buyerPubkey: `0x${'22'.repeat(33)}`,
      escrowId: `0x${String(index + 1).padStart(2, '0').repeat(32)}`,
      status: 'open',
      expiresAt: deps.now() + 600_000,
      parentId,
      pieceIndex: index,
      pieceCount: plan.pieces.length,
      ...(plan.kind === 'serial' && index > 0 ? { after: jobs[index - 1]!.id } : {}),
    }
    const id = await deps.arkiv.put('job', job, { ttlSeconds: 600 })
    jobs.push({ ...job, id, owner: FAKE_WRITER })
  }
  return jobs
}

async function ledgerFor(deps: FakeDeps, jobs: Job[]) {
  const receipts = deps.arkiv.all<Receipt>('receipt')
  return Promise.all(
    jobs.map(async (j) => {
      const r = receipts.find((x) => x.jobId === j.id)
      const outputText = r ? new TextDecoder().decode(await deps.swarm.download(r.outputRef)) : undefined
      return { ...j, ...(outputText !== undefined ? { outputText } : {}) }
    }),
  )
}

const servedBy = (deps: FakeDeps) => (deps.arkiv.all<Receipt>('receipt')).map((r) => r.worker)

describe('scenario — pieces run at once, sellers take only what they can afford', () => {
  it('a rich seller serves the pieces a poor one has to pass on, and the answers join in order', async () => {
    const m = market()
    const poor = m.worker({ id: 'a1', balance: '20' })
    const rich = m.worker({ id: 'b2', balance: '100000' })
    const jobs = await postPieces(poor, 'Answer briefly.\n1. What is Arkiv?\n2. What is Swarm?\n3. What is 0G?', 30)

    for (let k = 0; k < 3; k++) {
      expect((await tick(poor)).claimed).toBe(0)
      expect((await tick(rich)).delivered).toBe(1)
    }

    expect(servedBy(rich)).toEqual([rich.payout, rich.payout, rich.payout])
    expect(rich.og.calls.map((c) => c.messages[0]!.content)).toEqual([
      'Answer briefly.\nWhat is Arkiv?',
      'Answer briefly.\nWhat is Swarm?',
      'Answer briefly.\nWhat is 0G?',
    ])
    expect(rich.og.calls.every((c) => c.maxTokens === 10)).toBe(true)

    const [joined] = joinPieces(await ledgerFor(rich, jobs), m.now())
    expect(joined).toMatchObject({ complete: true, partial: false, count: 3 })
    expect(joined!.text).toBe('the answer\n\nthe answer\n\nthe answer')
  })
})

describe('scenario — the fallback is the last option', () => {
  it('serves at once when no seller offers the model', async () => {
    const m = market()
    const ordinary = m.worker({ id: 'a1', balance: '100000' })
    const fallback = m.worker({ id: 'f0', balance: '100000', models: [MODEL, 'rare-model'], fallbackDelayMs: 20_000 })
    await tick(ordinary)
    await postPieces(ordinary, '1. a\n2. b', 8, { model: 'rare-model' })

    expect((await tick(ordinary)).claimed).toBe(0)
    expect((await tick(fallback)).delivered).toBe(1)
    expect((await tick(fallback)).delivered).toBe(1)
    expect(servedBy(fallback)).toEqual([fallback.payout, fallback.payout])
  })

  it('waits 20 s while a seller with the model could take it, then serves what nobody could afford', async () => {
    const m = market()
    const poor = m.worker({ id: 'a1', balance: '20' })
    const fallback = m.worker({ id: 'f0', balance: '100000', fallbackDelayMs: 20_000 })
    await tick(poor)
    const jobs = await postPieces(poor, '1. a\n2. b', 8)

    expect((await tick(poor)).claimed).toBe(0)
    expect((await tick(fallback)).claimed).toBe(0)
    m.advance(19_998)
    expect((await tick(fallback)).claimed).toBe(0)
    m.advance(2)
    expect((await tick(fallback)).delivered).toBe(1)
    expect((await tick(fallback)).delivered).toBe(1)
    expect(joinPieces(await ledgerFor(fallback, jobs), m.now())[0]!.complete).toBe(true)
  })

  it('does nothing when the only sellers want more than the buyer will pay', async () => {
    const m = market()
    const pricey = m.worker({ id: 'a1', balance: '100000', price: 5_000n })
    const fallback = m.worker({ id: 'f0', balance: '100000', fallbackDelayMs: 20_000 })
    await tick(pricey)
    await postPieces(pricey, '1. a\n2. b', 8)

    await tick(fallback)
    m.advance(60_000)
    expect((await tick(pricey)).claimed).toBe(0)
    expect((await tick(fallback)).claimed).toBe(0)
  })
})

describe('scenario — pieces that must run in order', () => {
  it('runs step 2 only after step 1, built on step 1’s answer, then joins both', async () => {
    const m = market()
    const w = m.worker({ id: 'b2', balance: '100000' })
    const jobs = await postPieces(w, '1. Pick a city\n2. Then describe the city from step 1', 8)
    expect(jobs[1]!.after).toBe(jobs[0]!.id)

    expect((await tick(w)).delivered).toBe(1)
    expect(w.og.calls[0]!.messages[0]!.content).toBe('Pick a city')
    expect((await tick(w)).delivered).toBe(1)
    expect(w.og.calls[1]!.messages[0]!.content).toBe(
      "Previous step's answer:\nthe answer\n\nNow:\nThen describe the city from step 1",
    )

    const [joined] = joinPieces(await ledgerFor(w, jobs), m.now())
    expect(joined).toMatchObject({ complete: true })
  })

  it('marks the result partial when a step never arrives before the deadline', async () => {
    const m = market()
    const w = m.worker({ id: 'b2', balance: '20' })
    const jobs = await postPieces(w, '1. Pick a city\n2. Then describe it', 8)
    expect((await tick(w)).claimed).toBe(0)
    m.advance(700_000)
    const [joined] = joinPieces(await ledgerFor(w, jobs), m.now())
    expect(joined).toMatchObject({ complete: false, partial: true })
  })
})
