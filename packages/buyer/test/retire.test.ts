import { describe, expect, it } from 'vitest'
import type { Job, Receipt } from '@dusk/core'
import { keccak256, type Hex } from 'viem'
import { fakeArkiv, fakeEscrow, FAKE_WRITER } from '../../../worker/test/fakes'
import { retireDelivered } from '../src/retire'

const OUTPUT = new TextEncoder().encode('the answer')
const OUTPUT_HASH = keccak256(OUTPUT)
const ZERO: Hex = `0x${'0'.repeat(64)}`

async function setup(opts: { escrow?: boolean } = {}) {
  const arkiv = fakeArkiv()
  const escrowId: Hex = `0x${'44'.repeat(32)}`
  const id = await arkiv.put('job', { escrowId, model: 'm', status: 'open' }, { ttlSeconds: 600 })
  const job: Pick<Job, 'id' | 'escrowId'> = { id, escrowId }
  const receipt: Pick<Receipt, 'jobId' | 'escrowId' | 'outputHash'> = { jobId: id, escrowId, outputHash: OUTPUT_HASH }
  const escrow = opts.escrow ? fakeEscrow() : undefined
  if (escrow) {
    escrow.deals.set(escrowId, {
      buyer: FAKE_WRITER,
      worker: `0x${'ee'.repeat(20)}`,
      amount: 8000n,
      outputHash: OUTPUT_HASH,
      commitAtSec: 1,
      deadlineSec: 10_000,
      state: 'committed',
    })
  }
  return { arkiv, escrow, job, receipt, deps: { arkiv, ...(escrow ? { escrow } : {}) } }
}

describe('retireDelivered', () => {
  it('deletes the job entity once the delivered bytes match the receipt', async () => {
    const t = await setup()
    expect(await retireDelivered(t.deps, t.job, t.receipt, OUTPUT)).toBe(true)
    expect(t.arkiv.deletions).toEqual([t.job.id])
    expect(t.arkiv.all('job')).toEqual([])
  })

  it('keeps the job when the bytes do not hash to the receipt', async () => {
    const t = await setup()
    expect(await retireDelivered(t.deps, t.job, t.receipt, new TextEncoder().encode('junk'))).toBe(false)
    expect(t.arkiv.deletions).toEqual([])
  })

  it('keeps the job for a receipt naming another job', async () => {
    const t = await setup()
    const other = { ...t.receipt, jobId: `0x${'99'.repeat(32)}` }
    expect(await retireDelivered(t.deps, t.job, other, OUTPUT)).toBe(false)
    expect(t.arkiv.deletions).toEqual([])
  })

  it('keeps the job for a zero output hash', async () => {
    const t = await setup()
    expect(await retireDelivered(t.deps, t.job, { ...t.receipt, outputHash: ZERO }, new Uint8Array())).toBe(false)
    expect(t.arkiv.deletions).toEqual([])
  })

  it('with escrow, deletes only once the chain committed the same hash', async () => {
    const t = await setup({ escrow: true })
    expect(await retireDelivered(t.deps, t.job, t.receipt, OUTPUT)).toBe(true)
    expect(t.arkiv.deletions).toEqual([t.job.id])
  })

  it('with escrow, keeps the job while the deal is still funded', async () => {
    const t = await setup({ escrow: true })
    t.escrow!.deals.set(t.job.escrowId, { ...t.escrow!.deals.get(t.job.escrowId)!, state: 'funded', outputHash: ZERO })
    expect(await retireDelivered(t.deps, t.job, t.receipt, OUTPUT)).toBe(false)
    expect(t.arkiv.deletions).toEqual([])
  })

  it('with escrow, keeps the job when the committed hash differs from the receipt', async () => {
    const t = await setup({ escrow: true })
    t.escrow!.deals.set(t.job.escrowId, { ...t.escrow!.deals.get(t.job.escrowId)!, outputHash: `0x${'12'.repeat(32)}` })
    expect(await retireDelivered(t.deps, t.job, t.receipt, OUTPUT)).toBe(false)
    expect(t.arkiv.deletions).toEqual([])
  })

  it('reports false rather than throwing when the delete fails', async () => {
    const t = await setup()
    t.arkiv.del = async () => {
      throw new Error('NotOwner')
    }
    expect(await retireDelivered(t.deps, t.job, t.receipt, OUTPUT)).toBe(false)
  })
})
