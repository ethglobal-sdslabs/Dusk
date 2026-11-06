import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, getAddress, isAddress, toHex, type Abi, type Address, type Hex } from 'viem'
import { DuskIdentityControllerAbi } from '../../ens/src/controller-abi'
import { DuskReputationAbi } from '../../ens/src/reputation-abi'
import { DUSK_ESCROW_ABI } from '../../escrow/src/abi'
import { encodeReputationReport } from '../../ens/src/reputation-report'
import { evaluateReputation, reputationFindings, reputationSourceHash, type ReputationCommit, type ReputationEntity, type ReputationFacts, type ReputationResolution } from '../../ens/src/reputation-score'
import { reputationWorkflowSources, type ReputationWorkflowConfig } from './config'

export type ReputationRpc = (url: string, method: string, params: readonly unknown[]) => unknown
type Header = { number: Hex; timestamp: Hex; hash: Hex }
const hash = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v)
const object = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Incomplete chain response; no reputation was published.')
  return v as Record<string, unknown>
}
const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]+$/i.test(v)) throw new Error('Invalid chain quantity; no reputation was published.')
  return BigInt(v)
}

function snapshot(rpc: ReputationRpc, url: string, chainId: number): Header {
  if (quantity(rpc(url, 'eth_chainId', [])) !== BigInt(chainId)) throw new Error('Reputation RPC is on another chain.')
  const h = object(rpc(url, 'eth_getBlockByNumber', ['finalized', false]))
  quantity(h.number); quantity(h.timestamp)
  if (!hash(h.hash)) throw new Error('A finalized source block is unavailable; no reputation was published.')
  return h as Header
}

function call(rpc: ReputationRpc, url: string, block: Hex, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): unknown {
  const data = encodeFunctionData({ abi, functionName, args })
  const reply = rpc(url, 'eth_call', [{ to: address, data }, block])
  if (typeof reply !== 'string' || !/^0x[0-9a-f]*$/i.test(reply)) throw new Error('Incomplete contract response; no reputation was published.')
  return decodeFunctionResult({ abi, functionName, data: reply as Hex })
}

function marketLogs(rpc: ReputationRpc, c: ReputationWorkflowConfig, finalized: Hex) {
  const topics = ['Committed', 'Settled', 'Rejected'].map((eventName) => encodeEventTopics({ abi: DUSK_ESCROW_ABI, eventName: eventName as 'Committed' })[0]!)
  const commits: ReputationCommit[] = []
  const resolutions: ReputationResolution[] = []
  const read = (from: bigint, to: bigint): unknown[] => {
    let response: unknown
    try { response = rpc(c.galileo.rpc, 'eth_getLogs', [{ address: c.galileo.escrow, fromBlock: toHex(from), toBlock: toHex(to), topics: [topics] }]) } catch {
      if (from === to) throw new Error('Escrow history is incomplete; no reputation was published.')
      const middle = (from + to) / 2n
      return [...read(from, middle), ...read(middle + 1n, to)]
    }
    if (!Array.isArray(response)) throw new Error('Escrow history is incomplete; no reputation was published.')
    return response
  }
  const end = BigInt(finalized)
  for (let from = BigInt(c.galileo.fromBlock); from <= end; from += BigInt(c.limits.logRange)) {
    const to = from + BigInt(c.limits.logRange) - 1n > end ? end : from + BigInt(c.limits.logRange) - 1n
    for (const raw of read(from, to)) {
      const log = object(raw)
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== c.galileo.escrow.toLowerCase() || log.removed === true ||
          !hash(log.transactionHash) || quantity(log.blockNumber) < from || quantity(log.blockNumber) > to || !Array.isArray(log.topics)) throw new Error('Unexpected escrow log; no reputation was published.')
      const event = decodeEventLog({ abi: DUSK_ESCROW_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
      if (event.eventName === 'Committed') commits.push({ escrowId: event.args.jobId, worker: event.args.worker, outputHash: event.args.outputHash, blockNumber: BigInt(log.blockNumber as Hex), transactionHash: log.transactionHash })
      else if (event.eventName === 'Settled' || event.eventName === 'Rejected') resolutions.push({ escrowId: event.args.jobId, worker: event.args.worker, result: event.eventName === 'Settled' ? 'settled' : 'rejected', blockNumber: BigInt(log.blockNumber as Hex), transactionHash: log.transactionHash })
      else throw new Error('Wrong escrow event; no reputation was published.')
    }
  }
  return { commits, resolutions }
}

function arkivEntities(rpc: ReputationRpc, c: ReputationWorkflowConfig, kind: 'receipt' | 'verification', finalized: bigint): ReputationEntity[] {
  const out: ReputationEntity[] = []
  let after: Hex | undefined
  for (let page = 0; page < c.limits.maxPages; page++) {
    const query = `arkiv.schema = str('dusk.${kind}')${after ? ` AND $key > key(${after})` : ''} ORDER BY $key:key ASC`
    const result = object(rpc(c.arkiv.rpc, 'arkiv_query', [query, { select: { key: true, creator: true, createdAt: true, creationFlags: true, attributes: true }, limit: '0x64' }]))
    if (!Array.isArray(result.data)) throw new Error('Arkiv evidence is incomplete; no reputation was published.')
    for (const raw of result.data) {
      const entity = object(raw)
      if (!hash(entity.key) || (after && entity.key.toLowerCase() <= after.toLowerCase())) throw new Error('Arkiv paging did not advance; no reputation was published.')
      after = entity.key
      if (typeof entity.creator !== 'string' || !isAddress(entity.creator, { strict: false }) || !Array.isArray(entity.attributes)) continue
      const flags = typeof entity.creationFlags === 'number' ? entity.creationFlags : Number(object(entity.creationFlags).raw)
      if (!Number.isInteger(flags) || (flags & 1) !== 1) continue
      const created = quantity(entity.createdAt)
      if (created > finalized) continue
      const attributes = new Map<string, { type: string; value: unknown }>()
      for (const rawAttribute of entity.attributes) {
        const attribute = object(rawAttribute)
        if (typeof attribute.name === 'string' && typeof attribute.type === 'string') attributes.set(attribute.name, { type: attribute.type, value: attribute.value })
      }
      const field = (name: string, type: string) => attributes.get(name)?.type === type ? attributes.get(name)?.value : undefined
      const escrowId = field('escrow_id', 'str')
      const worker = field('worker', 'addr')
      if (!hash(escrowId) || typeof worker !== 'string' || !isAddress(worker, { strict: false })) continue
      const outputHash = field('output_hash', 'str')
      const resultKind = field('result', 'str')
      if (kind === 'receipt' && !hash(outputHash)) continue
      if (kind === 'verification' && !['pass', 'bad', 'illegal'].includes(String(resultKind))) continue
      // Policy v2: why a verdict was given, and the canary's latency (claim to receipt).
      const check = field('check', 'str')
      const latencyMs = u64Number(field('latency_ms', 'u64'))
      out.push({ id: entity.key, creator: getAddress(entity.creator.toLowerCase()), readonly: true, createdAtBlock: created,
        escrowId, worker: getAddress(worker.toLowerCase()), ...(hash(outputHash) ? { outputHash } : {}),
        ...(kind === 'verification' ? {
          result: resultKind as 'pass' | 'bad' | 'illegal',
          ...(typeof check === 'string' ? { check } : {}),
          ...(latencyMs !== undefined && Number.isFinite(latencyMs) ? { latencyMs } : {}),
        } : {}) })
    }
    if (result.data.length < 100) return out
  }
  throw new Error('Arkiv scan limit reached; refusing a partial reputation evaluation.')
}

export function collectReputationReports(c: ReputationWorkflowConfig, rpc: ReputationRpc, nowSec: bigint, storeEvidence: (bundle: string) => Hex): { reports: Hex[]; evaluated: number } {
  const ens = snapshot(rpc, c.ens.rpc, c.ens.chainId)
  const galileo = snapshot(rpc, c.galileo.rpc, c.galileo.chainId)
  const arkiv = snapshot(rpc, c.arkiv.rpc, c.arkiv.chainId)
  const read = (address: Address, abi: Abi, name: string, args?: readonly unknown[]) => call(rpc, c.ens.rpc, ens.number, address, abi, name, args)
  if (String(read(c.ens.reputation, DuskReputationAbi, 'CONTROLLER')).toLowerCase() !== c.ens.controller.toLowerCase()) throw new Error('Reputation contract is bound to another namespace.')
  if (String(read(c.ens.controller, DuskIdentityControllerAbi, 'revoker')).toLowerCase() !== c.ens.reputation.toLowerCase()) throw new Error('The reputation contract does not hold the revoker role.')
  if (read(c.ens.reputation, DuskReputationAbi, 'paused') === true) throw new Error('Reputation automation is paused on-chain.')
  const sources = reputationWorkflowSources(c)
  const sourceHash = reputationSourceHash(sources)
  if (read(c.ens.reputation, DuskReputationAbi, 'sourceContextHash') !== sourceHash) throw new Error('Workflow evidence sources differ from the company-approved on-chain policy.')
  const epoch = Number(read(c.ens.reputation, DuskReputationAbi, 'policyEpoch'))
  const count = Number(read(c.ens.controller, DuskIdentityControllerAbi, 'memberCount'))
  if (!Number.isSafeInteger(count) || count > c.limits.maxWallets) throw new Error('Wallet inventory exceeds this workflow scan budget; refusing a partial evaluation.')
  const wallets: Address[] = []
  for (let offset = 0; offset < count; offset += 100) {
    const batch = read(c.ens.controller, DuskIdentityControllerAbi, 'memberWallets', [BigInt(offset), 100n]) as Address[]
    if (batch.length !== Math.min(100, count - offset)) throw new Error('Wallet inventory is incomplete; no reputation was published.')
    wallets.push(...batch)
  }
  if (new Set(wallets.map((w) => w.toLowerCase())).size !== count) throw new Error('Wallet inventory contains duplicate entries.')
  const market = marketLogs(rpc, c, galileo.number)
  const facts: ReputationFacts = { sources, ...market, finalizedArkivBlock: BigInt(arkiv.number),
    snapshotHashes: { ens: ens.hash, galileo: galileo.hash, arkiv: arkiv.hash },
    receipts: arkivEntities(rpc, c, 'receipt', BigInt(arkiv.number)), verifications: arkivEntities(rpc, c, 'verification', BigInt(arkiv.number)) }
  const evaluations = wallets.map((wallet) => {
    const membership = read(c.ens.controller, DuskIdentityControllerAbi, 'membershipOf', [wallet]) as [string, bigint, Address, bigint, number]
    if (membership[1] === 0n || membership[4] === 0) throw new Error('Wallet membership could not be verified; no reputation was published.')
    const fresh = reputationFindings(wallet, facts)
    const jobs = [...new Set(fresh.findings.map((f) => f.job))]
    const flags = new Map<string, number>()
    let badAnswers = 0
    let illegal = 0
    let late = 0
    let passed = 0
    for (let offset = 0; offset < Math.max(1, jobs.length); offset += 200) {
      const page = jobs.slice(offset, offset + 200)
      const state = read(c.ens.reputation, DuskReputationAbi, 'evaluationState', [wallet, page]) as [number, number, number, number, number[]]
      badAnswers = state[0]; illegal = state[1]; late = state[2]; passed = state[3]
      if (state[4].length !== page.length) throw new Error('On-chain finding ledger is incomplete.')
      page.forEach((job, i) => flags.set(job.toLowerCase(), state[4][i]!))
    }
    return evaluateReputation({ wallet, generation: membership[1], evaluatedAt: nowSec, galileoBlock: BigInt(galileo.number), facts, previous: { badAnswers, illegal, late, passed, flags } })
  })
  const reports: Hex[] = []
  for (let i = 0; i < evaluations.length; i += 20) {
    const batch = evaluations.slice(i, i + 20)
    const evidenceRef = storeEvidence(JSON.stringify({ version: 1, records: batch.map((r) => JSON.parse(r.evidence)) }))
    if (!hash(evidenceRef) || /^0x0+$/.test(evidenceRef)) throw new Error('Public reputation evidence was not retained; refusing publication.')
    reports.push(encodeReputationReport({ chainId: c.ens.chainId, receiver: c.ens.reputation, epoch, sources: sourceHash,
      evaluations: batch.map((r) => ({ ...r.evaluation, evidenceRef })) }))
  }
  return { reports, evaluated: evaluations.length }
}

/** A `u64` attribute as Arkiv's RPC returns it — measured live: a hex string, e.g. '0x8ca0'. */
export function u64Number(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return undefined
  const n = Number(BigInt(value))
  return Number.isSafeInteger(n) ? n : undefined
}
