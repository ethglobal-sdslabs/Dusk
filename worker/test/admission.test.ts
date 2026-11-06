import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { keccak256, toHex } from 'viem'
import { escrowDeadlineSec, jobPriceWei, type Job } from '@dusk/core'
import { tick } from '../src/loop'
import { FAKE_WRITER, fakeDeps, fakeEscrow, type FakeDeps } from './fakes'

const JOB_INPUT = 'summarise this'

async function seedJob(deps: FakeDeps): Promise<Job> {
  const inputRef = await deps.swarm.upload(new TextEncoder().encode(JOB_INPUT))
  const job: Job = {
    id: '', model: '0gm-1.0-35b-a3b', maxPricePer1kOut: 1_000n, maxTokens: 16, trustMode: 'verified', visibility: 'public',
    inputRef, inputHash: keccak256(toHex(JOB_INPUT)), buyerPubkey: `0x${'22'.repeat(33)}`, escrowId: `0x${'33'.repeat(32)}`,
    status: 'open', expiresAt: deps.now() + 600_000,
  }
  const id = await deps.arkiv.put('job', job, { ttlSeconds: 600 })
  return { ...job, id, owner: FAKE_WRITER }
}

const refuse = (who: Address) => async (_action: string, wallet: Address) =>
  wallet.toLowerCase() === who.toLowerCase() ? { allowed: false, reason: 'banned' } : { allowed: true }

describe('tick — ENS admission', () => {
  it('serves as before when admission allows both parties', async () => {
    const seen: Array<[string, string]> = []
    const deps: FakeDeps = { ...fakeDeps(), admit: async (action, wallet) => { seen.push([action, wallet]); return { allowed: true } } }
    await seedJob(deps)
    expect((await tick(deps)).delivered).toBe(1)
    expect(seen).toContainEqual(['new-claim', deps.payout])
    expect(seen).toContainEqual(['new-claim', FAKE_WRITER])
  })

  it('does not claim for a refused buyer, and spends nothing', async () => {
    const deps: FakeDeps = { ...fakeDeps(), admit: refuse(FAKE_WRITER) }
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.arkiv.all('claim')).toHaveLength(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('does not claim at all while this worker itself is refused', async () => {
    const base = fakeDeps()
    const deps: FakeDeps = { ...base, admit: refuse(base.payout) }
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('fails closed when the admission check itself throws', async () => {
    const deps: FakeDeps = { ...fakeDeps(), admit: async () => { throw new Error('sepolia down') } }
    await seedJob(deps)
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('keeps its ad when its own admission read fails or comes back unknown', async () => {
    for (const failure of [
      async () => { throw new Error('sepolia down') },
      async () => ({ allowed: false, retryable: true, reason: 'could not be verified' }),
    ]) {
      let broken = false
      const base = fakeDeps()
      const deps: FakeDeps = {
        ...base,
        admit: async () => (broken ? failure() : { allowed: true }),
      }
      await tick(deps)
      const ad = deps.adState?.id
      expect(ad).toBeDefined()
      broken = true
      await seedJob(deps)
      const r = await tick(deps)
      expect(r.claimed).toBe(0)
      expect(deps.og.calls).toHaveLength(0)
      expect(deps.adState?.id).toBe(ad)
      expect(deps.arkiv.all('worker').map((w) => (w as { id: string }).id)).toContain(ad)
    }
  })

  it('still takes its ad down for a definite refusal', async () => {
    let banned = false
    const base = fakeDeps()
    const deps: FakeDeps = { ...base, admit: async () => (banned ? { allowed: false, reason: 'banned' } : { allowed: true }) }
    await tick(deps)
    expect(deps.arkiv.all('worker')).toHaveLength(1)
    banned = true
    await tick(deps)
    expect(deps.arkiv.all('worker')).toHaveLength(0)
  })

  it('does not extend a source verdict with another worker-side cache', async () => {
    let t = 1_000
    let asked = 0
    const base = fakeDeps({ now: () => t })
    const deps: FakeDeps = { ...base, admit: async (_a, wallet) => { asked++; return { allowed: wallet !== FAKE_WRITER } } }
    await seedJob(deps)
    await tick(deps)
    const first = asked
    t += 5_000
    await tick(deps)
    expect(asked).toBeGreaterThan(first)
    t += 15_000
    await tick(deps)
    expect(asked).toBeGreaterThan(first)
  })

  it('checks the name even while idle before advertising availability', async () => {
    let asked = 0
    const deps: FakeDeps = { ...fakeDeps(), admit: async () => { asked++; return { allowed: true } } }
    await tick(deps)
    expect(asked).toBe(1)
    expect(deps.arkiv.all('worker')).toHaveLength(1)
  })

  it('never advertises an unnamed wallet even when there are no jobs', async () => {
    const deps: FakeDeps = { ...fakeDeps(), admit: async () => ({ allowed: false }) }
    expect(await tick(deps)).toMatchObject({ claimed: 0, delivered: 0 })
    expect(deps.arkiv.all('worker')).toHaveLength(0)
    expect(deps.og.calls).toHaveLength(0)
  })
})

describe('tick — escrow admission gate', () => {
  async function gated(gate: { admitted?: () => Promise<boolean>; admittedUntil?: () => Promise<number> }) {
    const escrow = fakeEscrow()
    const base = fakeDeps({ escrow })
    const deps: FakeDeps = { ...base, escrow: Object.assign(escrow, gate) }
    const job = await seedJob(deps)
    escrow.deals.set(job.escrowId, {
      buyer: FAKE_WRITER, worker: `0x${'00'.repeat(20)}`, amount: jobPriceWei(deps.pricePer1kOut, job.maxTokens),
      outputHash: `0x${'00'.repeat(32)}`, commitAtSec: 0, deadlineSec: escrowDeadlineSec(job.expiresAt), state: 'funded',
    })
    await deps.arkiv.putAs(FAKE_WRITER, 'grant', { jobId: job.id, workerId: deps.workerId, commitAuth: escrow.authFor(FAKE_WRITER, job.escrowId, escrow.signer) }, { ttlSeconds: deps.config.ttl.grant })
    return deps
  }
  const day = (deps: FakeDeps) => Math.floor(deps.now() / 1000) + 86_400

  it('control: serves when the gate admits it well past the delivery margin', async () => {
    let deps!: FakeDeps
    deps = await gated({ admitted: async () => true, admittedUntil: async () => day(deps) })
    expect((await tick(deps)).delivered).toBe(1)
  })

  it('claims nothing while the gate does not admit this worker', async () => {
    const deps = await gated({ admitted: async () => false, admittedUntil: async () => 0 })
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('treats an unreadable gate as closed', async () => {
    const deps = await gated({ admitted: async () => { throw new Error('rpc down') }, admittedUntil: async () => { throw new Error('rpc down') } })
    expect((await tick(deps)).claimed).toBe(0)
  })

  it('retries a gate read that fails once instead of treating it as closed', async () => {
    let asks = 0
    let deps!: FakeDeps
    deps = await gated({ admittedUntil: async () => { if (++asks === 1) throw new Error('rpc blip'); return day(deps) } })
    expect((await tick(deps)).delivered).toBe(1)
  })

  it('claims nothing when its status expires inside the delivery margin', async () => {
    let deps!: FakeDeps
    deps = await gated({ admitted: async () => true, admittedUntil: async () => Math.floor((deps.now() + deps.deliverMarginMs / 2) / 1000) })
    expect((await tick(deps)).claimed).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
  })

  it('re-checks the gate, uncached, right before spending credits', async () => {
    let asks = 0
    let deps!: FakeDeps
    deps = await gated({ admitted: async () => asks <= 1, admittedUntil: async () => (++asks === 1 ? day(deps) : 0) })
    expect((await tick(deps)).delivered).toBe(0)
    expect(deps.og.calls).toHaveLength(0)
    expect(asks).toBeGreaterThanOrEqual(2)
  })
})
