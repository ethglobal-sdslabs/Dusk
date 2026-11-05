import { describe, expect, it } from 'vitest'
import type { Deal, EscrowClient, EscrowIdRef, Grant, Job } from '@dusk/core'
import { escrowDeadlineSec, jobPriceWei, jobTokens } from '@dusk/core'
import { EscrowReceiptTimeoutError, EscrowRevertError } from '@dusk/escrow'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/utils'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { unseal } from '@dusk/crypto'
import { fakeArkiv, fakeSwarm } from '../../worker/test/fakes'
import {
  grantOnClaim,
  newEscrowId,
  postJob,
  postPrivateJob,
  StuckDealError,
  type BuyerDeps,
  type JobSpec,
} from '../post-job'

const FIXED_ESCROW_ID: Hex = `0x${'ab'.repeat(32)}`
const FIXED_FUND_TX: Hex = `0x${'cd'.repeat(32)}`
const BUYER_ENCRYPTION_PUBLIC_KEY = privateKeyToAccount(generatePrivateKey()).publicKey

const dump = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))

type FakeEscrow = EscrowClient & {
  funded: Array<{ jobId: Hex; deadlineSec: number; amountWei: bigint }>
}

function fakeEscrow(opts: { log?: string[]; fundError?: Error } = {}): FakeEscrow {
  const funded: FakeEscrow['funded'] = []
  return {
    funded,
    async deal(): Promise<Deal> {
      throw new Error('not used by postJob')
    },
    async fundedBy(): Promise<EscrowIdRef[]> {
      throw new Error('not used by postJob')
    },
    async committedBy(): Promise<EscrowIdRef[]> {
      throw new Error('not used by postJob')
    },
    async fund(jobId: Hex, deadlineSec: number, amountWei: bigint): Promise<Hex> {
      opts.log?.push('fund')
      if (opts.fundError) throw opts.fundError
      funded.push({ jobId, deadlineSec, amountWei })
      return FIXED_FUND_TX
    },
    async commit(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
    async commitRefusal(): Promise<string | undefined> {
      throw new Error('not used by postJob')
    },
    async settleVerified(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
    async reject(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
    async signVerdict(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
    async settle(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
    async signCommitAuth(jobId: Hex, worker: Address): Promise<Hex> {
      opts.log?.push('signCommitAuth')
      return keccak256(toHex(`fake-auth:${jobId}:${worker}`))
    },
    async refund(): Promise<Hex> {
      throw new Error('not used by postJob')
    },
  }
}

function withPutLogged<T extends { put: (...args: never[]) => Promise<string> }>(
  arkiv: T,
  log: string[],
): T {
  const put = arkiv.put.bind(arkiv)
  return {
    ...arkiv,
    put: (async (...args: never[]) => {
      log.push('put')
      return put(...args)
    }) as T['put'],
  }
}

function buildDeps(over: { escrow?: EscrowClient; log?: string[]; buyerPubkey?: Hex } = {}): {
  deps: BuyerDeps
  arkiv: ReturnType<typeof fakeArkiv>
  swarm: ReturnType<typeof fakeSwarm>
} {
  const log = over.log ?? []
  const arkiv = withPutLogged(fakeArkiv(), log)
  const swarm = fakeSwarm()
  return {
    deps: {
      arkiv,
      swarm,
      buyerPubkey: over.buyerPubkey ?? BUYER_ENCRYPTION_PUBLIC_KEY,
      now: () => 1_000,
      clock: { resetAt: 'daily-utc-midnight' },
      ttlGrantSeconds: 300,
      escrow: over.escrow,
    },
    arkiv,
    swarm,
  }
}

const SPEC: JobSpec = {
  prompt: 'hi',
  model: '0gm-1.0-35b-a3b',
  maxPricePer1kOut: 1_000_000n,
  maxTokens: 8,
  deadlineMs: 600_000,
  escrowId: FIXED_ESCROW_ID,
}

describe('postJob', () => {
  it('refuses before uploading, funding or writing anything when admission says no', async () => {
    const log: string[] = []
    const escrow = fakeEscrow({ log })
    const { deps, arkiv } = buildDeps({ escrow, log })
    const admit = async () => ({ allowed: false, reason: 'This wallet cannot start new work.' })
    await expect(postJob({ ...deps, admit }, SPEC)).rejects.toThrow(/cannot start new work/)
    expect(log).toEqual([])
    expect(escrow.funded).toHaveLength(0)
    expect(arkiv.all('job')).toHaveLength(0)
  })

  it('treats an admission check that throws as a refusal', async () => {
    const escrow = fakeEscrow()
    const { deps } = buildDeps({ escrow })
    await expect(postJob({ ...deps, admit: async () => { throw new Error('down') } }, SPEC)).rejects.toThrow(/could not be verified/)
    expect(escrow.funded).toHaveLength(0)
  })

  it('funds the escrow before writing the job entity', async () => {
    const log: string[] = []
    const escrow = fakeEscrow({ log })
    const { deps } = buildDeps({ escrow, log })

    await postJob(deps, SPEC)

    expect(log).toEqual(['fund', 'put'])
  })

  it('funds the price of the prompt and the whole answer budget', async () => {
    const escrow = fakeEscrow()
    const { deps } = buildDeps({ escrow })

    await postJob(deps, SPEC)

    expect(escrow.funded[0]?.amountWei).toBe(29_000n)
    expect(escrow.funded[0]?.amountWei).toBe(
      jobPriceWei(SPEC.maxPricePer1kOut, jobTokens({ maxTokens: SPEC.maxTokens, inputChars: SPEC.prompt.length })),
    )
  })

  it('funds an image job at price per image × count', async () => {
    const escrow = fakeEscrow()
    const { deps } = buildDeps({ escrow })

    await postJob({ ...deps, imageModels: ['z-image-turbo'] }, { ...SPEC, model: 'z-image-turbo', maxTokens: 2, maxPricePer1kOut: 8_000n })

    expect(escrow.funded[0]?.amountWei).toBe(16_000n)
  })

  it('writes the funded escrowId onto the entity, not a hash of the prompt', async () => {
    const escrow = fakeEscrow()
    const { deps, arkiv } = buildDeps({ escrow })

    const job = await postJob(deps, SPEC)

    expect(job.escrowId).toBe(FIXED_ESCROW_ID)
    expect(escrow.funded[0]?.jobId).toBe(FIXED_ESCROW_ID)
    expect(arkiv.all<Job>('job')[0]?.escrowId).toBe(FIXED_ESCROW_ID)
  })

  it('sets the on-chain deadline no earlier than the job entity expiry', async () => {
    const escrow = fakeEscrow()
    const { deps } = buildDeps({ escrow })

    const job = await postJob(deps, SPEC)

    expect(escrow.funded[0]?.deadlineSec).toBeGreaterThanOrEqual(escrowDeadlineSec(job.expiresAt))
  })

  it('does not write a job entity when funding fails, so no unfunded job is advertised', async () => {
    const escrow = fakeEscrow({ fundError: new Error('insufficient funds') })
    const { deps, arkiv } = buildDeps({ escrow })

    await expect(postJob(deps, SPEC)).rejects.toThrow('insufficient funds')
    expect(arkiv.all('job')).toHaveLength(0)
  })

  it('carries the escrowId out of a fund receipt timeout, even when it generated the id itself', async () => {
    const timeout = new EscrowReceiptTimeoutError('fund', FIXED_FUND_TX, new Error('timed out'))
    const escrow = fakeEscrow({ fundError: timeout })
    const { deps } = buildDeps({ escrow })

    const err: unknown = await postJob(deps, { ...SPEC, escrowId: undefined }).catch((e) => e)

    expect(err).toBeInstanceOf(StuckDealError)
    const stuck = err as StuckDealError
    expect(stuck.escrowId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(stuck.fundTx).toBe(FIXED_FUND_TX)
    expect(stuck.cause).toBe(timeout)
    expect(stuck.message).toMatch(/may/i)
    expect(stuck.message).toContain(stuck.escrowId)
  })

  it('carries the escrowId out of a fund failure with no transaction hash at all', async () => {
    const escrow = fakeEscrow({ fundError: new Error('fetch failed') })
    const { deps } = buildDeps({ escrow })

    const err: unknown = await postJob(deps, { ...SPEC, escrowId: undefined }).catch((e) => e)

    expect(err).toBeInstanceOf(StuckDealError)
    expect((err as StuckDealError).escrowId).toMatch(/^0x[0-9a-f]{64}$/)
    expect((err as StuckDealError).fundTx).toBeUndefined()
    expect((err as Error).message).toContain('fetch failed')
  })

  it('lets a fund revert through untouched, because nothing was ever sent', async () => {
    const reverted = new EscrowRevertError('fund reverted: DealExists', 'DealExists')
    const escrow = fakeEscrow({ fundError: reverted })
    const { deps } = buildDeps({ escrow })

    const err: unknown = await postJob(deps, SPEC).catch((e) => e)

    expect(err).toBe(reverted)
    expect(err).not.toBeInstanceOf(StuckDealError)
  })

  it('carries escrowId and fundTx when fund succeeds but writing the entity fails, so a stuck deal is still findable', async () => {
    const escrow = fakeEscrow()
    const { deps } = buildDeps({ escrow })
    const putFailure = new Error('arkiv put: network blip')
    const brokenArkiv = { ...deps.arkiv, put: async () => Promise.reject(putFailure) }

    const err: unknown = await postJob({ ...deps, arkiv: brokenArkiv }, SPEC).catch((e) => e)

    expect(err).toBeInstanceOf(StuckDealError)
    const stuck = err as StuckDealError
    expect(stuck.escrowId).toBe(FIXED_ESCROW_ID)
    expect(stuck.fundTx).toBe(FIXED_FUND_TX)
    expect(stuck.cause).toBe(putFailure)
    expect(escrow.funded[0]?.jobId).toBe(FIXED_ESCROW_ID)
  })

  it('does not wrap a put failure in StuckDealError when nothing was funded', async () => {
    const { deps } = buildDeps()
    const putFailure = new Error('arkiv put: network blip')
    const brokenArkiv = { ...deps.arkiv, put: async () => Promise.reject(putFailure) }

    const err: unknown = await postJob({ ...deps, arkiv: brokenArkiv }, SPEC).catch((e) => e)

    expect(err).toBe(putFailure)
    expect(err).not.toBeInstanceOf(StuckDealError)
  })

  it('still posts without an escrow client, for the no-money path', async () => {
    const { deps, arkiv } = buildDeps()

    const job = await postJob(deps, SPEC)

    expect(job.escrowId).toBe(FIXED_ESCROW_ID)
    expect(job.fundTx).toBeUndefined()
    expect(arkiv.all('job')).toHaveLength(1)
  })

  it('picks a fresh random escrowId when the spec does not supply one', async () => {
    const { deps } = buildDeps()
    const a = await postJob(deps, { ...SPEC, escrowId: undefined })
    const b = await postJob(deps, { ...SPEC, escrowId: undefined })
    expect(a.escrowId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(a.escrowId).not.toBe(b.escrowId)
    expect(newEscrowId()).not.toBe(newEscrowId())
  })

  it('never puts a key-shaped string on the entity', async () => {
    const escrow = fakeEscrow()
    const { deps, arkiv } = buildDeps({ escrow })

    await postJob(deps, SPEC)

    expect(dump(arkiv.all('job'))).not.toMatch(/\b(sk|mk)-/)
  })

  it('returns a job carrying the owner the engine stamps, so the worker can serve it', async () => {
    const escrow = fakeEscrow()
    const { deps, arkiv } = buildDeps({ escrow })

    const job = await postJob(deps, SPEC)

    expect(job.owner).toBe(deps.arkiv.address)
    expect(job.owner).toBe(arkiv.all<Job>('job')[0]?.owner)
  })

  it('keeps owner off the stored payload, where it would shadow the engine field', async () => {
    const escrow = fakeEscrow()
    const { deps, arkiv } = buildDeps({ escrow })

    await postJob(deps, SPEC)

    expect(arkiv.rows[0]?.data).not.toHaveProperty('owner')
  })
})

describe('postPrivateJob', () => {
  const PRIVATE_SPEC: JobSpec = { ...SPEC, visibility: 'private' }

  it('refuses an unsupported wallet encryption key before any upload or funding', async () => {
    const log: string[] = []
    const escrow = fakeEscrow({ log })
    const { deps, swarm, arkiv } = buildDeps({ escrow, log, buyerPubkey: '0x' })
    await expect(postPrivateJob(deps, PRIVATE_SPEC)).rejects.toThrow(/valid encryption public key/)
    expect(escrow.funded).toHaveLength(0)
    expect(arkiv.all('job')).toHaveLength(0)
    expect(swarm.uploads).toHaveLength(0)
  })

  it('uploads the input encrypted and keeps the reference off the job entity', async () => {
    const { deps, swarm } = buildDeps()

    const job = await postPrivateJob(deps, PRIVATE_SPEC)

    expect(job.visibility).toBe('private')
    expect(swarm.uploads[0]).toHaveLength(128)
    expect(job.encryptedRef).toBe(swarm.uploads[0])
    expect(job.inputRef).toBeUndefined()
  })

  it('writes no reference into the stored entity, not even in the payload', async () => {
    const { deps, arkiv, swarm } = buildDeps()

    await postPrivateJob(deps, PRIVATE_SPEC)

    expect(dump(arkiv.all('job'))).not.toContain(swarm.uploads[0])
  })

  it('still commits the buyer to the prompt via inputHash', async () => {
    const { deps } = buildDeps()
    const job = await postPrivateJob(deps, PRIVATE_SPEC)
    expect(job.inputHash).toBe(keccak256(toHex(PRIVATE_SPEC.prompt)))
  })

  it('leaves a public job uploading in the clear, so a judge can open the reference', async () => {
    const { deps, swarm } = buildDeps()
    const job = await postJob(deps, SPEC)
    expect(swarm.uploads[0]).toHaveLength(64)
    expect(job.inputRef).toBe(swarm.uploads[0])
    expect(job.encryptedRef).toBeUndefined()
  })
})

describe('grantOnClaim', () => {
  const WORKER_KEY = generatePrivateKey()
  const WORKER_PUBKEY = privateKeyToAccount(WORKER_KEY).publicKey
  const WORKER_ADDRESS = publicKeyToAddress(WORKER_PUBKEY)
  const WORKER_ID = keccak256(toHex(WORKER_ADDRESS))
  const PLAIN_REF = 'a1'.repeat(64)

  async function seedClaim(
    arkiv: ReturnType<typeof fakeArkiv>,
    jobId: string,
    over: { workerPubkey?: Hex; owner?: Hex; workerId?: Hex } = {},
  ): Promise<void> {
    await arkiv.putAs(
      (over.owner ?? WORKER_ADDRESS) as Address,
      'claim',
      {
        jobId,
        workerId: over.workerId ?? WORKER_ID,
        price: 1n,
        claimedAt: 1_000,
        ...('workerPubkey' in over ? { workerPubkey: over.workerPubkey } : { workerPubkey: WORKER_PUBKEY }),
      },
      { ttlSeconds: 90 },
    )
  }

  function clockThatExpiresAfter(job: Job, reads: number): { now: () => number; reads: () => number } {
    let n = 0
    return {
      now: () => (n++ < reads ? 1_000 : job.expiresAt + 1),
      reads: () => n,
    }
  }

  it('seals the reference to the pubkey on the claim, so only that worker can open it', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await seedClaim(arkiv, job.id)

    const grantId = await grantOnClaim(deps, job, PLAIN_REF)

    expect(grantId).not.toBeNull()
    const grant = arkiv.all<Grant>('grant')[0]
    expect(unseal(grant!.sealedRef!, WORKER_KEY)).toBe(PLAIN_REF)
  })

  it('returns null when no worker claims before the job expires', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    const clock = clockThatExpiresAfter(job, 1)

    expect(await grantOnClaim({ ...deps, now: clock.now }, job, PLAIN_REF)).toBeNull()
    expect(clock.reads()).toBeGreaterThan(1)
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('skips a claim with no workerPubkey rather than sealing to nothing', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await seedClaim(arkiv, job.id, { workerPubkey: undefined })

    const clock = clockThatExpiresAfter(job, 1)

    expect(await grantOnClaim({ ...deps, now: clock.now }, job, PLAIN_REF)).toBeNull()
    expect(clock.reads()).toBeGreaterThan(1)
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('skips a claim whose workerPubkey belongs to an account other than the signer', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await seedClaim(arkiv, job.id, { owner: `0x${'ba'.repeat(20)}` })
    const clock = clockThatExpiresAfter(job, 1)

    expect(await grantOnClaim({ ...deps, now: clock.now }, job, PLAIN_REF)).toBeNull()
    expect(clock.reads()).toBeGreaterThan(1)
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('skips a claim whose workerId is not the hash of the signing account', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await seedClaim(arkiv, job.id, { workerId: `0x${'cc'.repeat(32)}` })
    const clock = clockThatExpiresAfter(job, 1)

    expect(await grantOnClaim({ ...deps, now: clock.now }, job, PLAIN_REF)).toBeNull()
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('still seals to a well-formed claim alongside a forged one, rather than aborting', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    const attackerKey = generatePrivateKey()
    const attackerPubkey = privateKeyToAccount(attackerKey).publicKey
    await arkiv.putAs(
      `0x${'ba'.repeat(20)}`,
      'claim',
      { jobId: job.id, workerId: WORKER_ID, price: 1n, claimedAt: 0, workerPubkey: attackerPubkey },
      { ttlSeconds: 90 },
    )
    await seedClaim(arkiv, job.id)

    const grantId = await grantOnClaim(deps, job, PLAIN_REF)

    expect(grantId).not.toBeNull()
    expect(unseal(arkiv.all<Grant>('grant')[0]!.sealedRef!, WORKER_KEY)).toBe(PLAIN_REF)
  })

  it('skips a claim whose workerPubkey cannot be parsed at all, and keeps polling', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await arkiv.putAs(
      WORKER_ADDRESS,
      'claim',
      {
        jobId: job.id,
        workerId: WORKER_ID,
        price: 1n,
        claimedAt: 0,
        workerPubkey: `0x${'22'.repeat(33)}`,
      },
      { ttlSeconds: 90 },
    )
    await seedClaim(arkiv, job.id)

    const grantId = await grantOnClaim(deps, job, PLAIN_REF)

    expect(grantId).not.toBeNull()
    expect(unseal(arkiv.all<Grant>('grant')[0]!.sealedRef!, WORKER_KEY)).toBe(PLAIN_REF)
  })

  it('refuses a reference to seal on a public job, where nothing is sealed', async () => {
    const { deps } = buildDeps()
    const job = await postJob(deps, SPEC)
    await expect(grantOnClaim(deps, job, PLAIN_REF)).rejects.toThrow(/reference to seal/i)
  })

  it('writes a CommitAuth-only grant for a public job, since nothing needs sealing', async () => {
    const { deps, arkiv } = buildDeps({ escrow: fakeEscrow() })
    const job = await postJob(deps, SPEC)
    await seedClaim(arkiv, job.id)

    const id = await grantOnClaim(deps, job)
    expect(id).not.toBeNull()

    const [grant] = arkiv.all<Grant>('grant')
    expect(grant!.commitAuth).toBeDefined()
    expect(grant!.sealedRef).toBeUndefined()
  })

  it('never writes a key-shaped string to a grant entity', async () => {
    const { deps, arkiv } = buildDeps()
    const job = await postPrivateJob(deps, { ...SPEC, visibility: 'private' })
    await seedClaim(arkiv, job.id)

    await grantOnClaim(deps, job, PLAIN_REF)

    expect(dump(arkiv.all('grant'))).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('postJob — a piece of a split job', () => {
  it('carries its parent, position and count onto the job entity', async () => {
    const { deps, arkiv } = buildDeps({ escrow: fakeEscrow() })
    const parentId = `0x${'5a'.repeat(32)}` as const
    const job = await postJob(deps, { ...SPEC, piece: { parentId, index: 1, count: 3 } })
    expect(job).toMatchObject({ parentId, pieceIndex: 1, pieceCount: 3 })
    expect(arkiv.rows.at(-1)?.data ?? arkiv.rows.at(-1)).toMatchObject({ parentId, pieceIndex: 1, pieceCount: 3 })
  })
})
