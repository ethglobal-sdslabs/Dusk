'use client'

import { attrEq, createArkivReader, createArkivStore, type ArkivReader } from '@dusk/arkiv'
import { grantCandidates } from '@dusk/buyer'
import type { BuyerDeps } from '@dusk/buyer'
import type { Claim, DuskConfig, EscrowClient, Job, Kind, Receipt } from '@dusk/core'
import { createEscrowClient } from '@dusk/escrow'
import { unseal } from '@dusk/crypto'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import type { Expression } from '@arkiv-network/sdk/query'
import type { Hex } from 'viem'
import { localSigner, type DuskSigner } from '@dusk/signer'
import { browserArkivAccessKey } from './config'
import { browserAdmit, type Admit } from './ens'

export type BuyQuery = { kind: Kind; filter: Expression }

export type JobIds = Pick<Job, 'id' | 'escrowId'>

export function buyQueries(job: JobIds): Record<'job' | 'claims' | 'receipt', BuyQuery> {
  return {
    job: { kind: 'job', filter: attrEq('job', 'escrowId', job.escrowId) },
    claims: { kind: 'claim', filter: attrEq('claim', 'jobId', job.id) },
    receipt: { kind: 'receipt', filter: attrEq('receipt', 'jobId', job.id) },
  }
}

export type JobSnapshot = {
  job: Job | undefined
  claims: Claim[]
  receipt: Receipt | undefined
  readAt: number
}

export async function readJob(reader: ArkivReader, job: JobIds, nowMs: number): Promise<JobSnapshot> {
  const q = buyQueries(job)
  const [jobs, claims, receipts] = await Promise.all([
    reader.query<Job>(q.job.kind, q.job.filter),
    reader.query<Claim>(q.claims.kind, q.claims.filter),
    reader.query<Receipt>(q.receipt.kind, q.receipt.filter),
  ])
  return {
    job: jobs.find((j) => j.escrowId === job.escrowId),
    claims: claims.filter((c) => c.jobId === job.id),
    receipt: receipts.find((r) => r.jobId === job.id),
    readAt: nowMs,
  }
}

export async function readJobs(
  reader: ArkivReader,
  jobs: readonly Job[],
  nowMs: number,
): Promise<Map<string, JobSnapshot>> {
  const settled = await Promise.allSettled(jobs.map((job) => readJob(reader, job, nowMs)))
  const out = new Map<string, JobSnapshot>()
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') out.set(jobs[i]!.id, result.value)
  })
  return out
}

export function grantTargets(args: {
  jobs: readonly Job[]
  snapshots: ReadonlyMap<string, JobSnapshot>
  granted: ReadonlyMap<string, ReadonlySet<string>>
  banned?: ReadonlySet<string>
}): Array<{ job: Job; claim: Claim }> {
  const out: Array<{ job: Job; claim: Claim }> = []
  for (const job of args.jobs) {
    const all = args.snapshots.get(job.id)?.claims
    if (!all) continue
    const claims = args.banned
      ? all.filter((c) => !c.owner || !args.banned!.has(c.owner.toLowerCase()))
      : all
    const claim = nextGrant({ job, claims, granted: args.granted.get(job.id) ?? new Set() })
    if (claim) out.push({ job, claim })
  }
  return out
}

export function buildBrowserBuyer(args: {
  config: DuskConfig
  signer?: DuskSigner
  signingKey?: Hex
  unsealOutput?: (sealed: Hex) => string
  admit?: Admit
}): BuyerDeps & { address: string } {
  const { config, signingKey } = args
  const signer = args.signer ?? (signingKey ? localSigner(signingKey) : undefined)
  if (!signer) throw new Error('A wallet signer or signing key is required to post a job.')
  const accessKey = browserArkivAccessKey()

  const escrow: EscrowClient | undefined = config.escrow.address
    ? createEscrowClient({
        rpc: config.escrow.rpc,
        chainId: config.escrow.chainId,
        address: config.escrow.address,
        signer,
      })
    : undefined

  return {
    arkiv: createArkivStore({
      rpc: config.arkiv.rpc,
      chainId: config.arkiv.chainId,
      signer,
      ...(accessKey ? { accessKey } : {}),
    }),
    swarm: createSwarmStore({
      uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
      downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
    }),
    escrow,
    buyerPubkey: signer.publicKey ?? '0x',
    address: signer.address,
    now: () => Date.now(),
    clock: config.clock,
    ttlGrantSeconds: config.ttl.grant,
    imageModels: config.og.imageModels,
    ...(args.unsealOutput
      ? { unsealOutput: args.unsealOutput }
      : signingKey
        ? { unsealOutput: (sealed: Hex) => unseal(sealed, signingKey) }
        : {}),
    ...((): { admit?: Admit } => { const admit = args.admit ?? browserAdmit(); return admit ? { admit } : {} })(),
  }
}

export function buyReader(config: DuskConfig): ArkivReader {
  const accessKey = browserArkivAccessKey()
  return createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, ...(accessKey ? { accessKey } : {}) })
}

export function nextGrant(args: {
  job: Job
  claims: readonly Claim[]
  granted: ReadonlySet<string>
}): Claim | null {
  return grantCandidates(args.job, args.claims).find((c) => !args.granted.has(c.workerId)) ?? null
}

export function liveGrantedWorkers(
  grantedAt: ReadonlyMap<string, number>,
  nowMs: number,
  grantTtlMs: number,
): Set<string> {
  const live = new Set<string>()
  for (const [workerId, at] of grantedAt) if (nowMs - at < grantTtlMs) live.add(workerId)
  return live
}
