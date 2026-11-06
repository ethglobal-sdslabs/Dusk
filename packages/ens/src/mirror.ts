import { decodeEventLog, getAddress, namehash, type Address, type Hex, type Log } from 'viem'
import type { IdentityMirror, ModerationMirror } from '@dusk/core'
import type { EnsConfig } from './config'
import { DuskIdentityControllerAbi } from './controller-abi'

export const IDENTITY_SCHEMA_VERSION = 1

type IdentityRow = Omit<IdentityMirror, 'id' | 'owner' | 'createdAtBlock'>
type ModerationRow = Omit<ModerationMirror, 'id' | 'owner' | 'createdAtBlock'>

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function decode(log: Log) {
  try {
    return decodeEventLog({ abi: DuskIdentityControllerAbi, data: log.data, topics: log.topics })
  } catch {
    return undefined
  }
}

export function mirrorsFromLogs(config: EnsConfig, namespaceRegistry: Address, logs: Log[]): { identities: IdentityRow[]; moderations: ModerationRow[] } {
  const identities: IdentityRow[] = []
  const moderations: ModerationRow[] = []
  if (!config.controller) return { identities, moderations }
  for (const log of logs) {
    if (!same(log.address, config.controller) || log.removed || log.transactionHash === null || log.logIndex === null || log.blockNumber === null) continue
    const event = decode(log)
    if (event?.eventName === 'Registered') {
      const ensName = `${event.args.label}.${config.parentName}`
      identities.push({
        wallet: getAddress(event.args.wallet), ensChainId: config.chainId, controller: getAddress(log.address),
        namespaceRegistry: getAddress(namespaceRegistry), ensName, ensNamehash: namehash(ensName),
        generation: Number(event.args.generation), resolver: getAddress(event.args.resolver),
        sourceTx: log.transactionHash, sourceBlock: Number(log.blockNumber), sourceLogIndex: log.logIndex,
        schemaVersion: IDENTITY_SCHEMA_VERSION,
      })
    } else if (event?.eventName === 'ModerationDecision' && log.blockHash) {
      moderations.push({
        subjectWallet: getAddress(event.args.wallet), sourceChainId: config.chainId, controller: getAddress(log.address),
        namespaceRegistry: getAddress(namespaceRegistry), sequence: Number(event.args.sequence), decisionId: event.args.decisionId,
        action: event.args.action === 1 ? 'ban' : 'unban', policyVersion: Number(event.args.policyVersion),
        reasonCode: Number(event.args.reasonCode), evidenceHash: event.args.evidenceHash, sourceTx: log.transactionHash,
        sourceBlock: Number(log.blockNumber), sourceBlockHash: log.blockHash, sourceLogIndex: log.logIndex,
      })
    }
  }
  return { identities, moderations }
}

export interface MirrorChainClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; logs: Log[] }>
}

async function rederive(config: EnsConfig, chain: MirrorChainClient, sourceTx: Hex, logIndex: number) {
  if (!config.controller) return undefined
  try {
    const receipt = await chain.getTransactionReceipt({ hash: sourceTx })
    if (receipt.status !== 'success') return undefined
    const log = receipt.logs.find((l) => l.logIndex === logIndex)
    if (!log || !same(log.address, config.controller)) return undefined
    return { receipt, log }
  } catch {
    return undefined
  }
}

export async function verifyIdentityMirror(config: EnsConfig, chain: MirrorChainClient, row: IdentityMirror, namespaceRegistry: Address): Promise<boolean> {
  if (row.ensChainId !== config.chainId || !config.controller || !same(row.controller, config.controller)) return false
  if (!same(row.namespaceRegistry, namespaceRegistry)) return false
  const found = await rederive(config, chain, row.sourceTx, row.sourceLogIndex)
  if (!found || Number(found.receipt.blockNumber) !== row.sourceBlock) return false
  const [expected] = mirrorsFromLogs(config, row.namespaceRegistry, [found.log]).identities
  if (!expected) return false
  return same(expected.wallet, row.wallet) && expected.ensName === row.ensName && expected.ensNamehash === row.ensNamehash &&
    expected.generation === row.generation && same(expected.resolver, row.resolver) && row.schemaVersion === IDENTITY_SCHEMA_VERSION
}

export async function verifyModerationMirror(config: EnsConfig, chain: MirrorChainClient, row: ModerationMirror, namespaceRegistry: Address): Promise<boolean> {
  if (row.sourceChainId !== config.chainId || !config.controller || !same(row.controller, config.controller)) return false
  if (!same(row.namespaceRegistry, namespaceRegistry)) return false
  const found = await rederive(config, chain, row.sourceTx, row.sourceLogIndex)
  if (!found || Number(found.receipt.blockNumber) !== row.sourceBlock || found.receipt.blockHash !== row.sourceBlockHash) return false
  const [expected] = mirrorsFromLogs(config, row.namespaceRegistry, [{ ...found.log, blockHash: found.receipt.blockHash }]).moderations
  if (!expected) return false
  return same(expected.subjectWallet, row.subjectWallet) && expected.sequence === row.sequence && expected.decisionId === row.decisionId &&
    expected.action === row.action && expected.reasonCode === row.reasonCode && expected.evidenceHash === row.evidenceHash &&
    expected.policyVersion === row.policyVersion
}

export function banStateFrom(rows: ModerationMirror[]): Map<string, { banned: boolean; sequence: number; decisionId: Hex }> {
  const state = new Map<string, { banned: boolean; sequence: number; decisionId: Hex }>()
  for (const row of rows) {
    const key = row.subjectWallet.toLowerCase()
    const current = state.get(key)
    if (!current || row.sequence > current.sequence) state.set(key, { banned: row.action === 'ban', sequence: row.sequence, decisionId: row.decisionId })
  }
  return state
}
