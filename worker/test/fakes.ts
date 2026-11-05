import { render, type Expression } from '@arkiv-network/sdk/query'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import type {
  ArkivStore,
  Balance,
  CompletionRequest,
  CompletionResult,
  Deal,
  DuskConfig,
  EscrowClient,
  EscrowIdRef,
  ImagePoll,
  ImageRequest,
  ImageSubmission,
  Kind,
  OgClient,
  OgImageClient,
  SwarmRef,
  SwarmStore,
  TrustMode,
  ModelInfo,
} from '@dusk/core'
import { loadConfig } from '@dusk/core'
import { attributeTypesFor } from '@dusk/arkiv'
import { EscrowRevertError } from '@dusk/escrow'
import type { WorkerDeps } from '../src/loop'

const COMPARISON_RE = /([a-z][a-z0-9._-]*)\s*(?:=|!=|<=|>=|<|>)\s*([a-z0-9]+)\(/g

function checkFilterTypes(kind: Kind, filter: Expression): void {
  const types = attributeTypesFor(kind)
  for (const match of render(filter).matchAll(COMPARISON_RE)) {
    const name = match[1] as string
    const tag = match[2] as string
    const expected = types[name]
    if (!expected) {
      throw new Error(
        `fake arkiv: query('${kind}', …) filters on "${name}", which "${kind}" does not ` +
          `store as an attribute — on chain that is zero rows, silently (friction #20), ` +
          `not an error. Known attributes: ${Object.keys(types).join(', ')}.`,
      )
    }
    if (tag !== expected) {
      throw new Error(
        `fake arkiv: query('${kind}', …) compares "${name}" as ${tag}(…), but it is stored ` +
          `as ${expected} — on chain that mismatch matches zero rows, silently (friction ` +
          '#20), not an error. Use attrEq/attrCmp from @dusk/arkiv instead of tagging it by hand.',
      )
    }
  }
}

type Row = {
  id: string
  kind: Kind
  data: unknown
  owner: Address
  createdAtBlock: bigint
  expiresAtMs: number
}

export const FAKE_WRITER: Address = `0x${'7f'.repeat(20)}`

export type FakeArkiv = ArkivStore & {
  address: Address
  rows: Row[]
  extensions: Array<{ id: string; ttlSeconds: number; atMs: number }>
  deletions: string[]
  queries: Array<{ kind: Kind; filter?: unknown }>
  all<T>(kind: Kind): T[]
  putAs<T>(owner: Address, kind: Kind, data: T, opts: { ttlSeconds: number }): Promise<string>
}

export function fakeArkivSameBlock(now: () => number = () => 1_000): FakeArkiv {
  return fakeArkiv(now, true)
}

export function fakeArkiv(now: () => number = () => 1_000, sameBlock = false): FakeArkiv {
  const rows: Row[] = []
  const extensions: FakeArkiv['extensions'] = []
  const deletions: string[] = []
  const queries: FakeArkiv['queries'] = []
  let seq = 0

  let block = 1n

  const read = <T>(r: Row): T =>
    ({ ...(r.data as object), id: r.id, owner: r.owner, createdAtBlock: r.createdAtBlock }) as T

  const store: FakeArkiv = {
    address: FAKE_WRITER,
    rows,
    extensions,
    deletions,
    queries,

    all<T>(kind: Kind): T[] {
      return rows.filter((r) => r.kind === kind).map((r) => read<T>(r))
    },

    async putAs<T>(
      owner: Address,
      kind: Kind,
      data: T,
      opts: { ttlSeconds: number },
    ): Promise<string> {
      const id = `0x${(seq++).toString(16).padStart(64, '0')}`
      rows.push({
        id,
        kind,
        data,
        owner,
        createdAtBlock: block,
        expiresAtMs: now() + opts.ttlSeconds * 1000,
      })
      if (!sameBlock) block += 1n
      return id
    },

    async put<T>(kind: Kind, data: T, opts: { ttlSeconds: number }): Promise<string> {
      return store.putAs(FAKE_WRITER, kind, data, opts)
    },

    async query<T>(kind: Kind, filter?: unknown): Promise<T[]> {
      if (filter !== undefined) checkFilterTypes(kind, filter as Expression)
      queries.push(filter === undefined ? { kind } : { kind, filter })
      return rows.filter((r) => r.kind === kind && r.expiresAtMs > now()).map((r) => read<T>(r))
    },

    async extend(id: string, ttlSeconds: number): Promise<void> {
      const row = rows.find((r) => r.id === id)
      if (!row) throw new Error(`extend: no such entity ${id}`)
      if (row.expiresAtMs <= now()) throw new Error(`extend: entity ${id} has expired`)
      const target = now() + ttlSeconds * 1000
      if (target < row.expiresAtMs) throw new Error('extend would shorten the entity')
      row.expiresAtMs = target
      extensions.push({ id, ttlSeconds, atMs: now() })
    },

    async del(id: string): Promise<void> {
      deletions.push(id)
      const i = rows.findIndex((r) => r.id === id)
      if (i >= 0) rows.splice(i, 1)
    },
  }

  return store
}

export type FakeSwarm = SwarmStore & {
  uploads: SwarmRef[]
  blobs: Map<string, Uint8Array>
  contentTypes: Map<string, string | undefined>
}

export function fakeSwarm(): FakeSwarm {
  const blobs = new Map<string, Uint8Array>()
  const contentTypes = new Map<string, string | undefined>()
  const uploads: SwarmRef[] = []
  let seq = 0
  return {
    uploads,
    blobs,
    contentTypes,
    async upload(data: Uint8Array, opts?: { encrypt?: boolean; contentType?: string }): Promise<SwarmRef> {
      const ref = `${(seq++).toString(16).padStart(2, '0')}`.repeat(opts?.encrypt ? 64 : 32)
      blobs.set(ref, data)
      contentTypes.set(ref, opts?.contentType)
      uploads.push(ref)
      return ref
    },
    async download(ref: SwarmRef): Promise<Uint8Array> {
      const blob = blobs.get(ref)
      if (!blob) throw new Error(`fake swarm: no blob for ${ref.slice(0, 8)}`)
      return blob
    },
  }
}

export function revert(revertName: string): Error {
  return new EscrowRevertError(`fake revert: ${revertName}`, revertName)
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'
const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`

const NO_DEAL: Deal = {
  buyer: ZERO_ADDRESS,
  worker: ZERO_ADDRESS,
  amount: 0n,
  outputHash: ZERO_HASH,
  commitAtSec: 0,
  deadlineSec: 0,
  state: 'none',
}

const FAKE_TX_HASH = `0x${'ab'.repeat(32)}` as Hex

const DEFAULT_SIGNER: Address = `0x${'ee'.repeat(20)}`

export type FakeEscrow = EscrowClient & {
  deals: Map<Hex, Deal>
  funded: Array<{ jobId: Hex; deadlineSec: number; amountWei: bigint }>
  commits: Array<{ jobId: Hex; outputHash: Hex }>
  settlements: Hex[]
  refunds: Hex[]
  reads: number
  failNext(method: 'fund' | 'commit' | 'settle' | 'refund', err: Error): void
  authFor(buyer: Address, jobId: Hex, worker: Address): Hex
  readonly signer: Address
}

function fakeAuth(buyer: Address, jobId: Hex, worker: Address): Hex {
  return keccak256(toHex(`dusk-fake-auth:${buyer.toLowerCase()}:${jobId.toLowerCase()}:${worker.toLowerCase()}`))
}

export function fakeEscrow(
  opts: { now?: () => number; signer?: Address } = {},
): FakeEscrow {
  const deals = new Map<Hex, Deal>()
  const funded: FakeEscrow['funded'] = []
  const commits: FakeEscrow['commits'] = []
  const settlements: Hex[] = []
  const refunds: Hex[] = []
  const pendingFailures = new Map<'fund' | 'commit' | 'settle' | 'refund', Error>()
  const now = opts.now ?? (() => 1_000)
  const signer = opts.signer ?? DEFAULT_SIGNER

  function nowSec(): number {
    return Math.floor(now() / 1000)
  }

  function takeFailure(method: 'fund' | 'commit' | 'settle' | 'refund'): Error | undefined {
    const err = pendingFailures.get(method)
    if (err) pendingFailures.delete(method)
    return err
  }

  function dealOrDefault(jobId: Hex): Deal {
    return deals.get(jobId) ?? NO_DEAL
  }

  const escrow: FakeEscrow = {
    deals,
    funded,
    commits,
    settlements,
    refunds,
    reads: 0,
    signer,

    failNext(method, err) {
      pendingFailures.set(method, err)
    },

    authFor: fakeAuth,

    async signCommitAuth(jobId: Hex, worker: Address): Promise<Hex> {
      return fakeAuth(signer, jobId, worker)
    },

    async signVerdict(jobId: Hex, outputHash: Hex, valid: boolean): Promise<Hex> {
      return keccak256(toHex(`verdict:${jobId}:${outputHash}:${valid}`))
    },
    async settleVerified(jobId: Hex): Promise<Hex> {
      const deal = dealOrDefault(jobId)
      if (deal.state !== 'committed') throw revert('NotCommitted')
      deals.set(jobId, { ...deal, state: 'settled', amount: 0n })
      settlements.push(jobId)
      return FAKE_TX_HASH
    },
    async reject(jobId: Hex): Promise<Hex> {
      const deal = dealOrDefault(jobId)
      if (deal.state !== 'committed') throw revert('NotCommitted')
      deals.set(jobId, { ...deal, state: 'refunded', amount: 0n })
      refunds.push(jobId)
      return FAKE_TX_HASH
    },

    async commitRefusal(jobId: Hex, buyerAuth: Hex): Promise<string | undefined> {
      const deal = dealOrDefault(jobId)
      if (deal.state !== 'funded') return 'NotFunded'
      if (nowSec() > deal.deadlineSec) return 'DeadlinePassed'
      if (signer.toLowerCase() === deal.buyer.toLowerCase()) return 'BuyerIsNotWorker'
      if (buyerAuth !== fakeAuth(deal.buyer, jobId, signer)) return 'NotAuthorised'
      return undefined
    },

    async fundedBy(buyer: Address): Promise<EscrowIdRef[]> {
      return funded
        .filter(({ jobId }) => deals.get(jobId)?.buyer.toLowerCase() === buyer.toLowerCase())
        .map(({ jobId }) => ({ escrowId: jobId, txHash: FAKE_TX_HASH, blockNumber: 1n }))
    },

    async committedBy(worker: Address): Promise<EscrowIdRef[]> {
      return commits
        .filter(({ jobId }) => deals.get(jobId)?.worker.toLowerCase() === worker.toLowerCase())
        .map(({ jobId }) => ({ escrowId: jobId, txHash: FAKE_TX_HASH, blockNumber: 1n }))
    },

    async deal(jobId: Hex): Promise<Deal> {
      escrow.reads++
      return dealOrDefault(jobId)
    },

    async fund(jobId: Hex, deadlineSec: number, amountWei: bigint): Promise<Hex> {
      const forced = takeFailure('fund')
      if (forced) throw forced

      const deal = dealOrDefault(jobId)
      if (deal.state !== 'none') throw revert('DealExists')
      if (amountWei === 0n) throw revert('ZeroAmount')
      if (deadlineSec <= nowSec()) throw revert('DeadlineInPast')

      funded.push({ jobId, deadlineSec, amountWei })
      deals.set(jobId, {
        buyer: signer,
        worker: ZERO_ADDRESS,
        amount: amountWei,
        outputHash: ZERO_HASH,
        commitAtSec: 0,
        deadlineSec,
        state: 'funded',
      })
      return FAKE_TX_HASH
    },

    async commit(jobId: Hex, outputHash: Hex, buyerAuth: Hex): Promise<Hex> {
      const forced = takeFailure('commit')
      if (forced) throw forced

      const deal = dealOrDefault(jobId)
      if (deal.state !== 'funded') throw revert('NotFunded')
      if (nowSec() > deal.deadlineSec) throw revert('DeadlinePassed')
      if (outputHash === ZERO_HASH) throw revert('EmptyOutputHash')
      if (signer.toLowerCase() === deal.buyer.toLowerCase()) throw revert('BuyerIsNotWorker')
      if (buyerAuth !== fakeAuth(deal.buyer, jobId, signer)) throw revert('NotAuthorised')

      commits.push({ jobId, outputHash })
      deals.set(jobId, {
        ...deal,
        worker: signer,
        outputHash,
        commitAtSec: nowSec(),
        state: 'committed',
      })
      return FAKE_TX_HASH
    },

    async settle(jobId: Hex): Promise<Hex> {
      const forced = takeFailure('settle')
      if (forced) throw forced

      const deal = dealOrDefault(jobId)
      if (deal.state !== 'committed') throw revert('NotCommitted')

      settlements.push(jobId)
      deals.set(jobId, { ...deal, state: 'settled', amount: 0n })
      return FAKE_TX_HASH
    },

    async refund(jobId: Hex): Promise<Hex> {
      const forced = takeFailure('refund')
      if (forced) throw forced

      const deal = dealOrDefault(jobId)
      if (deal.state !== 'funded') throw revert('NotFunded')
      if (signer !== deal.buyer) throw revert('NotBuyer')
      if (nowSec() <= deal.deadlineSec) throw revert('DeadlineNotReached')

      refunds.push(jobId)
      deals.set(jobId, { ...deal, state: 'refunded', amount: 0n })
      return FAKE_TX_HASH
    },
  }

  return escrow
}

export type FakeOgOptions = {
  completion?: Partial<CompletionResult>
  completionDelayMs?: number
  completionError?: Error
  balance?: { creditBalance: string }
  models?: string[]
  catalog?: ModelInfo[] | 'fail'
}

export type FakeOg = OgClient & { calls: CompletionRequest[]; modes: TrustMode[] }

export function fakeOg(opts: FakeOgOptions = {}): FakeOg {
  const calls: CompletionRequest[] = []
  const modes: TrustMode[] = []
  const catalog = opts.catalog
  return {
    calls,
    modes,
    ...(catalog === undefined
      ? {}
      : {
          async catalog(): Promise<ModelInfo[]> {
            if (catalog === 'fail') throw new Error('Failed to fetch')
            return catalog
          },
        }),
    async models(): Promise<string[]> {
      return opts.models ?? ['0gm-1.0-35b-a3b']
    },
    async complete(req: CompletionRequest, mode: TrustMode): Promise<CompletionResult> {
      calls.push(req)
      modes.push(mode)
      if (opts.completionDelayMs) {
        await new Promise((r) => setTimeout(r, opts.completionDelayMs))
      }
      if (opts.completionError) throw opts.completionError
      return {
        text: 'the answer',
        modelServed: req.model,
        tokensIn: 3,
        tokensOut: 5,
        finishReason: 'stop',
        latencyMs: 10,
        ...opts.completion,
      }
    },
    async balance(): Promise<Balance> {
      return {
        address: '0x0000000000000000000000000000000000000000',
        currency: 'usd',
        depositBalance: '0',
        creditBalance: opts.balance?.creditBalance ?? '100',
        pendingCharge: '0',
        totalBalance: opts.balance?.creditBalance ?? '100',
      }
    },
  }
}

const BASE_ENV = {
  OG_BASE_URL: 'https://router-api.0g.ai',
  OG_INFERE: 'sk-fake',
  OG_MANAGE: 'mk-fake',
}

export type FakeDepsOptions = FakeOgOptions & {
  arkiv?: FakeArkiv
  swarm?: FakeSwarm
  workerId?: string
  pricePer1kOut?: bigint
  now?: () => number
  config?: Partial<DuskConfig>
  dayStartCredits?: bigint
  escrow?: FakeEscrow
  deliverMarginMs?: number
}

export type FakeDeps = WorkerDeps & { arkiv: FakeArkiv; swarm: FakeSwarm; og: FakeOg }

export function fakeDeps(opts: FakeDepsOptions = {}): FakeDeps {
  const now = opts.now ?? (() => 1_000)
  const config = { ...loadConfig(BASE_ENV), ...opts.config }
  return {
    arkiv: opts.arkiv ?? fakeArkiv(now),
    og: fakeOg(opts),
    swarm: opts.swarm ?? fakeSwarm(),
    config,
    workerId: opts.workerId ?? `0x${'aa'.repeat(32)}`,
    payout: opts.escrow ? opts.escrow.signer : `0x${'11'.repeat(20)}`,
    pricePer1kOut: opts.pricePer1kOut ?? 1n,
    models: opts.models ?? ['0gm-1.0-35b-a3b'],
    dayStartCredits: opts.dayStartCredits ?? 100n,
    now,
    escrow: opts.escrow,
    deliverMarginMs: opts.deliverMarginMs ?? config.ttl.claim * 1000,
  }
}

export type FakeOgImage = OgImageClient & {
  submits: ImageRequest[]
  pollCount: () => number
}

export function fakeOgImage(opts: {
  polls?: Array<ImagePoll | Error>
  submitError?: Error
} = {}): FakeOgImage {
  const submits: ImageRequest[] = []
  const polls = opts.polls ?? [{ state: 'pending' }]
  let n = 0
  return {
    submits,
    pollCount: () => n,
    async submitImage(req: ImageRequest): Promise<ImageSubmission> {
      submits.push(req)
      if (opts.submitError) throw opts.submitError
      return { jobId: `img-${submits.length}`, providerAddress: '0xprov' }
    },
    async pollImage(): Promise<ImagePoll> {
      const next = polls[Math.min(n, polls.length - 1)]!
      n++
      if (next instanceof Error) throw next
      return next
    },
  }
}
