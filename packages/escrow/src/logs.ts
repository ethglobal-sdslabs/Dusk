import type { Address, Hex, PublicClient } from 'viem'
import { DUSK_ESCROW_ABI } from './abi'

export type EscrowEventName = 'Funded' | 'Committed' | 'Settled' | 'Refunded' | 'Challenged'

export type RawEscrowLog = {
  args?: { jobId?: Hex; buyer?: Address; worker?: Address; amount?: bigint; outputHash?: Hex }
  transactionHash: Hex
  blockNumber: bigint
}

export function retryingFetch(attempts: number, perAttemptMs = PER_ATTEMPT_TIMEOUT_MS): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const sendsRaw = typeof init?.body === 'string' && init.body.includes('eth_sendRawTransaction')
    let lastErr: unknown
    for (let i = 1; i <= attempts; i++) {
      const timeout = AbortSignal.timeout(perAttemptMs)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      try {
        const res = await fetch(input, { ...init, signal })
        if (res.status >= 500 && i < attempts) {
          lastErr = new Error(`HTTP ${res.status}`)
          await new Promise((r) => setTimeout(r, i * 300))
          continue
        }
        return res
      } catch (e) {
        lastErr = e
        if (i === attempts || init?.signal?.aborted) throw e
        if (sendsRaw && timeout.aborted) throw e
        await new Promise((r) => setTimeout(r, i * 300))
      }
    }
    throw lastErr
  }) as typeof fetch
}

export const PER_ATTEMPT_TIMEOUT_MS = 15_000

export function overallTimeoutMs(attempts: number, perAttemptMs = PER_ATTEMPT_TIMEOUT_MS): number {
  return attempts * (perAttemptMs + attempts * 300)
}

export async function walkLogs(
  pub: Pick<PublicClient, 'getBlockNumber' | 'getLogs'>,
  address: Address,
  eventName: EscrowEventName,
  args: Record<string, Address>,
  fromBlock = 0n,
): Promise<RawEscrowLog[]> {
  const legacyChallengeEvent = {
    type: 'event', name: 'Challenged', anonymous: false,
    inputs: [
      { name: 'jobId', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
    ],
  } as const
  const event = (eventName === 'Challenged' ? legacyChallengeEvent : DUSK_ESCROW_ABI.find(
    (item) => item.type === 'event' && item.name === eventName,
  )) as never
  const latest = await pub.getBlockNumber({ cacheTime: 0 })
  const out: RawEscrowLog[] = []

  let from = fromBlock
  let span = latest - from + 1n
  while (from <= latest) {
    const to = from + span - 1n > latest ? latest : from + span - 1n
    try {
      const logs = await pub.getLogs({
        address,
        event,
        args: args as never,
        fromBlock: from,
        toBlock: to,
      })
      out.push(...(logs as unknown as RawEscrowLog[]))
      from = to + 1n
    } catch (e) {
      if (span === 1n) throw e
      span = span / 2n > 0n ? span / 2n : 1n
    }
  }
  return out
}
