import type { Claim, Job, Receipt, SwarmRef } from '@dusk/core'
import { winningClaim } from '@dusk/core'
import { attrEq } from '@dusk/arkiv'
import { seal } from '@dusk/crypto'
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/utils'
import type { BuyerDeps } from './post'

const CLAIM_POLL_MS = 2_000

export function claimantProven(claim: Claim): boolean {
  if (!claim.workerPubkey || !claim.owner) return false
  let claimant: Address
  try {
    claimant = publicKeyToAddress(claim.workerPubkey)
  } catch {
    return false
  }
  if (getAddress(claim.owner) !== claimant) return false
  return claim.workerId === keccak256(toHex(claimant))
}

export function grantCandidates(job: Job, claims: readonly Claim[]): Claim[] {
  const mine = claims.filter((c) => c.jobId === job.id)
  const usable =
    job.visibility === 'private'
      ? mine.filter(claimantProven)
      :
        mine.filter((c) => c.owner !== undefined)
  return orderedClaims(usable)
}

export async function writeGrant(
  deps: BuyerDeps,
  job: Job,
  claim: Claim,
  encryptedRef?: SwarmRef,
): Promise<string | null> {
  if (!claim.owner) return null
  if (deps.admit) {
    const worker = await deps.admit('new-grant', claim.owner).catch(() => ({ allowed: false }))
    if (!worker.allowed) return null
    const buyer = await deps.admit('new-grant', deps.arkiv.address).catch(() => ({ allowed: false }))
    if (!buyer.allowed) return null
  }

  let sealedRef: Hex | undefined
  if (job.visibility === 'private') {
    if (encryptedRef === undefined) {
      throw new Error(
        `job ${job.id} is private but writeGrant was given no encrypted reference. Without ` +
          'one the worker has no way to read the input, and the grant would authorise work ' +
          'that cannot be done.',
      )
    }
    try {
      sealedRef = seal(encryptedRef, claim.workerPubkey as Hex)
    } catch {
      return null
    }
  }

  const commitAuth = deps.escrow
    ? await deps.escrow.signCommitAuth(job.escrowId, claim.owner)
    : undefined

  return await deps.arkiv.put(
    'grant',
    {
      jobId: job.id,
      workerId: claim.workerId,
      ...(sealedRef !== undefined ? { sealedRef } : {}),
      ...(commitAuth !== undefined ? { commitAuth } : {}),
    },
    { ttlSeconds: deps.ttlGrantSeconds },
  )
}

export async function grantOnClaim(
  deps: BuyerDeps,
  job: Job,
  encryptedRef?: SwarmRef,
): Promise<string | null> {
  refuseCrossedRefs(job, encryptedRef)

  while (deps.now() < job.expiresAt) {
    const claims = await deps.arkiv.query<Claim>('claim', attrEq('claim', 'jobId', job.id))
    for (const claim of grantCandidates(job, claims)) {
      const id = await writeGrant(deps, job, claim, encryptedRef)
      if (id !== null) return id
    }
    await new Promise((r) => setTimeout(r, CLAIM_POLL_MS))
  }
  return null
}

export async function grantUntilDelivered(
  deps: BuyerDeps,
  job: Job,
  encryptedRef?: SwarmRef,
  opts: { pollMs?: number; onGrant?: (grantId: string, claim: Claim) => void } = {},
): Promise<string | null> {
  refuseCrossedRefs(job, encryptedRef)
  const pollMs = opts.pollMs ?? CLAIM_POLL_MS
  const grantTtlMs = deps.ttlGrantSeconds * 1000
  const grantedAt = new Map<string, number>()
  let last: string | null = null

  while (deps.now() < job.expiresAt) {
    if (last !== null && (await isDelivered(deps, job))) return last

    const claims = await deps.arkiv.query<Claim>('claim', attrEq('claim', 'jobId', job.id))
    for (const claim of grantCandidates(job, claims)) {
      const at = grantedAt.get(claim.workerId)
      if (at !== undefined && deps.now() - at < grantTtlMs) break
      const id = await writeGrant(deps, job, claim, encryptedRef)
      if (id === null) continue
      grantedAt.set(claim.workerId, deps.now())
      last = id
      opts.onGrant?.(id, claim)
      break
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return last
}

async function isDelivered(deps: BuyerDeps, job: Job): Promise<boolean> {
  try {
    if (deps.escrow) return (await deps.escrow.deal(job.escrowId)).state !== 'funded'
    const receipts = await deps.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', job.id))
    return receipts.some((r) => r.jobId === job.id)
  } catch {
    return false
  }
}

function refuseCrossedRefs(job: Job, encryptedRef: SwarmRef | undefined): void {
  if (job.visibility !== 'private' && encryptedRef !== undefined) {
    throw new Error(
      `job ${job.id} is ${job.visibility} but grantOnClaim was given a reference to seal. A ` +
        "public job's input reference is already on its entity; only its CommitAuth is " +
        'granted.',
    )
  }
  if (job.visibility === 'private' && encryptedRef === undefined) {
    throw new Error(`job ${job.id} is private but grantOnClaim was given nothing to seal`)
  }
}

function orderedClaims(claims: Claim[]): Claim[] {
  const rest = [...claims]
  const out: Claim[] = []
  while (rest.length > 0) {
    const next = winningClaim(rest)
    if (!next) break
    out.push(next)
    rest.splice(rest.indexOf(next), 1)
  }
  return out
}
