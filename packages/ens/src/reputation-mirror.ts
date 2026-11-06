import { createPublicClient, decodeEventLog, getAddress, http, namehash, type Address, type Hex, type Log, type PublicClient } from 'viem'
import type { ReputationMirror } from '@dusk/core'
import { DuskIdentityControllerAbi } from './controller-abi'
import { DuskReputationAbi } from './reputation-abi'
import type { EnsConfig } from './config'

export const REPUTATION_STANDINGS = ['banned', 'new', 'trusted', 'good', 'disputed'] as const
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const safe = (n: number | bigint) => { const value = Number(n); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe reputation integer.'); return value }
type Row = Omit<ReputationMirror, 'id' | 'owner' | 'creator' | 'creationFlags' | 'createdAtBlock'>

export function reputationMirrorsFromLogs(config: EnsConfig, namespaceRegistry: Address, logs: Log[]): Row[] {
  if (!config.reputation || !config.controller) return []
  const rows: Row[] = []
  for (const log of logs) {
    if (!same(log.address, config.reputation) || log.removed || !log.blockHash || !log.transactionHash || log.logIndex === null || log.blockNumber === null) continue
    try {
      const event = decodeEventLog({ abi: DuskReputationAbi, topics: log.topics, data: log.data })
      if (event.eventName !== 'ReputationPublished') continue
      const { wallet, label, generation, reputation: r } = event.args
      const ensName = `${label}.${config.parentName}`
      if (r.namehash !== event.args.namehash || r.namehash !== namehash(ensName) || r.generation !== generation || r.publishedAtBlock !== log.blockNumber || r.score > 100) continue
      const standing = REPUTATION_STANDINGS[r.standing]
      if (!standing) continue
      rows.push({
        wallet: getAddress(wallet), ensChainId: config.chainId, controller: getAddress(config.reputation), identityController: getAddress(config.controller),
        namespaceRegistry: getAddress(namespaceRegistry), ensName, ensNamehash: r.namehash, generation: safe(generation), sequence: safe(r.sequence),
        score: r.score, standing, resolvedJobs: r.resolvedJobs, badAnswers: r.badAnswers, illegal: r.illegal, late: r.late, passed: r.passed,
        policyVersion: r.policyVersion, policyEpoch: r.policyEpoch, evaluatedAt: safe(r.evaluatedAt),
        galileoBlock: safe(r.galileoBlock), arkivBlock: safe(r.arkivBlock), evidenceHash: r.evidenceHash, evidenceRef: r.evidenceRef,
        sourceContextHash: r.sourceContextHash, sourceTx: log.transactionHash, sourceBlock: safe(log.blockNumber), sourceBlockHash: log.blockHash, sourceLogIndex: log.logIndex,
      })
    } catch { }
  }
  return rows
}

export type ReputationChainClient = Pick<PublicClient, 'getChainId' | 'getBlock' | 'getTransactionReceipt' | 'readContract'>

export async function verifyReputationMirror(config: EnsConfig, chain: ReputationChainClient, row: ReputationMirror, namespaceRegistry: Address): Promise<boolean> {
  if (!config.reputation || !config.controller || row.ensChainId !== config.chainId || !same(row.controller, config.reputation) ||
      !same(row.identityController, config.controller) || !same(row.namespaceRegistry, namespaceRegistry)) return false
  try {
    if (await chain.getChainId() !== config.chainId) return false
    const finalized = await chain.getBlock({ blockTag: 'finalized' })
    if (finalized.number === null || BigInt(row.sourceBlock) > finalized.number) return false
    const receipt = await chain.getTransactionReceipt({ hash: row.sourceTx })
    if (receipt.status !== 'success' || receipt.blockNumber !== BigInt(row.sourceBlock) || receipt.blockHash !== row.sourceBlockHash) return false
    const canonical = await chain.getBlock({ blockNumber: receipt.blockNumber })
    if (canonical.hash !== receipt.blockHash) return false
    const log = receipt.logs.find((l) => l.logIndex === row.sourceLogIndex)
    if (!log) return false
    const expected = reputationMirrorsFromLogs(config, namespaceRegistry, [{ ...log, blockHash: receipt.blockHash }])[0]
    if (!expected) return false
    return Object.entries(expected).every(([key, value]) => {
      const actual = row[key as keyof ReputationMirror]
      return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? typeof actual === 'string' && same(value, actual) : value === actual
    })
  } catch { return false }
}

export type PublishedReputation = Pick<ReputationMirror, 'score' | 'standing' | 'resolvedJobs' | 'badAnswers' | 'illegal' | 'late' | 'passed' | 'policyVersion' | 'policyEpoch' | 'generation' | 'sequence' | 'evaluatedAt' | 'evidenceHash' | 'evidenceRef'>
export type PublishedReputationResult = { status: 'verified' | 'stale' | 'missing' | 'unknown'; source?: 'mirror' | 'chain'; record?: PublishedReputation }

export function createPublishedReputationReader(config: EnsConfig, client?: ReputationChainClient, opts: { now?: () => number; maxAgeMs?: number } = {}) {
  const chain = client ?? createPublicClient({ transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) })
  const now = opts.now ?? Date.now
  let context: Promise<{ blockNumber: bigint; registry: Address; epoch: number }> | undefined
  const source = () => context ??= (async () => {
    if (!config.reputation || !config.controller || await chain.getChainId() !== config.chainId) throw new Error('Reputation source is unavailable.')
    const block = await chain.getBlock({ blockTag: 'finalized' })
    if (block.number === null) throw new Error('No finalized reputation state.')
    const [boundController, registry, epoch] = await Promise.all([
      chain.readContract({ address: config.reputation, abi: DuskReputationAbi, functionName: 'CONTROLLER', blockNumber: block.number }),
      chain.readContract({ address: config.controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY', blockNumber: block.number }),
      chain.readContract({ address: config.reputation, abi: DuskReputationAbi, functionName: 'policyEpoch', blockNumber: block.number }),
    ])
    if (!same(boundController, config.controller) || config.childRegistry && !same(registry, config.childRegistry)) throw new Error('Reputation is bound to another namespace.')
    return { blockNumber: block.number, registry, epoch }
  })()
  return {
    async read(wallet: Address, candidates: readonly ReputationMirror[] = []): Promise<PublishedReputationResult> {
      if (!config.reputation || !config.controller) return { status: 'missing' }
      try {
        const context = await source()
        const r = await chain.readContract({ address: config.reputation, abi: DuskReputationAbi, functionName: 'reputationOf', args: [wallet], blockNumber: context.blockNumber })
        if (r.sequence === 0n) return { status: 'missing' }
        const standing = REPUTATION_STANDINGS[r.standing]
        if (!standing) return { status: 'unknown' }
        const record: PublishedReputation = { score: r.score, standing, resolvedJobs: r.resolvedJobs, badAnswers: r.badAnswers, illegal: r.illegal, late: r.late, passed: r.passed,
          policyVersion: r.policyVersion, policyEpoch: r.policyEpoch, generation: safe(r.generation), sequence: safe(r.sequence), evaluatedAt: safe(r.evaluatedAt), evidenceHash: r.evidenceHash, evidenceRef: r.evidenceRef }
        const age = now() - record.evaluatedAt * 1000
        const status = r.policyEpoch !== context.epoch || age < 0 || age > (opts.maxAgeMs ?? 5 * 3600_000) ? 'stale' : 'verified'
        for (const row of candidates.filter((c) => same(c.wallet, wallet) && c.sequence === record.sequence).slice(0, 8)) {
          if (await verifyReputationMirror(config, chain, row, context.registry)) return { status, source: 'mirror', record }
        }
        return { status, source: 'chain', record }
      } catch { return { status: 'unknown' } }
    },
  }
}
