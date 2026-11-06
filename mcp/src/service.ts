import { retireDelivered, type BuyerDeps, type JobSpec, type PostedJob } from '@dusk/buyer'
import { attrEq } from '@dusk/arkiv'
import {
  isImageModel,
  jobPriceWei,
  jobTokens,
  nextCreditReset,
  type Claim,
  type Deal,
  type Job,
  type Receipt,
  type SwarmRef,
  type TrustMode,
  type Visibility,
  type WorkerAd,
} from '@dusk/core'
import { keccak256, type Hex } from 'viem'

export type Limits = {
  maxTokens: number
  maxPricePer1kOut: bigint
  maxEscrowWei: bigint
  maxDeadlineSec: number
}

export type ServiceDeps = {
  buyer: BuyerDeps & { address: string }
  post: (deps: BuyerDeps, spec: JobSpec) => Promise<PostedJob>
  authorise: (deps: BuyerDeps, job: Job, encryptedRef?: SwarmRef) => Promise<string | null>
  configuredModels: readonly string[]
  imageModels: readonly string[]
  limits: Limits
  sleep: (ms: number) => Promise<void>
  pollMs: number
}

export type SubmitArgs = {
  prompt: string
  model: string
  maxTokens: number
  maxPricePer1kOut: bigint
  deadlineSec: number
  visibility?: Visibility
  trustMode?: TrustMode
  requireLiveWorker?: boolean
}

export type MarketRow = {
  model: string
  workers: number
  minPricePer1kOut: string | null
  maxPricePer1kOut: string | null
  trustModes: TrustMode[]
  configured: boolean
}

type Tracked = {
  job: PostedJob
  postedAt: number
  authoriser: 'running' | 'stopped' | 'failed'
  authoriserError?: string
  lastGrant?: string
  delivered?: DeliveredResult
}

export type DeliveredResult = {
  status: 'delivered'
  jobId: string
  output: string
  modelServed: string
  tokensIn: number
  tokensOut: number
  truncated: boolean
  latencyMs: number
  worker: string
  outputHash: Hex
  verified: 'escrow-commit' | 'hash-only'
  creditsSpent: string
}

export type PendingResult = {
  status: 'pending'
  jobId: string
  stage: 'open' | 'claimed'
  claims: number
  expiresAt: string
  secondsLeft: number
  authoriser?: Tracked['authoriser']
  note: string
}

export type ExpiredResult = { status: 'expired'; jobId: string; note: string }
export type JobResult = DeliveredResult | PendingResult | ExpiredResult

const ZERO_HASH = `0x${'0'.repeat(64)}`

export function createDuskService(deps: ServiceDeps) {
  const { buyer, limits } = deps
  const tracked = new Map<string, Tracked>()

  async function liveAds(): Promise<WorkerAd[]> {
    return deps.buyer.arkiv.query<WorkerAd>('worker')
  }

  async function market() {
    const ads = await liveAds()
    const byModel = new Map<string, WorkerAd[]>()
    for (const m of deps.configuredModels) byModel.set(m, [])
    for (const ad of ads) for (const m of ad.models ?? []) byModel.set(m, [...(byModel.get(m) ?? []), ad])

    const models: MarketRow[] = [...byModel.entries()].map(([model, rows]) => {
      const prices = rows.map((r) => r.pricePer1kOut).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return {
        model,
        workers: rows.length,
        minPricePer1kOut: prices.length ? String(prices[0]) : null,
        maxPricePer1kOut: prices.length ? String(prices[prices.length - 1]) : null,
        trustModes: [...new Set(rows.flatMap((r) => r.trustModes ?? []))],
        configured: deps.configuredModels.includes(model),
      }
    })
    models.sort((a, b) => b.workers - a.workers || a.model.localeCompare(b.model))

    const now = buyer.now()
    const reset = nextCreditReset(buyer.clock, new Date(now))
    return {
      buyer: buyer.address,
      escrow: buyer.escrow ? 'configured' : 'none (jobs post unfunded; workers in paid mode will not serve them)',
      now: new Date(now).toISOString(),
      creditReset: reset.toISOString(),
      maxDeadlineSec: Math.min(limits.maxDeadlineSec, Math.floor((reset.getTime() - now) / 1000)),
      limits: {
        maxTokens: limits.maxTokens,
        maxPricePer1kOut: String(limits.maxPricePer1kOut),
        maxEscrowWei: String(limits.maxEscrowWei),
      },
      pricing:
        'Bids are wei (Galileo 0G) per 1000 output tokens. A worker takes a job only if the ' +
        'bid >= its ask, so bid at least minPricePer1kOut; bidding above the max ask reaches every ' +
        'worker. Escrow = ceil(bid * (estimated prompt tokens + max_tokens) / 1000) wei, locked until delivery or refunded ' +
        'after the deadline.',
      models,
    }
  }

  async function submit(args: SubmitArgs) {
    const prompt = args.prompt
    if (!prompt.trim()) throw new Error('prompt is empty')
    if (isImageModel(args.model, deps.imageModels)) {
      throw new Error(`${args.model} is an image model; this server posts text jobs only`)
    }
    if (!Number.isInteger(args.maxTokens) || args.maxTokens < 1 || args.maxTokens > limits.maxTokens) {
      throw new Error(`max_tokens must be an integer in 1..${limits.maxTokens} (operator cap)`)
    }
    if (args.maxPricePer1kOut < 1n || args.maxPricePer1kOut > limits.maxPricePer1kOut) {
      throw new Error(`max_price_per_1k_out must be in 1..${limits.maxPricePer1kOut} wei (operator cap)`)
    }
    if (!Number.isFinite(args.deadlineSec) || args.deadlineSec < 60 || args.deadlineSec > limits.maxDeadlineSec) {
      throw new Error(`deadline_seconds must be in 60..${limits.maxDeadlineSec}`)
    }
    const escrowWei = jobPriceWei(args.maxPricePer1kOut, jobTokens({ maxTokens: args.maxTokens, inputChars: prompt.length }))
    if (escrowWei > limits.maxEscrowWei) {
      throw new Error(`this job would escrow ${escrowWei} wei, over the ${limits.maxEscrowWei} wei per-job cap`)
    }

    const trustMode = args.trustMode ?? 'standard'
    if (args.requireLiveWorker !== false) {
      const asks = (await liveAds()).filter((ad) => ad.models?.includes(args.model))
      if (asks.length === 0) {
        throw new Error(
          `nobody is advertising ${args.model} right now, so a funded job would sit unclaimed until ` +
            'its deadline. Call dusk_market to see what is on offer, or pass require_live_worker: false.',
        )
      }
      const takers = asks.filter((ad) => ad.pricePer1kOut <= args.maxPricePer1kOut)
      if (takers.length === 0) {
        const min = asks.reduce((m, ad) => (ad.pricePer1kOut < m ? ad.pricePer1kOut : m), asks[0]!.pricePer1kOut)
        throw new Error(
          `a bid of ${args.maxPricePer1kOut} wei/1k is below every live ask for ${args.model}; the cheapest is ${min}. ` +
            'Raise max_price_per_1k_out or pass require_live_worker: false.',
        )
      }
    }

    const visibility = args.visibility ?? 'private'
    const job = await deps.post(buyer, {
      prompt,
      model: args.model,
      maxTokens: args.maxTokens,
      maxPricePer1kOut: args.maxPricePer1kOut,
      deadlineMs: args.deadlineSec * 1000,
      visibility,
      trustMode,
    })
    const entry: Tracked = { job, postedAt: buyer.now(), authoriser: 'running' }
    tracked.set(job.id, entry)
    void deps
      .authorise(buyer, job, job.encryptedRef)
      .then((grant) => {
        entry.authoriser = 'stopped'
        if (grant) entry.lastGrant = grant
      })
      .catch((e) => {
        entry.authoriser = 'failed'
        entry.authoriserError = e instanceof Error ? e.message : String(e)
      })

    return {
      jobId: job.id,
      model: job.model,
      visibility,
      trustMode,
      maxTokens: job.maxTokens,
      maxPricePer1kOut: String(job.maxPricePer1kOut),
      escrowId: job.escrowId,
      escrowWei: String(job.amountWei),
      fundTx: job.fundTx ?? null,
      expiresAt: new Date(job.expiresAt).toISOString(),
      next: 'Call dusk_result with this job_id (wait_seconds up to 300) to collect the answer.',
    }
  }

  async function findDelivery(jobId: string, maxTokens?: number): Promise<DeliveredResult | undefined> {
    const receipts = (await buyer.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', jobId))).filter(
      (r) => r.jobId === jobId,
    )
    if (receipts.length === 0) return undefined

    const deals = new Map<string, Deal | null>()
    const dealOf = async (escrowId: Hex) => {
      if (!deals.has(escrowId)) deals.set(escrowId, await buyer.escrow!.deal(escrowId).catch(() => null))
      return deals.get(escrowId)!
    }

    for (const r of receipts) {
      let verified: DeliveredResult['verified'] = 'hash-only'
      if (buyer.escrow) {
        const deal = await dealOf(r.escrowId)
        if (!deal || (deal.state !== 'committed' && deal.state !== 'settled')) continue
        if (deal.buyer.toLowerCase() !== buyer.address.toLowerCase()) continue
        if (deal.outputHash === ZERO_HASH || deal.outputHash !== r.outputHash) continue
        if (!r.owner || r.owner.toLowerCase() !== deal.worker.toLowerCase()) continue
        verified = 'escrow-commit'
      }
      let ref: string = r.outputRef
      if ((r.visibility ?? 'public') === 'private') {
        if (!buyer.unsealOutput) continue
        try {
          ref = buyer.unsealOutput(r.outputRef as Hex)
        } catch {
          continue
        }
      }
      let bytes: Uint8Array
      try {
        bytes = await buyer.swarm.download(ref)
      } catch {
        continue
      }
      if (keccak256(bytes) !== r.outputHash) continue
      await retireDelivered(buyer, { id: jobId, escrowId: r.escrowId }, r, bytes)
      const cap = maxTokens ?? tracked.get(jobId)?.job.maxTokens
      return {
        status: 'delivered',
        jobId,
        output: new TextDecoder().decode(bytes),
        modelServed: r.modelServed,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        truncated: cap !== undefined && r.tokensOut >= cap,
        latencyMs: r.latencyMs,
        worker: r.worker,
        outputHash: r.outputHash,
        verified,
        creditsSpent: r.creditsSpent,
      }
    }
    return undefined
  }

  async function result(jobId: string, waitSec: number): Promise<JobResult> {
    const entry = tracked.get(jobId)
    if (entry?.delivered) return entry.delivered
    const until = buyer.now() + Math.max(0, waitSec) * 1000

    for (;;) {
      let readError: string | undefined
      const delivered = await findDelivery(jobId).catch((e: unknown) => {
        readError = e instanceof Error ? e.message : String(e)
        return undefined
      })
      if (delivered) {
        if (entry) entry.delivered = delivered
        return delivered
      }
      const now = buyer.now()
      if (entry && now >= entry.job.expiresAt) {
        return {
          status: 'expired',
          jobId,
          note:
            `No delivery before the deadline. The ${entry.job.amountWei} wei escrow (deal ${entry.job.escrowId}) ` +
            'is refundable now: run `pnpm reclaim --mine`. Post again with a higher bid or a longer deadline.',
        }
      }
      if (now >= until) {
        if (!entry) {
          return {
            status: 'pending',
            jobId,
            stage: 'open',
            claims: 0,
            expiresAt: 'unknown',
            secondsLeft: 0,
            note: 'Not posted by this server session and no delivery found yet. Nothing here is authorising claimants for it.',
          }
        }
        const claims = (await buyer.arkiv.query<Claim>('claim', attrEq('claim', 'jobId', jobId)).catch(() => [] as Claim[])).filter(
          (c) => c.jobId === jobId,
        )
        return {
          status: 'pending',
          jobId,
          stage: claims.length > 0 ? 'claimed' : 'open',
          claims: claims.length,
          expiresAt: new Date(entry.job.expiresAt).toISOString(),
          secondsLeft: Math.floor((entry.job.expiresAt - now) / 1000),
          authoriser: entry.authoriser,
          note:
            claims.length > 0
              ? 'A worker has claimed it and is running it. Call dusk_result again.'
              : 'Waiting for a worker to claim it. Call dusk_result again.' +
                (entry.authoriserError ? ` (authoriser failed: ${entry.authoriserError})` : '') +
                (readError ? ` (last read failed, will retry: ${readError})` : ''),
        }
      }
      await deps.sleep(Math.min(deps.pollMs, until - now))
    }
  }

  function jobs() {
    const now = buyer.now()
    return [...tracked.values()].map((t) => ({
      jobId: t.job.id,
      model: t.job.model,
      visibility: t.job.visibility,
      maxTokens: t.job.maxTokens,
      escrowWei: String(t.job.amountWei),
      postedAt: new Date(t.postedAt).toISOString(),
      expiresAt: new Date(t.job.expiresAt).toISOString(),
      state: t.delivered ? 'delivered' : now >= t.job.expiresAt ? 'expired' : 'pending',
      authoriser: t.authoriser,
    }))
  }

  return { market, submit, result, jobs }
}

export type DuskService = ReturnType<typeof createDuskService>
