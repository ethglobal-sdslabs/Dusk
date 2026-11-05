import type {
  ArkivStore,
  Claim,
  Grant,
  DuskConfig,
  EscrowClient,
  Job,
  OgClient,
  Receipt,
  SwarmStore,
  WorkerAd,
} from '@dusk/core'
import {
  chatContent,
  checkChatInput,
  creditsBucketOf,
  hasTimeToDeliver,
  isDeliverable,
  isFundedFor,
  parseChatInput,
  parseCreditBalance,
  winningClaim,
} from '@dusk/core'
import { and, asQuotaError, attrEq, openJobsFilter } from '@dusk/arkiv'
import { isSealablePubkey, seal, UnsealError } from '@dusk/crypto'
import { creditsSpentOf, imageInputModels } from '@dusk/og'
import { EscrowReceiptTimeoutError, EscrowRevertError } from '@dusk/escrow'
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem'
import { canAfford, learnFromBalance, recordSpend, type CreditBudget } from './budget'

const GRANT_FETCH_POLL_MS = 1_000

const GRANT_POLL_MAX_ITERATIONS = 600

export class NoGrantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoGrantError'
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type WorkerDeps = {
  arkiv: ArkivStore
  og: OgClient
  swarm: SwarmStore
  config: DuskConfig
  workerId: string
  payout: Address
  pricePer1kOut: bigint
  models: string[]
  escrow?: EscrowClient
  deliverMarginMs: number
  admit?: (action: 'new-claim', wallet: Address) => Promise<{ allowed: boolean; reason?: string; retryable?: boolean }>
  admitVerdicts?: Map<string, { at: number; allowed: boolean }>
  dayStartCredits: bigint
  now: () => number
  adState?: { id: string; renewAfterMs: number }
  settleState?: { nextAtMs: number }
  noGrantUntil?: Map<string, number>
  spentOn?: Map<string, number>
  pubkey?: Hex
  unsealInput?: (sealed: Hex) => string
  produce?: Producer
  fallbackDelayMs?: number
  firstSeen?: Map<string, number>
  budget?: CreditBudget
  /**
   * Whether this worker's completions carry a TEE proof (`@dusk/og/sealed`). `false`
   * means it cannot prove what ran, so it never claims a `private` (TeeML) job: the escrow's
   * verifier rejects a commit without a proof and the credits would be spent for
   * nothing. `main.ts` sets it from `DUSK_TEE_PROOF`; the browser worker sets `false`
   * (WebCrypto has no ChaCha20-Poly1305, so it cannot seal). Unset makes no claim
   * either way — the loop tests that predate it.
   */
  provesTee?: boolean
}

export type Produced = {
  bytes: Uint8Array
  contentType: string
  modelServed: string
  tokensIn: number
  tokensOut: number
  creditsSpent: string
  latencyMs: number
  teeProof?: import('@dusk/core').TeeProof
}

export type Producer = (
  job: Job,
  input: string,
  opts: { signal?: AbortSignal; giveUpAt: number },
) => Promise<Produced>

export function textProducer(deps: Pick<WorkerDeps, 'og' | 'config'>): Producer {
  let vision: Promise<string[] | undefined> | undefined
  const visionModels = (): Promise<string[] | undefined> => {
    vision ??= (deps.og.catalog?.() ?? Promise.resolve(undefined))
      .then((models) => (models ? imageInputModels(models) : undefined))
      .catch(() => {
        vision = undefined
        return undefined
      })
    return vision
  }
  return async (job, input) => {
    const parsed = parseChatInput(input)
    checkChatInput(parsed, {
      model: job.model,
      visionModels: parsed.attachments.some((a) => a.kind === 'image') ? await visionModels() : undefined,
      ...deps.config.input,
    })
    const result = await deps.og.complete(
      {
        model: job.model,
        maxTokens: job.maxTokens,
        messages: [{ role: 'user', content: chatContent(parsed) }],
      },
      job.trustMode,
    )

    if (!isDeliverable(result)) {
      throw new Error(
        `job ${job.id} produced no deliverable output (tokensOut=${result.tokensOut}). ` +
          'The request was billed. Refusing to deliver or receipt it.',
      )
    }

    return {
      bytes: new TextEncoder().encode(result.text),
      contentType: 'text/plain; charset=utf-8',
      modelServed: result.modelServed,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      creditsSpent: creditsSpentOf(null, null, result),
      latencyMs: result.latencyMs,
      ...(result.teeProof ? { teeProof: result.teeProof } : {}),
    }
  }
}


const UNKNOWN_INPUT_CHARS = 32_000

async function otherSellers(deps: WorkerDeps): Promise<WorkerAd[]> {
  const ads = await deps.arkiv.query<WorkerAd>('worker')
  const mine = deps.adState?.id
  return ads.filter((ad) => ad.id !== mine && ad.payout?.toLowerCase() !== deps.payout.toLowerCase())
}

async function waitedLongEnough(
  deps: WorkerDeps,
  open: readonly Job[],
  candidates: Job[],
): Promise<Job[]> {
  const delay = deps.fallbackDelayMs
  if (delay === undefined) return candidates
  const others = candidates.length > 0 ? await otherSellers(deps) : []
  const seen = (deps.firstSeen ??= new Map())
  const stillOpen = new Set(open.map((j) => j.id))
  for (const id of seen.keys()) if (!stillOpen.has(id)) seen.delete(id)
  const now = deps.now()
  return candidates.filter((job) => {
    const sellers = others.filter((ad) => ad.models.includes(job.model))
    if (sellers.length === 0) return true
    if (!sellers.some((ad) => ad.pricePer1kOut <= job.maxPricePer1kOut)) return false
    const first = seen.get(job.id)
    if (first === undefined) {
      seen.set(job.id, now)
      return false
    }
    return now - first >= delay
  })
}

const adIds = new Map<string, { id: string; renewAfterMs: number }>()

export async function heartbeat(deps: WorkerDeps): Promise<string> {
  const ttlMs = deps.config.ttl.worker * 1000
  const existing = deps.adState

  if (existing && deps.now() < existing.renewAfterMs) return existing.id

  let creditsBucket = creditsBucketOf(0n, 0n)
  try {
    const balance = await deps.og.balance()
    const remaining = parseCreditBalance(balance.creditBalance)
    if (remaining > deps.dayStartCredits) deps.dayStartCredits = remaining
    creditsBucket = creditsBucketOf(remaining, deps.dayStartCredits)
  } catch {
  }

  if (existing) {
    try {
      await deps.arkiv.extend(existing.id, deps.config.ttl.worker)
      deps.adState = { id: existing.id, renewAfterMs: deps.now() + ttlMs / 2 }
      return existing.id
    } catch {
      delete deps.adState
    }
  }

  const ad: Omit<WorkerAd, 'id'> = {
    models: deps.models,
    pricePer1kOut: deps.pricePer1kOut,
    creditsBucket,
    trustModes: ['verified', 'standard'],
    payout: deps.payout,
  }
  const id = await deps.arkiv.put('worker', ad, { ttlSeconds: deps.config.ttl.worker })
  deps.adState = { id, renewAfterMs: deps.now() + ttlMs / 2 }
  return id
}

export function forgetAd(deps: WorkerDeps): void {
  delete deps.adState
}

async function claimsFor(deps: WorkerDeps, jobId: string): Promise<Claim[]> {
  const claims = await deps.arkiv.query<Claim>('claim', attrEq('claim', 'jobId', jobId))
  return claims.filter((c) => c.jobId === jobId)
}

export async function claimJob(deps: WorkerDeps, job: Job): Promise<Claim | null> {
  const claimedAt = deps.now()
  const mine = {
    jobId: job.id,
    workerId: deps.workerId,
    price: deps.pricePer1kOut,
    claimedAt,
    ...(deps.pubkey ? { workerPubkey: deps.pubkey } : {}),
  }
  const id = await deps.arkiv.put('claim', mine, { ttlSeconds: deps.config.ttl.claim })

  const winner = winningClaim(await claimsFor(deps, job.id))
  if (winner?.id !== id) {
    await deps.arkiv.del(id)
    return null
  }
  return { id, ...mine }
}

function matchesInputHash(job: Job, input: string): boolean {
  return keccak256(toHex(input)) === job.inputHash
}

type ResolvedWork = {
  input: string
  buyerAuth?: Hex
}

async function resolveWork(
  deps: WorkerDeps,
  job: Job,
  opts: { signal?: AbortSignal } = {},
): Promise<ResolvedWork> {
  const isPrivate = job.visibility === 'private'

  if (isPrivate && !deps.unsealInput) {
    throw new Error(
      `job ${job.id} is private and this worker has no key to open a grant with. Set ` +
        'DUSK_WORKER_PRIVATE_KEY so the worker can be sealed to.',
    )
  }

  let publicInput: string | undefined
  if (!isPrivate) {
    if (!job.inputRef) {
      throw new Error(`job ${job.id} is public but carries no inputRef, so there is nothing to run`)
    }
    publicInput = new TextDecoder().decode(await deps.swarm.download(job.inputRef))
    if (!matchesInputHash(job, publicInput)) {
      throw new Error(
        `job ${job.id}'s inputRef resolves to content that does not match its inputHash. ` +
          'Refusing to run a prompt that cannot be attributed to the job. No credits spent.',
      )
    }
  }

  const needsAuth = deps.escrow !== undefined
  if (!needsAuth && !isPrivate) {
    return { input: publicInput as string }
  }

  const deadline = Math.min(
    deps.now() + deps.config.ttl.claim * 1000,
    job.expiresAt - deps.deliverMarginMs,
  )
  const filter = and(attrEq('grant', 'jobId', job.id), attrEq('grant', 'workerId', deps.workerId))

  let lastRejection: string | undefined
  for (let i = 0; i < GRANT_POLL_MAX_ITERATIONS && deps.now() < deadline; i++) {
    const grants = await deps.arkiv.query<Grant>('grant', filter)
    for (const grant of grants.filter(
      (g) => g.jobId === job.id && g.workerId === deps.workerId,
    )) {
      if (!job.owner || !grant.owner || getAddress(grant.owner) !== getAddress(job.owner)) {
        lastRejection = "a grant was not written by the job's own buyer"
        continue
      }
      if (needsAuth && !grant.commitAuth) {
        lastRejection = 'a grant carried no commitAuth, so no worker could be paid for it'
        continue
      }
      if (needsAuth) {
        let refusal: string | undefined
        try {
          refusal = await deps.escrow!.commitRefusal(job.escrowId, grant.commitAuth!)
        } catch (err) {
          lastRejection = `a grant's commitAuth could not be checked: ${err instanceof Error ? err.message : String(err)}`
          continue
        }
        if (refusal) {
          lastRejection = `DuskEscrow would refuse this grant's commitAuth (${refusal})`
          continue
        }
      }

      let input: string
      if (isPrivate) {
        if (!grant.sealedRef) {
          lastRejection = "a private job's grant carried no sealedRef, so there is nothing to run"
          continue
        }
        try {
          const ref = deps.unsealInput!(grant.sealedRef)
          input = new TextDecoder().decode(await deps.swarm.download(ref))
        } catch (err) {
          lastRejection =
            err instanceof UnsealError
              ? 'a grant was not sealed to this worker'
              : `a grant's reference could not be fetched: ${err instanceof Error ? err.message : String(err)}`
          continue
        }
        if (!matchesInputHash(job, input)) {
          lastRejection = "a grant's input did not match the job's inputHash"
          continue
        }
      } else {
        input = publicInput as string
      }

      return { input, ...(grant.commitAuth ? { buyerAuth: grant.commitAuth } : {}) }
    }
    await sleep(GRANT_FETCH_POLL_MS, opts.signal)
  }

  throw new NoGrantError(
    `job ${job.id} had no usable grant from its buyer before its delivery window closed` +
      `${lastRejection ? ` (${lastRejection})` : ''}. ` +
      `${
        isPrivate
          ? 'Without one there is no input to run and no authorisation to be paid.'
          : 'Without one DuskEscrow.commit would refuse to pay for the work.'
      } ` +
      'Releasing the claim; no credits were spent.',
  )
}

async function commitOutputHash(
  deps: WorkerDeps,
  job: Job,
  outputHash: Hex,
  buyerAuth?: Hex,
): Promise<void> {
  if (!deps.escrow) return
  if (!buyerAuth) {
    throw new Error(
      `job ${job.id} reached commit with no buyerAuth while escrow is configured. The ` +
        'completion is already billed. This is a bug in the loop, not a market condition.',
    )
  }
  try {
    await deps.escrow.commit(job.escrowId, outputHash, buyerAuth)
  } catch (err) {
    if (err instanceof EscrowRevertError) {
      throw new Error(
        `job ${job.id} completion was billed but escrow.commit reverted ` +
          `(${err.revertName}) on escrow ${job.escrowId} — ` +
          `${
            err.revertName === 'NotAuthorised'
              ? "the buyer's authorisation did not name this worker for this deal"
              : 'the race for this job was lost'
          }. ${err.message}`,
      )
    }
    console.error(
      `[worker] escrow commit outcome unknown for job ${job.id}, escrow ` +
        `${job.escrowId}${err instanceof EscrowReceiptTimeoutError ? `, tx ${err.hash}` : ''}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    throw new Error(
      `job ${job.id} completion was billed but escrow.commit's outcome is ` +
        `unknown (escrow ${job.escrowId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function writeReceipt(
  deps: WorkerDeps,
  job: Job,
  receipt: Omit<Receipt, 'id'>,
  outputHash: Hex,
): Promise<string> {
  try {
    return await deps.arkiv.put('receipt', receipt, { ttlSeconds: deps.config.ttl.receipt })
  } catch (err) {
    if (deps.escrow) {
      console.error(
        `[worker] RECEIPT WRITE FAILED AFTER A SUCCESSFUL COMMIT — job ${job.id}, escrow ` +
          `${job.escrowId}, output hash ${outputHash}. The deal is COMMITTED on chain and ` +
          `the money is still collectible — and since \`settle\` is callable by anyone, ` +
          `by anybody willing to pay the gas: call settle(${job.escrowId}). settleDue ` +
          'cannot find it — that pass reads Arkiv receipts, and this receipt does not ' +
          `exist. Underlying failure: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    throw err
  }
}

export async function runJob(
  deps: WorkerDeps,
  job: Job,
  claim: Claim,
  opts: { signal?: AbortSignal } = {},
): Promise<Receipt> {
  const renewEvery = Math.max(1, Math.floor((deps.config.ttl.claim * 1000) / 2))
  const renewal = setInterval(() => {
    void deps.arkiv.extend(claim.id, deps.config.ttl.claim).catch(() => {})
    void heartbeat(deps).catch(() => {})
  }, renewEvery)

  let spending = false
  try {
    const resolved = await resolveWork(deps, job, opts)
    const { buyerAuth } = resolved
    let input = resolved.input
    if (job.after) {
      const before = await previousAnswer(deps, job)
      if (before === null) throw new Error(`job ${job.id} needs the answer to ${job.after}, which is not available.`)
      input = `Previous step's answer:\n${before}\n\nNow:\n${input}`
    }

    if (!hasTimeToDeliver(job, deps.now(), deps.deliverMarginMs)) {
      throw new Error(
        `job ${job.id} has too little time left to deliver (expires ` +
          `${new Date(job.expiresAt).toISOString()}, margin ${deps.deliverMarginMs}ms) by the ` +
          'time its input was available. Refusing to spend credits racing a deadline ' +
          'escrow.commit would reject.',
      )
    }

    if (!(await escrowAdmitsSelf(deps, true))) {
      throw new Error(`job ${job.id}: the escrow's admission gate no longer admits this worker for the delivery window. Refusing to spend credits on a commit that would revert.`)
    }
    const produce = deps.produce ?? textProducer(deps)
    spending = true
    const produced = await produce(job, input, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      giveUpAt: job.expiresAt - deps.deliverMarginMs,
    })
    if (produced.modelServed !== job.model) {
      throw new Error(
        `job ${job.id} asked for ${job.model} but 0G served ${produced.modelServed}. ` +
          'The request was billed. Refusing to deliver or receipt it.',
      )
    }

    const outputBytes = produced.bytes
    const plainOutputRef = await deps.swarm.upload(outputBytes, {
      encrypt: job.visibility === 'private',
      contentType: produced.contentType,
    })
    const outputRef =
      job.visibility === 'private' ? seal(plainOutputRef, job.buyerPubkey) : plainOutputRef
    let proofRef: string | undefined
    if (produced.teeProof) {
      const plainProofRef = await deps.swarm.upload(new TextEncoder().encode(JSON.stringify(produced.teeProof)), {
        encrypt: job.visibility === 'private',
      })
      proofRef = job.visibility === 'private' ? seal(plainProofRef, job.buyerPubkey) : plainProofRef
    }
    const outputHash = keccak256(outputBytes)

    await commitOutputHash(deps, job, outputHash, buyerAuth)

    const receipt: Omit<Receipt, 'id'> = {
      jobId: job.id,
      escrowId: job.escrowId,
      worker: deps.payout,
      modelServed: produced.modelServed,
      creditsSpent: produced.creditsSpent,
      tokensIn: produced.tokensIn,
      tokensOut: produced.tokensOut,
      outputRef,
      visibility: job.visibility,
      ...(proofRef !== undefined ? { proofRef } : {}),
      outputHash,
      latencyMs: produced.latencyMs,
      trustMode: job.trustMode,
    }
    const id = await writeReceipt(deps, job, receipt, outputHash)
    return { ...receipt, id }
  } catch (e) {
    if (spending) {
      deps.spentOn ??= new Map()
      deps.spentOn.set(job.id, job.expiresAt)
    }
    await deps.arkiv.del(claim.id).catch(() => {})
    throw e
  } finally {
    clearInterval(renewal)
  }
}

export async function previousAnswer(deps: WorkerDeps, job: Job): Promise<string | null> {
  if (!job.after) return null
  const receipts = await deps.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', job.after))
  for (const r of receipts) {
    if (r.jobId !== job.after || isZeroHash(r.outputHash) || r.visibility === 'private' || !r.outputRef) continue
    try {
      if (deps.escrow) {
        const deal = await deps.escrow.deal(r.escrowId)
        if (deal.outputHash.toLowerCase() !== r.outputHash.toLowerCase()) continue
      }
      const text = new TextDecoder().decode(await deps.swarm.download(r.outputRef))
      if (keccak256(toHex(text)).toLowerCase() === r.outputHash.toLowerCase()) return text
    } catch {
    }
  }
  return null
}

async function alreadyDelivered(deps: WorkerDeps, jobId: string): Promise<boolean> {
  const receipts = await deps.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', jobId))
  return receipts.some((r) => r.jobId === jobId && !isZeroHash(r.outputHash))
}

function isZeroHash(hash: string | undefined): boolean {
  if (hash === undefined) return true
  if (!/^0x[0-9a-f]*$/i.test(hash)) return true
  return /^0x0*$/i.test(hash)
}

function noGrantCooldownMs(deps: WorkerDeps): number {
  return deps.config.ttl.claim * 1000
}

function servable(deps: WorkerDeps, job: Job): boolean {
  return (
    deps.models.includes(job.model) &&
    job.maxPricePer1kOut >= deps.pricePer1kOut &&
    job.expiresAt > deps.now() &&
    job.status === 'open' &&
    !(job.trustMode === 'private' && deps.provesTee === false) &&
    hasTimeToDeliver(job, deps.now(), deps.deliverMarginMs) &&
    (job.visibility !== 'private' || !!deps.unsealInput) &&
    (job.visibility !== 'private' || isSealablePubkey(job.buyerPubkey)) &&
    !((deps.noGrantUntil?.get(job.id) ?? 0) > deps.now()) &&
    !alreadySpentOn(deps, job)
  )
}

function alreadySpentOn(deps: WorkerDeps, job: Job): boolean {
  const until = deps.spentOn?.get(job.id)
  if (until === undefined) return false
  if (until > deps.now()) return true
  deps.spentOn!.delete(job.id)
  return false
}

async function jobIsFunded(deps: WorkerDeps, job: Job): Promise<boolean> {
  if (!deps.escrow) return true
  try {
    const deal = await deps.escrow.deal(job.escrowId)
    return isFundedFor(deal, job, deps.pricePer1kOut, deps.config.og.imageModels)
  } catch {
    return false
  }
}

const SETTLE_INTERVAL_MS = 30_000

export async function settleDue(deps: WorkerDeps): Promise<number> {
  if (!deps.escrow) return 0
  const escrow = deps.escrow

  const prior = deps.settleState
  if (prior && deps.now() < prior.nextAtMs) return 0

  deps.settleState = { nextAtMs: deps.now() + SETTLE_INTERVAL_MS }

  try {
    const receipts = await deps.arkiv.query<Receipt>(
      'receipt',
      attrEq('receipt', 'worker', deps.payout),
    )
    let settled = 0

    for (const r of receipts) {
      if (r.worker !== deps.payout) continue
      if (!r.escrowId) continue

      let deal
      try {
        deal = await escrow.deal(r.escrowId)
      } catch (err) {
        if (!(err instanceof EscrowRevertError)) {
          console.error(
            `[worker] could not read deal ${r.escrowId} — no settle was attempted for it ` +
              `this pass: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        continue
      }

      if (deal.state !== 'committed') continue
      if (deal.worker.toLowerCase() !== deps.payout.toLowerCase()) continue

      try {
        await escrow.settle(r.escrowId)
        settled++
      } catch (err) {
        if (err instanceof EscrowRevertError) {
          continue
        }
        console.error(
          `[worker] settle outcome unknown for escrow ${r.escrowId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return settled
  } catch (err) {
    console.error(
      `[worker] settle pass failed before it could check any deal (escrow ` +
        `${deps.config.escrow.address ?? 'unset'}) — nothing was collected this pass: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return 0
  }
}

export type TickResult = {
  claimed: number
  delivered: number
  settled: number
  error?: string
}

export async function tick(
  deps: WorkerDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<TickResult> {
  const settled = await settleDue(deps)

  const self = await selfAdmission(deps)
  if (self === 'unknown') {
    return { claimed: 0, delivered: 0, settled, error: 'Could not verify this wallet\'s Dusk name right now (identity read failed). Claiming nothing this pass; retrying.' }
  }
  if (self === 'refused') {
    const ad = deps.adState?.id
    if (ad) { forgetAd(deps); await deps.arkiv.del(ad).catch(() => {}) }
    return { claimed: 0, delivered: 0, settled, error: 'A verified Dusk name is required before this wallet can advertise or claim new work.' }
  }
  await heartbeat(deps)

  const open = await deps.arkiv.query<Job>(
    'job',
    openJobsFilter(deps.models, deps.pricePer1kOut),
  )
  const candidates = await waitedLongEnough(
    deps,
    open,
    open.filter((job) => servable(deps, job)),
  )
  if (candidates.length > 0 && !(await escrowAdmitsSelf(deps))) return { claimed: 0, delivered: 0, settled }

  let balance: bigint | undefined
  if (deps.budget && candidates.length > 0) {
    try {
      balance = parseCreditBalance((await deps.og.balance()).creditBalance)
      learnFromBalance(deps.budget, balance, deps.now())
    } catch {
      balance = undefined
    }
  }

  for (const job of candidates) {
    if (job.after && (await previousAnswer(deps, job)) === null) continue

    if (
      deps.budget &&
      balance !== undefined &&
      !canAfford(deps.budget, balance, job.model, job.inputChars ?? UNKNOWN_INPUT_CHARS, job.maxTokens, deps.now())
    ) {
      continue
    }

    if (!(await jobIsFunded(deps, job))) continue

    if (!deps.escrow && (await alreadyDelivered(deps, job.id))) continue

    const existing = await claimsFor(deps, job.id)
    if (existing.length > 0) continue

    if (deps.admit && (!job.owner || !(await admitted(deps, job.owner)))) continue

    const claim = await claimJob(deps, job)
    if (!claim) continue

    try {
      const receipt = await runJob(deps, job, claim, opts)
      if (deps.budget) {
        recordSpend(deps.budget, {
          at: deps.now(),
          model: job.model,
          tokens: receipt.tokensIn + receipt.tokensOut,
          ...(balance !== undefined ? { before: balance } : {}),
        })
      }
      return { claimed: 1, delivered: 1, settled }
    } catch (e) {
      if (e instanceof NoGrantError) {
        deps.noGrantUntil ??= new Map()
        deps.noGrantUntil.set(job.id, deps.now() + noGrantCooldownMs(deps))
      }
      return {
        claimed: 1,
        delivered: 0,
        settled,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  return { claimed: 0, delivered: 0, settled }
}

const ADMISSION_TTL_MS = 15_000

const ADMISSION_READ_ATTEMPTS = 3
const ADMISSION_RETRY_MS = 1_000

async function escrowAdmitsSelf(deps: WorkerDeps, fresh = false): Promise<boolean> {
  const escrow = deps.escrow
  if (!escrow?.admitted && !escrow?.admittedUntil) return true
  const key = `escrow:${deps.payout.toLowerCase()}`
  const hit = deps.admitVerdicts?.get(key)
  if (!fresh && hit && deps.now() - hit.at < ADMISSION_TTL_MS) return hit.allowed
  let allowed: boolean | undefined
  for (let attempt = 0; attempt < ADMISSION_READ_ATTEMPTS && allowed === undefined; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, ADMISSION_RETRY_MS * attempt))
    try {
      allowed = escrow.admittedUntil
        ? (await escrow.admittedUntil(deps.payout)) * 1000 > deps.now() + deps.deliverMarginMs
        : await escrow.admitted!(deps.payout)
    } catch {
      allowed = undefined
    }
  }
  if (allowed === undefined) return hit?.allowed ?? false
  deps.admitVerdicts ??= new Map()
  deps.admitVerdicts.set(key, { at: deps.now(), allowed })
  return allowed
}

async function selfAdmission(deps: WorkerDeps): Promise<'allowed' | 'refused' | 'unknown'> {
  if (!deps.admit) return 'allowed'
  try {
    const verdict = await deps.admit('new-claim', deps.payout)
    if (verdict.allowed) return 'allowed'
    return verdict.retryable ? 'unknown' : 'refused'
  } catch {
    return 'unknown'
  }
}

async function admitted(deps: WorkerDeps, wallet: Address): Promise<boolean> {
  if (!deps.admit) return true
  try {
    return (await deps.admit('new-claim', wallet)).allowed
  } catch {
    return false
  }
}

export async function runWorker(
  deps: WorkerDeps,
  opts: {
    intervalMs: number
    signal?: AbortSignal
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  },
): Promise<void> {
  const wait = opts.sleep ?? sleep
  while (!opts.signal?.aborted) {
    let nextWaitMs = opts.intervalMs
    try {
      const r = await tick(deps, { ...(opts.signal ? { signal: opts.signal } : {}) })
      if (r.error) console.error(`[worker] claimed but did not deliver: ${r.error}`)
    } catch (e) {
      if (!opts.signal?.aborted) {
        console.error(`[worker] tick failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      const quota = asQuotaError(e)
      if (quota?.retryAfterSec !== undefined) {
        nextWaitMs = quota.retryAfterSec * 1000
        console.error(
          `[worker] Arkiv's read budget is spent — waiting ${quota.retryAfterSec}s before ` +
            'the next pass rather than knocking every interval. Nothing is wrong with this ' +
            'worker; it will resume on its own.',
        )
      }
    }
    if (opts.signal?.aborted) return
    await wait(nextWaitMs, opts.signal).catch(() => {})
  }
}
