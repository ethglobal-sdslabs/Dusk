import type { Address, Log } from 'viem'
import type { ArkivStore, IdentityMirror, ModerationMirror, ReputationMirror } from '@dusk/core'
import { attrEq } from '@dusk/arkiv'
import type { EnsConfig } from './config'
import { mirrorsFromLogs } from './mirror'
import { reputationMirrorsFromLogs } from './reputation-mirror'

export type IndexerDeps = {
  config: EnsConfig
  namespaceRegistry: Address
  arkiv: ArkivStore & { address: Address }
  chain: {
    finalizedBlock(): Promise<bigint>
    getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>
  }
  ttlSeconds: number
  chunk?: bigint
}

export async function indexOnce(deps: IndexerDeps, fromBlock: bigint): Promise<{ nextBlock: bigint; written: number; skipped: number }> {
  const controller = deps.config.controller
  if (!controller) throw new Error('ENS_CONTROLLER_ADDRESS is required to index.')
  const finalized = await deps.chain.finalizedBlock()
  if (finalized < fromBlock) return { nextBlock: fromBlock, written: 0, skipped: 0 }
  const chunk = deps.chunk ?? 5_000n
  let written = 0
  let skipped = 0
  for (let start = fromBlock; start <= finalized; start += chunk) {
    const end = start + chunk - 1n < finalized ? start + chunk - 1n : finalized
    const logs = await deps.chain.getLogs({ address: controller, fromBlock: start, toBlock: end })
    const { identities, moderations } = mirrorsFromLogs(deps.config, deps.namespaceRegistry, logs)
    const reputationLogs = deps.config.reputation ? await deps.chain.getLogs({ address: deps.config.reputation, fromBlock: start, toBlock: end }) : []
    const reputations = reputationMirrorsFromLogs(deps.config, deps.namespaceRegistry, reputationLogs)
    for (const [kind, rows] of [['identity_v1', identities], ['moderation_v1', moderations], ['reputation_v1', reputations]] as const) {
      for (const row of rows) {
        const existing = await deps.arkiv.query<IdentityMirror | ModerationMirror | ReputationMirror>(kind, attrEq(kind, 'sourceTx', row.sourceTx))
        const mine = existing.some((e) => e.sourceTx === row.sourceTx && e.sourceLogIndex === row.sourceLogIndex &&
          e.owner?.toLowerCase() === deps.arkiv.address.toLowerCase())
        if (mine) { skipped++; continue }
        await deps.arkiv.put(kind, row, { ttlSeconds: deps.ttlSeconds })
        written++
      }
    }
  }
  return { nextBlock: finalized + 1n, written, skipped }
}

export async function refreshMirrors(deps: Pick<IndexerDeps, 'arkiv' | 'ttlSeconds'>, at: { nowMs: number; lastRefreshMs: number }): Promise<number> {
  if (at.nowMs - at.lastRefreshMs < (deps.ttlSeconds * 1000) / 2) return 0
  let extended = 0
  for (const kind of ['identity_v1', 'moderation_v1', 'reputation_v1'] as const) {
    const rows = await deps.arkiv.query<IdentityMirror | ModerationMirror | ReputationMirror>(kind)
    for (const row of rows) {
      if (row.owner?.toLowerCase() !== deps.arkiv.address.toLowerCase()) continue
      await deps.arkiv.extend(row.id, deps.ttlSeconds)
      extended++
    }
  }
  return extended
}
