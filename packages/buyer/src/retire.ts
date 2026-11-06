import type { Job, Receipt } from '@dusk/core'
import { keccak256 } from 'viem'
import type { BuyerDeps } from './post'

const ZERO_HASH = `0x${'0'.repeat(64)}`
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function retireDelivered(
  deps: Pick<BuyerDeps, 'arkiv' | 'escrow'>,
  job: Pick<Job, 'id' | 'escrowId'>,
  receipt: Pick<Receipt, 'jobId' | 'outputHash'> & Partial<Pick<Receipt, 'escrowId'>>,
  output: Uint8Array,
): Promise<boolean> {
  if (receipt.jobId !== job.id) return false
  if (receipt.escrowId !== undefined && !same(receipt.escrowId, job.escrowId)) return false
  if (same(receipt.outputHash, ZERO_HASH) || !same(keccak256(output), receipt.outputHash)) return false
  try {
    if (deps.escrow) {
      const deal = await deps.escrow.deal(job.escrowId)
      if (deal.state !== 'committed' && deal.state !== 'settled') return false
      if (!same(deal.outputHash, receipt.outputHash)) return false
      if (!same(deal.buyer, deps.arkiv.address)) return false
    }
    await deps.arkiv.del(job.id)
    return true
  } catch {
    return false
  }
}
