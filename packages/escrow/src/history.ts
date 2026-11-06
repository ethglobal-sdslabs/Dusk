import { createPublicClient, http, type Address, type Hex } from 'viem'
import { galileoChain, type Deal, type DealState } from '@dusk/core'
import { DEAL_STATES, DUSK_ESCROW_ABI } from './abi'
import { overallTimeoutMs, retryingFetch, walkLogs } from './logs'

export type EscrowHistoryConfig = { rpc: string; chainId: number; address: Address; attempts?: number }

export type HistoryEventName = 'Funded' | 'Committed' | 'Settled' | 'Challenged'

export type HistoryEvent = {
  escrowId: Hex
  party: Address
  txHash: Hex
  blockNumber: bigint
  amountWei?: bigint
  outputHash?: Hex
}

export type EscrowHistory = {
  events(name: HistoryEventName, party?: Address, fromBlock?: bigint): Promise<HistoryEvent[]>
  blockTimes(blocks: readonly bigint[]): Promise<Map<bigint, number>>
  deal(escrowId: Hex): Promise<Deal>
}

const PARTY: Record<HistoryEventName, 'buyer' | 'worker'> = {
  Funded: 'buyer',
  Committed: 'worker',
  Settled: 'worker',
  Challenged: 'buyer',
}

export function createEscrowHistory(cfg: EscrowHistoryConfig): EscrowHistory {
  const chain = galileoChain({ chainId: cfg.chainId, rpc: cfg.rpc })
  const transport = http(cfg.rpc, { fetchFn: retryingFetch(Math.max(1, cfg.attempts ?? 4)), retryCount: 0, timeout: overallTimeoutMs(Math.max(1, cfg.attempts ?? 4)) })
  const pub = createPublicClient({ chain, transport })

  return {
    async events(name, party, fromBlock) {
      const role = PARTY[name]
      const logs = await walkLogs(pub, cfg.address, name, party ? { [role]: party } : {}, fromBlock)
      return logs.flatMap((log) => {
        const escrowId = log.args?.jobId
        if (!escrowId) return []
        const amountWei = log.args?.amount
        const outputHash = log.args?.outputHash
        const who = log.args?.[role] ?? party
        if (!who) return []
        return [
          {
            escrowId,
            party: who,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            ...(amountWei === undefined ? {} : { amountWei }),
            ...(outputHash === undefined ? {} : { outputHash }),
          },
        ]
      })
    },

    async blockTimes(blocks) {
      const distinct = [...new Set(blocks)]
      const times = await Promise.all(
        distinct.map(async (blockNumber) => {
          const block = await pub.getBlock({ blockNumber })
          return [blockNumber, Number(block.timestamp) * 1000] as const
        }),
      )
      return new Map(times)
    },

    async deal(escrowId) {
      const raw = (await pub.readContract({
        address: cfg.address,
        abi: DUSK_ESCROW_ABI,
        functionName: 'deals',
        args: [escrowId],
      })) as readonly [Address, Address, bigint, Hex, bigint, bigint, number]
      const [buyer, worker, amount, outputHash, commitAt, deadline, state] = raw
      return {
        buyer,
        worker,
        amount,
        outputHash,
        commitAtSec: Number(commitAt),
        deadlineSec: Number(deadline),
        state: DEAL_STATES[state] as DealState,
      }
    },
  }
}
