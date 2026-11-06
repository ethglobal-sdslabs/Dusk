import type { Claim, Job, Kind, Receipt } from '@dusk/core'
import type { ArkivReader } from '@dusk/arkiv'
import type { Expression } from '@arkiv-network/sdk/query'
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { generatePrivateKey } from 'viem/accounts'
import { keccak256, toHex, type Hex } from 'viem'
import { grantTargets, readJobs, type JobSnapshot } from '../src/lib/buy'

const BUYER_KEY = generatePrivateKey()

function job(id: Hex, escrowId: Hex): Job {
  return {
    id,
    model: 'm',
    maxPricePer1kOut: 1n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'public',
    inputRef: 'ab'.repeat(32),
    inputHash: `0x${'33'.repeat(32)}`,
    buyerPubkey: privateKeyToAccount(BUYER_KEY).publicKey,
    escrowId,
    status: 'open',
    expiresAt: 2_000_000,
  }
}

const JOB_A = job(`0x${'a1'.repeat(32)}`, `0x${'e1'.repeat(32)}`)
const JOB_B = job(`0x${'b2'.repeat(32)}`, `0x${'e2'.repeat(32)}`)

function claimOn(jobId: string): Claim {
  return { id: `${jobId}-claim`, jobId, workerId: `0x${'99'.repeat(32)}`, price: 1n, claimedAt: 1 }
}

function receiptOn(jobId: string): Receipt {
  return {
    id: `${jobId}-receipt`,
    jobId,
    worker: `0x${'77'.repeat(20)}`,
    modelServed: 'm',
    outputRef: 'cd'.repeat(32),
    outputHash: `0x${'88'.repeat(32)}`,
    trustMode: 'verified',
    creditsSpent: 'tokens:1/1',
    latencyMs: 10,
    escrowId: `0x${'e9'.repeat(32)}`,
    tokensIn: 1,
    tokensOut: 1,
  }
}

function readerOf(
  rows: { jobs: Job[]; claims: Claim[]; receipts: Receipt[] },
  failOn?: (kind: Kind, callNo: number) => boolean,
): ArkivReader {
  let n = 0
  return {
    async query<T>(kind: Kind, _filter?: Expression): Promise<T[]> {
      n += 1
      if (failOn?.(kind, n)) throw new Error(`arkiv refused the ${kind} query`)
      const out =
        kind === 'job' ? rows.jobs : kind === 'claim' ? rows.claims : kind === 'receipt' ? rows.receipts : []
      return out as unknown as T[]
    },
  }
}

describe('readJobs', () => {
  it('returns one snapshot per job, keyed by job id', async () => {
    const reader = readerOf({ jobs: [JOB_A, JOB_B], claims: [], receipts: [] })
    const snaps = await readJobs(reader, [JOB_A, JOB_B], 1_000)
    expect([...snaps.keys()]).toEqual([JOB_A.id, JOB_B.id])
  })

  it('keeps each job’s claims and receipt with that job', async () => {
    const reader = readerOf({
      jobs: [JOB_A, JOB_B],
      claims: [claimOn(JOB_A.id)],
      receipts: [receiptOn(JOB_B.id)],
    })
    const snaps = await readJobs(reader, [JOB_A, JOB_B], 1_000)

    expect(snaps.get(JOB_A.id)?.claims).toHaveLength(1)
    expect(snaps.get(JOB_A.id)?.receipt).toBeUndefined()
    expect(snaps.get(JOB_B.id)?.claims).toEqual([])
    expect(snaps.get(JOB_B.id)?.receipt?.jobId).toBe(JOB_B.id)
  })

  it('does not let one job’s failed read blank the others', async () => {
    const reader = readerOf(
      { jobs: [JOB_A, JOB_B], claims: [claimOn(JOB_A.id)], receipts: [] },
      (kind, callNo) => kind === 'receipt' && callNo > 3,
    )
    const snaps = await readJobs(reader, [JOB_A, JOB_B], 1_000)

    expect(snaps.get(JOB_A.id)?.claims).toHaveLength(1)
    expect(snaps.has(JOB_B.id)).toBe(false)
  })

  it('returns an empty map for no jobs, without asking Arkiv anything', async () => {
    let asked = 0
    const reader: ArkivReader = {
      async query<T>(): Promise<T[]> {
        asked += 1
        return [] as unknown as T[]
      },
    }
    expect(await readJobs(reader, [], 1_000)).toEqual(new Map())
    expect(asked).toBe(0)
  })

  it('reports a job whose entity has expired as absent rather than dropping the row', async () => {
    const reader = readerOf({ jobs: [], claims: [], receipts: [] })
    const snaps = await readJobs(reader, [JOB_A], 1_000)
    expect(snaps.get(JOB_A.id)?.job).toBeUndefined()
    expect(snaps.get(JOB_A.id)?.readAt).toBe(1_000)
  })
})

describe('grantTargets', () => {
  const PRIVATE_A: Job = { ...JOB_A, visibility: 'private' }
  const PRIVATE_B: Job = { ...JOB_B, visibility: 'private' }
  function worker(key = generatePrivateKey()) {
    const account = privateKeyToAccount(key)
    return {
      workerId: keccak256(toHex(account.address)),
      owner: account.address,
      workerPubkey: account.publicKey,
    }
  }

  const WORKER = worker()
  const OTHER = worker()

  function claimWithKey(jobId: string, w: ReturnType<typeof worker>): Claim {
    return {
      id: `${jobId}-${w.workerId}`,
      jobId,
      workerId: w.workerId,
      price: 1n,
      claimedAt: 1,
      workerPubkey: w.workerPubkey,
      owner: w.owner,
    }
  }

  function snapsOf(entries: Array<[Job, Claim[]]>): Map<string, JobSnapshot> {
    return new Map(
      entries.map(([job, claims]) => [
        job.id,
        { job, claims, receipt: undefined, readAt: 1_000 } satisfies JobSnapshot,
      ]),
    )
  }

  it('seals the same worker on two different jobs', () => {
    const targets = grantTargets({
      jobs: [PRIVATE_A, PRIVATE_B],
      snapshots: snapsOf([
        [PRIVATE_A, [claimWithKey(PRIVATE_A.id, WORKER)]],
        [PRIVATE_B, [claimWithKey(PRIVATE_B.id, WORKER)]],
      ]),
      granted: new Map([[PRIVATE_A.id, new Set([WORKER.workerId])]]),
    })

    expect(targets.map((t) => t.job.id)).toEqual([PRIVATE_B.id])
  })

  it('never authorises a banned seller, and falls through to the next claimant', () => {
    const targets = grantTargets({
      jobs: [PRIVATE_A],
      snapshots: snapsOf([[PRIVATE_A, [claimWithKey(PRIVATE_A.id, WORKER), claimWithKey(PRIVATE_A.id, OTHER)]]]),
      granted: new Map(),
      banned: new Set([WORKER.owner.toLowerCase()]),
    })

    expect(targets.map((t) => t.claim.owner)).toEqual([OTHER.owner])
  })

  it('does not seal the same worker twice on the same job', () => {
    const targets = grantTargets({
      jobs: [PRIVATE_A],
      snapshots: snapsOf([[PRIVATE_A, [claimWithKey(PRIVATE_A.id, WORKER)]]]),
      granted: new Map([[PRIVATE_A.id, new Set([WORKER.workerId])]]),
    })

    expect(targets).toEqual([])
  })

  it('targets a public job too, which needs a CommitAuth even though nothing is sealed', () => {
    const targets = grantTargets({
      jobs: [JOB_A],
      snapshots: snapsOf([[JOB_A, [claimWithKey(JOB_A.id, WORKER)]]]),
      granted: new Map(),
    })

    expect(targets.map((t) => t.job.id)).toEqual([JOB_A.id])
  })

  it('targets a public job whose claim published no workerPubkey, since none is needed', () => {
    const claim = { ...claimWithKey(JOB_A.id, WORKER), workerPubkey: undefined }
    const targets = grantTargets({
      jobs: [JOB_A],
      snapshots: snapsOf([[JOB_A, [claim]]]),
      granted: new Map(),
    })

    expect(targets.map((t) => t.claim.workerId)).toEqual([claim.workerId])
  })

  it('does not target the same worker twice on a public job either', () => {
    const claim = claimWithKey(JOB_A.id, WORKER)
    const targets = grantTargets({
      jobs: [JOB_A],
      snapshots: snapsOf([[JOB_A, [claim]]]),
      granted: new Map([[JOB_A.id, new Set([claim.workerId])]]),
    })

    expect(targets).toEqual([])
  })

  it('ignores a job whose read failed this pass rather than guessing', () => {
    const targets = grantTargets({
      jobs: [PRIVATE_A],
      snapshots: new Map(),
      granted: new Map(),
    })

    expect(targets).toEqual([])
  })

  it('returns a target per job when both are unsealed', () => {
    const targets = grantTargets({
      jobs: [PRIVATE_A, PRIVATE_B],
      snapshots: snapsOf([
        [PRIVATE_A, [claimWithKey(PRIVATE_A.id, WORKER)]],
        [PRIVATE_B, [claimWithKey(PRIVATE_B.id, OTHER)]],
      ]),
      granted: new Map(),
    })

    expect(targets.map((t) => t.job.id)).toEqual([PRIVATE_A.id, PRIVATE_B.id])
  })
})
