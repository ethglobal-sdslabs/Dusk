import { describe, expect, it } from 'vitest'
import type { Claim, Job } from '@dusk/core'
import { keccak256, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { unseal } from '@dusk/crypto'
import { fakeArkiv, fakeEscrow } from '../../../worker/test/fakes'
import type { BuyerDeps } from '../src/post'
import { grantCandidates, grantUntilDelivered, writeGrant } from '../src/grant'

const JOB_ID: Hex = `0x${'11'.repeat(32)}`
const OTHER_JOB_ID: Hex = `0x${'22'.repeat(32)}`

function privateJob(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    model: 'm',
    maxPricePer1kOut: 1n,
    maxTokens: 8,
    trustMode: 'verified',
    visibility: 'private',
    inputHash: `0x${'33'.repeat(32)}`,
    buyerPubkey: `0x${'04'}${'ab'.repeat(64)}`,
    escrowId: `0x${'44'.repeat(32)}`,
    status: 'open',
    expiresAt: 10_000,
    ...over,
  }
}

function honestClaim(over: Partial<Claim> = {}): Claim {
  const account = privateKeyToAccount(generatePrivateKey())
  return {
    id: `claim-${account.address}`,
    jobId: JOB_ID,
    workerId: keccak256(toHex(account.address)),
    price: 1n,
    claimedAt: 1_000,
    workerPubkey: account.publicKey,
    owner: account.address,
    ...over,
  }
}

describe('grantCandidates', () => {
  it('returns an owner-bound claim for this job', () => {
    const claim = honestClaim()
    expect(grantCandidates(privateJob(), [claim])).toEqual([claim])
  })

  it('drops a claim for a different job, even when the index returned it', () => {
    const mine = honestClaim()
    const theirs = honestClaim({ jobId: OTHER_JOB_ID })
    expect(grantCandidates(privateJob(), [theirs, mine])).toEqual([mine])
  })

  it('drops a claim with no workerPubkey, because a grant sealed to nothing opens for nobody', () => {
    const blind = honestClaim()
    delete blind.workerPubkey
    expect(grantCandidates(privateJob(), [blind])).toEqual([])
  })

  it('drops a claim whose pubkey belongs to an account other than the signer', () => {
    const impostor = privateKeyToAccount(generatePrivateKey())
    const victim = privateKeyToAccount(generatePrivateKey())
    const forged = honestClaim({
      workerPubkey: victim.publicKey,
      owner: impostor.address,
      workerId: keccak256(toHex(impostor.address)),
    })
    expect(grantCandidates(privateJob(), [forged])).toEqual([])
  })

  it('drops a claim whose workerId is not the hash of the signing account', () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const forged = honestClaim({
      workerPubkey: account.publicKey,
      owner: account.address,
      workerId: keccak256(toHex('somebody else')),
    })
    expect(grantCandidates(privateJob(), [forged])).toEqual([])
  })

  it('drops a claim with no owner — an entity not yet stamped by the engine', () => {
    const unstamped = honestClaim()
    delete unstamped.owner
    expect(grantCandidates(privateJob(), [unstamped])).toEqual([])
  })

  it('drops a claim whose workerPubkey is not a public key at all', () => {
    expect(grantCandidates(privateJob(), [honestClaim({ workerPubkey: '0xnotakey' as Hex })])).toEqual([])
  })

  it('orders by claimedAt ascending, the same rule winningClaim applies', () => {
    const late = honestClaim({ claimedAt: 5_000 })
    const early = honestClaim({ claimedAt: 1_000 })
    expect(grantCandidates(privateJob(), [late, early]).map((c) => c.claimedAt)).toEqual([1_000, 5_000])
  })

  it('keeps every proven claim rather than only the winner', () => {
    const a = honestClaim({ claimedAt: 1_000 })
    const b = honestClaim({ claimedAt: 2_000 })
    expect(grantCandidates(privateJob(), [b, a])).toHaveLength(2)
  })

  it('puts a forged zero-claimedAt claim first and still excludes it', () => {
    const honest = honestClaim({ claimedAt: 9_000 })
    const griefer = privateKeyToAccount(generatePrivateKey())
    const forged = honestClaim({
      claimedAt: 0,
      workerPubkey: privateKeyToAccount(generatePrivateKey()).publicKey,
      owner: griefer.address,
      workerId: keccak256(toHex(griefer.address)),
    })
    expect(grantCandidates(privateJob(), [forged, honest])).toEqual([honest])
  })

  it('returns nothing for an empty claim set', () => {
    expect(grantCandidates(privateJob(), [])).toEqual([])
  })
})

describe('writeGrant', () => {
  function deps(arkiv: ReturnType<typeof fakeArkiv>): BuyerDeps {
    return {
      arkiv,
      swarm: null as never,
      buyerPubkey: '0x04',
      now: () => 1_000,
      clock: { resetAt: 'daily-utc-midnight' },
      ttlGrantSeconds: 300,
    }
  }

  it('writes one grant, sealed so only the claimant can open it', async () => {
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)
    const claim = honestClaim({
      workerPubkey: account.publicKey,
      owner: account.address,
      workerId: keccak256(toHex(account.address)),
    })
    const arkiv = fakeArkiv()
    const ref = 'f'.repeat(128)

    const id = await writeGrant(deps(arkiv), privateJob(), claim, ref)

    expect(id).not.toBeNull()
    const grants = arkiv.all<{ jobId: string; workerId: string; sealedRef: Hex }>('grant')
    expect(grants).toHaveLength(1)
    expect(grants[0]!.jobId).toBe(JOB_ID)
    expect(grants[0]!.workerId).toBe(claim.workerId)
    expect(grants[0]!.sealedRef).not.toContain(ref)
    expect(unseal(grants[0]!.sealedRef, key)).toBe(ref)
  })

  it('grants nothing to a claimant admission refuses, so the next claim can be tried', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const claim = honestClaim({ workerPubkey: account.publicKey, owner: account.address, workerId: keccak256(toHex(account.address)) })
    const arkiv = fakeArkiv()
    const asked: string[] = []
    const admit = async (action: 'new-job' | 'new-grant', wallet: Hex) => { asked.push(`${action}:${wallet}`); return { allowed: false } }
    expect(await writeGrant({ ...deps(arkiv), admit }, privateJob(), claim, 'f'.repeat(128))).toBeNull()
    expect(arkiv.all('grant')).toHaveLength(0)
    expect(asked).toEqual([`new-grant:${account.address}`])
  })

  it('treats a failing admission check as a refusal', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const claim = honestClaim({ workerPubkey: account.publicKey, owner: account.address, workerId: keccak256(toHex(account.address)) })
    const arkiv = fakeArkiv()
    const admit = async () => { throw new Error('sepolia down') }
    expect(await writeGrant({ ...deps(arkiv), admit }, privateJob(), claim, 'f'.repeat(128))).toBeNull()
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('grants nothing when the worker is admitted but the buyer has no active name', async () => {
    const arkiv = fakeArkiv()
    const claim = honestClaim()
    const buyer = deps(arkiv)
    const asked: string[] = []
    const admit = async (_action: 'new-job' | 'new-grant', wallet: Hex) => {
      asked.push(wallet)
      return { allowed: wallet.toLowerCase() !== buyer.arkiv.address.toLowerCase() }
    }
    expect(await writeGrant({ ...buyer, admit }, privateJob(), claim, 'f'.repeat(128))).toBeNull()
    expect(asked).toEqual([claim.owner, buyer.arkiv.address])
    expect(arkiv.all('grant')).toHaveLength(0)
  })

  it('writes the grant with the configured TTL, never a number of its own', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const claim = honestClaim({
      workerPubkey: account.publicKey,
      owner: account.address,
      workerId: keccak256(toHex(account.address)),
    })
    const arkiv = fakeArkiv()
    await writeGrant({ ...deps(arkiv), ttlGrantSeconds: 120 }, privateJob(), claim, 'f'.repeat(128))
    expect(arkiv.rows[0]!.expiresAtMs).toBe(1_000 + 120_000)
  })

  it('returns null rather than throwing when seal rejects the key, so the caller tries the next claim', async () => {
    const arkiv = fakeArkiv()
    const id = await writeGrant(
      deps(arkiv),
      privateJob(),
      honestClaim({ workerPubkey: '0xnotakey' as Hex }),
      'f'.repeat(128),
    )
    expect(id).toBeNull()
    expect(arkiv.rows).toHaveLength(0)
  })
})


describe('grantUntilDelivered', () => {
  const POLL = { pollMs: 1 }
  const publicJob = (): Job => ({ ...privateJob(), visibility: 'public', inputRef: 'a'.repeat(64), expiresAt: Number.MAX_SAFE_INTEGER })

  function setup() {
    const arkiv = fakeArkiv()
    const escrow = fakeEscrow()
    const job = publicJob()
    escrow.deals.set(job.escrowId, {
      buyer: arkiv.address,
      worker: `0x${'00'.repeat(20)}`,
      amount: 8n,
      outputHash: `0x${'00'.repeat(32)}`,
      commitAtSec: 0,
      deadlineSec: 9_999_999_999,
      state: 'funded',
    })
    const deps: BuyerDeps = {
      arkiv,
      escrow,
      swarm: null as never,
      buyerPubkey: '0x04',
      now: () => Date.now(),
      clock: { resetAt: 'daily-utc-midnight' },
      ttlGrantSeconds: 300,
    }
    return { arkiv, escrow, job, deps }
  }

  async function seedClaimFor(arkiv: ReturnType<typeof fakeArkiv>, claim: Claim): Promise<string> {
    const { id: _id, owner, ...data } = claim
    return arkiv.putAs(owner!, 'claim', data, { ttlSeconds: 90 })
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 2_000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
    expect(cond()).toBe(true)
  }

  const grantsFor = (arkiv: ReturnType<typeof fakeArkiv>, workerId: string) =>
    arkiv.all<{ workerId: string }>('grant').filter((g) => g.workerId === workerId)

  it('authorises the next claimant after the first authorised worker dies', async () => {
    const { arkiv, escrow, job, deps } = setup()
    const a = honestClaim()
    const aId = await seedClaimFor(arkiv, a)
    const run = grantUntilDelivered(deps, job, undefined, POLL)

    await until(() => grantsFor(arkiv, a.workerId).length === 1)
    await arkiv.del(aId)
    const b = honestClaim()
    await seedClaimFor(arkiv, b)
    await until(() => grantsFor(arkiv, b.workerId).length === 1)

    escrow.deals.set(job.escrowId, { ...escrow.deals.get(job.escrowId)!, state: 'committed' })
    const bGrant = arkiv.all<{ id: string; workerId: string }>('grant').find((g) => g.workerId === b.workerId)
    expect(await run).toBe(bGrant!.id)
  })

  it('does not authorise a second live claimant while the first holds a fresh grant', async () => {
    const { arkiv, escrow, job, deps } = setup()
    const a = honestClaim()
    await seedClaimFor(arkiv, a)
    const run = grantUntilDelivered(deps, job, undefined, POLL)
    await until(() => grantsFor(arkiv, a.workerId).length === 1)

    const b = honestClaim()
    await seedClaimFor(arkiv, b)
    await new Promise((r) => setTimeout(r, 30))
    expect(grantsFor(arkiv, b.workerId)).toHaveLength(0)
    expect(grantsFor(arkiv, a.workerId)).toHaveLength(1)

    escrow.deals.set(job.escrowId, { ...escrow.deals.get(job.escrowId)!, state: 'committed' })
    await run
  })

  it('stops once the deal is no longer funded, returning the grant it wrote', async () => {
    const { arkiv, escrow, job, deps } = setup()
    await seedClaimFor(arkiv, honestClaim())
    const run = grantUntilDelivered(deps, job, undefined, POLL)
    await until(() => arkiv.all('grant').length === 1)
    escrow.deals.set(job.escrowId, { ...escrow.deals.get(job.escrowId)!, state: 'committed' })
    expect(await run).toBe(arkiv.all<{ id: string }>('grant')[0]!.id)
  })

  it('returns null when the job expires with nobody to authorise', async () => {
    const { job, deps } = setup()
    const soon = { ...job, expiresAt: Date.now() + 20 }
    expect(await grantUntilDelivered(deps, soon, undefined, POLL)).toBeNull()
  })
})
