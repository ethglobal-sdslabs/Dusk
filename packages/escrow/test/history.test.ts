import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const ADDRESS: Address = '0x2cd51c09ca44001a86b8491fadef099d24560f75'
const BUYER: Address = `0x${'d1'.repeat(20)}`
const job = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex

function stubNode() {
  const getLogsCalls: Array<{ event: { name: string }; args: unknown }> = []
  const client = {
    async getBlockNumber(): Promise<bigint> {
      return 50n
    },
    async getLogs(args: { event: { name: string }; args: unknown; fromBlock: bigint; toBlock: bigint }) {
      getLogsCalls.push({ event: args.event, args: args.args })
      return [
        {
          args: { jobId: job(1), buyer: BUYER, worker: BUYER, amount: 8000n, deadline: 99n },
          transactionHash: `0x${'ab'.repeat(32)}` as Hex,
          blockNumber: 10n,
        },
      ]
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: 1_700_000_000n + blockNumber }
    },
  }
  return { client, getLogsCalls }
}

async function historyOver(node: ReturnType<typeof stubNode>) {
  vi.resetModules()
  const viem = await import('viem')
  vi.doMock('viem', () => ({ ...viem, createPublicClient: () => node.client }))
  const { createEscrowHistory } = await import('../src/history')
  return createEscrowHistory({ rpc: 'http://stub.invalid', chainId: 16602, address: ADDRESS })
}

describe('createEscrowHistory', () => {
  it('filters on the indexed party and keeps the amount the event carries', async () => {
    const node = stubNode()
    const history = await historyOver(node)
    const events = await history.events('Funded', BUYER)
    expect(node.getLogsCalls[0]!.event.name).toBe('Funded')
    expect(node.getLogsCalls[0]!.args).toEqual({ buyer: BUYER })
    expect(events).toEqual([
      { escrowId: job(1), party: BUYER, txHash: `0x${'ab'.repeat(32)}`, blockNumber: 10n, amountWei: 8000n },
    ])
  })

  it('filters Committed and Settled on the worker', async () => {
    const node = stubNode()
    const history = await historyOver(node)
    await history.events('Committed', BUYER)
    await history.events('Settled', BUYER)
    expect(node.getLogsCalls.map((c) => c.args)).toEqual([{ worker: BUYER }, { worker: BUYER }])
  })

  it('reads every party when none is given — the whole market, for reputation', async () => {
    const node = stubNode()
    const history = await historyOver(node)
    const events = await history.events('Committed')
    expect(node.getLogsCalls[0]!.args).toEqual({})
    expect(events[0]!.party).toBe(BUYER)
  })

  it('filters Challenged on the buyer', async () => {
    const node = stubNode()
    const history = await historyOver(node)
    await history.events('Challenged', BUYER)
    expect(node.getLogsCalls[0]!.args).toEqual({ buyer: BUYER })
    expect(node.getLogsCalls[0]!.event.name).toBe('Challenged')
  })

  it('reads each distinct block time once, in unix ms', async () => {
    const node = stubNode()
    const spy = vi.spyOn(node.client, 'getBlock')
    const history = await historyOver(node)
    const times = await history.blockTimes([10n, 10n, 12n])
    expect(times.get(10n)).toBe((1_700_000_000 + 10) * 1000)
    expect(times.get(12n)).toBe((1_700_000_000 + 12) * 1000)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
