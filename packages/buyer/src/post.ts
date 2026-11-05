import type { DuskArkivStore } from '@dusk/arkiv'
import type {
  EscrowClient,
  Job,
  SwarmRef,
  SwarmStore,
  TrustMode,
  Visibility,
} from '@dusk/core'
import {
  DEFAULT_IMAGE_MODELS,
  escrowDeadlineSec,
  jobAmountWei,
  jobExpiry,
  loadConfig,
  nextCreditReset,
} from '@dusk/core'
import { EscrowReceiptTimeoutError, EscrowRevertError } from '@dusk/escrow'
import { isSealablePubkey } from '@dusk/crypto'
import { bytesToHex, keccak256, toHex, type Hex } from 'viem'

export type JobSpec = {
  prompt: string
  model: string
  maxPricePer1kOut: bigint
  maxTokens: number
  deadlineMs: number
  trustMode?: TrustMode
  visibility?: Visibility
  escrowId?: Hex
  piece?: { parentId: Hex; index: number; count: number }
  after?: string
}

export type BuyerDeps = {
  arkiv: DuskArkivStore
  swarm: SwarmStore
  buyerPubkey: Hex
  now: () => number
  clock: ReturnType<typeof loadConfig>['clock']
  escrow?: EscrowClient
  imageModels?: readonly string[]
  admit?: (action: 'new-job' | 'new-grant', wallet: Hex) => Promise<{ allowed: boolean; reason?: string }>
  ttlGrantSeconds: number
  unsealOutput?: (sealed: Hex) => string
}

export type PostedJob = Job & {
  amountWei: bigint
  fundTx?: Hex
  encryptedRef?: SwarmRef
}

export function newEscrowId(): Hex {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export class StuckDealError extends Error {
  readonly escrowId: Hex
  readonly fundTx: Hex | undefined
  readonly funding: 'funded' | 'maybe-funded'

  constructor(args: {
    escrowId: Hex
    fundTx?: Hex
    funding: 'funded' | 'maybe-funded'
    cause: unknown
  }) {
    const { escrowId, fundTx, funding, cause } = args
    const what =
      funding === 'funded'
        ? `escrow ${escrowId} was funded (tx ${fundTx}) but the job entity failed to write`
        : `escrow ${escrowId} may have been funded${fundTx ? ` (tx ${fundTx}, which may still mine)` : ''} ` +
          'but fund did not confirm, so no job entity was written'
    super(
      `${what}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Treat it as real money sitting on chain with no job pointing at it — call ` +
        `refund(${escrowId}) once its deadline passes to recover it.`,
      { cause },
    )
    this.name = 'StuckDealError'
    this.escrowId = escrowId
    this.fundTx = fundTx
    this.funding = funding
  }
}

export class DeadlineOutlivesCreditsError extends Error {
  constructor(deadline: Date, reset: Date) {
    super(
      `a deadline of ${deadline.toISOString()} outlives the next credit reset at ` +
        `${reset.toISOString()}. Credits are destroyed at the reset with no carry-over, so no ` +
        'worker could fund this job for its full duration. Shorten the deadline, or post it ' +
        'again after the reset.',
    )
    this.name = 'DeadlineOutlivesCreditsError'
  }
}

export class NotAdmittedError extends Error {
  override name = 'NotAdmittedError'
}

export async function postJob(deps: BuyerDeps, spec: JobSpec): Promise<PostedJob> {
  if (spec.visibility === 'private' && !isSealablePubkey(deps.buyerPubkey)) {
    throw new Error('Private jobs require a valid encryption public key for their outputs. Use an encryption-capable signer; nothing was uploaded or funded.')
  }
  if (deps.admit) {
    let verdict: { allowed: boolean; reason?: string }
    try {
      verdict = await deps.admit('new-job', deps.arkiv.address)
    } catch {
      verdict = { allowed: false, reason: 'Identity status could not be verified. Retry before posting.' }
    }
    if (!verdict.allowed) throw new NotAdmittedError(verdict.reason ?? 'This wallet cannot post new jobs.')
  }
  const now = deps.now()
  const deadline = now + spec.deadlineMs
  const reset = nextCreditReset(deps.clock, new Date(now))
  if (deadline > reset.getTime()) {
    throw new DeadlineOutlivesCreditsError(new Date(deadline), reset)
  }

  const inputBytes = new TextEncoder().encode(spec.prompt)
  const visibility: Visibility = spec.visibility ?? 'public'
  const isPrivate = visibility === 'private'
  const ref = await deps.swarm.upload(inputBytes, isPrivate ? { encrypt: true } : undefined)

  const expiresAt = jobExpiry(deadline, deps.clock, new Date(now))
  const escrowId = spec.escrowId ?? newEscrowId()
  const amountWei = jobAmountWei(
    { model: spec.model, maxTokens: spec.maxTokens, inputChars: spec.prompt.length },
    spec.maxPricePer1kOut,
    deps.imageModels ?? DEFAULT_IMAGE_MODELS,
  )
  const deadlineSec = escrowDeadlineSec(expiresAt)

  let fundTx: Hex | undefined
  if (deps.escrow) {
    try {
      fundTx = await deps.escrow.fund(escrowId, deadlineSec, amountWei)
    } catch (e) {
      if (e instanceof EscrowRevertError) throw e
      throw new StuckDealError({
        escrowId,
        ...(e instanceof EscrowReceiptTimeoutError ? { fundTx: e.hash } : {}),
        funding: 'maybe-funded',
        cause: e,
      })
    }
  }

  const job: Omit<Job, 'id'> = {
    model: spec.model,
    maxPricePer1kOut: spec.maxPricePer1kOut,
    maxTokens: spec.maxTokens,
    trustMode: spec.trustMode ?? 'verified',
    visibility,
    ...(isPrivate ? {} : { inputRef: ref }),
    inputHash: keccak256(toHex(spec.prompt)),
    inputChars: spec.prompt.length,
    ...(spec.piece
      ? { parentId: spec.piece.parentId, pieceIndex: spec.piece.index, pieceCount: spec.piece.count }
      : {}),
    ...(spec.after ? { after: spec.after } : {}),
    buyerPubkey: deps.buyerPubkey,
    escrowId,
    status: 'open',
    expiresAt,
  }

  const ttlSeconds = Math.max(2, Math.floor((job.expiresAt - now) / 1000))
  let id: string
  try {
    id = await deps.arkiv.put('job', job, {
      ttlSeconds: ttlSeconds % 2 === 0 ? ttlSeconds : ttlSeconds + 1,
    })
  } catch (e) {
    if (fundTx) throw new StuckDealError({ escrowId, fundTx, funding: 'funded', cause: e })
    throw e
  }

  return {
    ...job,
    id,
    owner: deps.arkiv.address,
    amountWei,
    fundTx,
    ...(isPrivate ? { encryptedRef: ref } : {}),
  }
}

export function postPrivateJob(deps: BuyerDeps, spec: JobSpec): Promise<PostedJob> {
  return postJob(deps, { ...spec, visibility: 'private' })
}
