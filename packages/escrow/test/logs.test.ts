import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'

const ADDRESS: Address = '0x2cd51c09ca44001a86b8491fadef099d24560f75'
const BUYER: Address = `0x${'d1'.repeat(20)}`
const KEY: Hex = `0x${'11'.repeat(32)}`

function log(block: bigint) {
  return {
    args: { jobId: `0x${block.toString(16).padStart(64, '0')}` as Hex, buyer: BUYER },
    transactionHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: block,
  }
}

function stubNode(opts: { head: bigint; maxSpan: bigint; staleHead?: bigint }) {
  const calls: Array<{ from: bigint; to: bigint }> = []
  let refusals = 0
  const client = {
    async getBlockNumber(args?: { cacheTime?: number }): Promise<bigint> {
      return args?.cacheTime === 0 ? opts.head : (opts.staleHead ?? opts.head)
    },
    async getLogs(args: { fromBlock: bigint; toBlock: bigint }): Promise<unknown[]> {
      const span = args.toBlock - args.fromBlock + 1n
      if (span > opts.maxSpan) {
        refusals += 1
        throw new Error('query returned more than 10000 results')
      }
      calls.push({ from: args.fromBlock, to: args.toBlock })
      const out: unknown[] = []
      for (let b = args.fromBlock; b <= args.toBlock; b += 1n) {
        if (b <= opts.head) out.push(log(b))
      }
      return out
    },
  }
  return { client, calls, refusals: () => refusals }
}

async function clientOver(node: ReturnType<typeof stubNode>) {
  vi.resetModules()
  const viem = await import('viem')
  vi.doMock('viem', () => ({
    ...viem,
    createPublicClient: () => node.client,
    createWalletClient: () => ({ writeContract: async () => '0x' }),
  }))
  const { createEscrowClient } = await import('../src/client')
  return createEscrowClient({ rpc: 'http://stub.invalid', chainId: 16602, address: ADDRESS, privateKey: KEY })
}

describe('idsFromLogs — the block-range walk', () => {
  it('returns every log when the node refuses the full span', async () => {
    const node = stubNode({ head: 100n, maxSpan: 10n })
    const escrow = await clientOver(node)

    const found = await escrow.fundedBy(BUYER)

    expect(found).toHaveLength(101)
    expect(node.refusals()).toBeGreaterThan(0)
  })

  it('covers the range with no gap and no overlap', async () => {
    const node = stubNode({ head: 100n, maxSpan: 10n })
    const escrow = await clientOver(node)

    const found = await escrow.fundedBy(BUYER)
    const blocks = found.map((r) => r.blockNumber).sort((a, b) => Number(a - b))

    expect(new Set(blocks).size).toBe(blocks.length)
    expect(blocks[0]).toBe(0n)
    expect(blocks[blocks.length - 1]).toBe(100n)
  })

  it('terminates rather than looping when the node refuses even a single block', async () => {
    const node = stubNode({ head: 10n, maxSpan: 0n })
    const escrow = await clientOver(node)

    await expect(escrow.fundedBy(BUYER)).rejects.toThrow(/10000 results/)
  })

  it('finds a deal in the newest block even when getBlockNumber would serve a stale head', async () => {
    const node = stubNode({ head: 100n, maxSpan: 1_000n, staleHead: 95n })
    const escrow = await clientOver(node)

    const found = await escrow.fundedBy(BUYER)

    expect(found.map((r) => r.blockNumber)).toContain(100n)
  })

  it('honours fromBlock, so a caller can skip history it has already walked', async () => {
    const node = stubNode({ head: 100n, maxSpan: 1_000n })
    const escrow = await clientOver(node)

    const found = await escrow.fundedBy(BUYER, 90n)

    expect(found).toHaveLength(11)
    expect(found[0]?.blockNumber).toBe(90n)
  })
})
