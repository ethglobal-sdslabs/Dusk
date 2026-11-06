import { describe, expect, it } from 'vitest'
import type { Claim, Job, Receipt } from '@dusk/core'
import type { Hex } from 'viem'
import { creditsSpentView, jobStage, leaseRemainingMs, shortHash } from '../src/lib/buy-receipt'

const JOB_ID: Hex = `0x${'11'.repeat(32)}`

function job(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    model: 'm',
    maxPricePer1kOut: 1n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'public',
    inputHash: `0x${'33'.repeat(32)}`,
    buyerPubkey: `0x04${'ab'.repeat(64)}`,
    escrowId: `0x${'44'.repeat(32)}`,
    status: 'open',
    expiresAt: 10_000,
    ...over,
  }
}

function claim(over: Partial<Claim> = {}): Claim {
  return { id: 'c1', jobId: JOB_ID, workerId: `0x${'55'.repeat(32)}`, price: 1n, claimedAt: 1_000, ...over }
}

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    id: 'r1',
    jobId: JOB_ID,
    escrowId: `0x${'44'.repeat(32)}`,
    worker: '0x390DFCe882AdaC0F4ab01EFd57e913D37eDFe33c',
    modelServed: '0gm-1.0-35b-a3b',
    creditsSpent: 'tokens:31/8',
    tokensIn: 31,
    tokensOut: 8,
    outputRef: 'a'.repeat(64),
    outputHash: `0x${'66'.repeat(32)}`,
    latencyMs: 2_410,
    trustMode: 'verified',
    ...over,
  }
}

describe('creditsSpentView', () => {
  it('calls a tokens:in/out figure a proxy and says what it is instead', () => {
    const view = creditsSpentView('tokens:31/8')
    expect(view.kind).toBe('proxy')
    expect(view.figure).toBe('tokens:31/8')
    expect(view.note).toMatch(/token/i)
  })

  it('calls a positive integer a measured delta', () => {
    const view = creditsSpentView('7')
    expect(view.kind).toBe('measured')
    expect(view.figure).toBe('7')
  })

  it.each(['tokens:31/8', '7', '0', '', 'something else'])(
    'always says the figure is the worker’s own claim (%s)',
    (raw) => {
      const view = creditsSpentView(raw)
      expect(view.note).toMatch(/worker/i)
      expect(view.note).not.toMatch(/(?<!not an |never an )attestation/i)
      expect(view.note).not.toMatch(/signed by 0G|proof from 0G|0G confirms|verified by 0G/i)
    },
  )

  it('never presents a zero as "cost nothing"', () => {
    const view = creditsSpentView('0')
    expect(view.kind).toBe('unstated')
    expect(view.note).not.toMatch(/free|nothing|no cost/i)
  })

  it('treats an empty or unparseable figure as unstated rather than guessing', () => {
    expect(creditsSpentView('').kind).toBe('unstated')
    expect(creditsSpentView('about a penny').kind).toBe('unstated')
  })

  it('refuses a negative figure, which no honest worker writes', () => {
    expect(creditsSpentView('-7').kind).toBe('unstated')
  })
})

describe('jobStage', () => {
  it('is open before anyone claims', () => {
    expect(jobStage({ job: job(), claims: [], receipt: undefined, now: 0, ttlClaimSec: 90 })).toBe('open')
  })

  it('is claimed while a lease is live', () => {
    const stage = jobStage({
      job: job(),
      claims: [claim({ claimedAt: 1_000 })],
      receipt: undefined,
      now: 2_000,
      ttlClaimSec: 90,
    })
    expect(stage).toBe('claimed')
  })

  it('is open again once the lease has lapsed, which is the whole worker-kill scene', () => {
    const stage = jobStage({
      job: job({ expiresAt: 600_000 }),
      claims: [claim({ claimedAt: 1_000 })],
      receipt: undefined,
      now: 1_000 + 91_000,
      ttlClaimSec: 90,
    })
    expect(stage).toBe('open')
  })

  it('is delivered once a receipt exists, whatever the claim says', () => {
    const stage = jobStage({ job: job(), claims: [], receipt: receipt(), now: 0, ttlClaimSec: 90 })
    expect(stage).toBe('delivered')
  })

  it('is delivered even past the job’s own expiry — a receipt outlives the job entity', () => {
    const stage = jobStage({ job: job(), claims: [], receipt: receipt(), now: 99_999_999, ttlClaimSec: 90 })
    expect(stage).toBe('delivered')
  })

  it('is lapsed when the job’s own deadline passed with nothing delivered', () => {
    const stage = jobStage({ job: job(), claims: [], receipt: undefined, now: 10_000, ttlClaimSec: 90 })
    expect(stage).toBe('lapsed')
  })

  it('picks the newest live lease when two claims race', () => {
    const stage = jobStage({
      job: job(),
      claims: [claim({ id: 'old', claimedAt: 0 }), claim({ id: 'new', claimedAt: 9_000 })],
      receipt: undefined,
      now: 9_500,
      ttlClaimSec: 90,
    })
    expect(stage).toBe('claimed')
  })
})

describe('leaseRemainingMs', () => {
  it('counts down from the claim’s own claimedAt, not from when this tab noticed', () => {
    expect(leaseRemainingMs(claim({ claimedAt: 1_000 }), 90, 31_000)).toBe(60_000)
  })

  it('clamps at zero rather than going negative', () => {
    expect(leaseRemainingMs(claim({ claimedAt: 0 }), 90, 200_000)).toBe(0)
  })
})

describe('shortHash', () => {
  it('keeps both ends, because the ends are what a person compares', () => {
    const short = shortHash(`0x${'ab'.repeat(32)}`)
    expect(short.startsWith('0xabab')).toBe(true)
    expect(short.endsWith('abab')).toBe(true)
    expect(short.length).toBeLessThan(24)
  })

  it('leaves a short value alone', () => {
    expect(shortHash('0xdead')).toBe('0xdead')
  })
})
