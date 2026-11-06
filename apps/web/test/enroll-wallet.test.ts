import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsConfig, RegistrationOp } from '@dusk/ens'
import { commitmentOf, newRegistration } from '@dusk/ens'
import type { DuskSigner } from '@dusk/signer'
import type { Address, EIP1193Provider, Hex } from 'viem'
import { createEnrollClient } from '../src/lib/enroll'

const reads = vi.hoisted(() => ({
  contract: vi.fn(),
  receipt: vi.fn(),
  block: vi.fn(),
  identity: vi.fn(),
  text: vi.fn(),
}))
vi.mock('viem', async (original) => ({
  ...await original<typeof import('viem')>(),
  createPublicClient: () => ({ readContract: reads.contract, waitForTransactionReceipt: reads.receipt, getBlock: reads.block, getEnsText: reads.text }),
}))
vi.mock('@dusk/ens', async (original) => ({
  ...await original<typeof import('@dusk/ens')>(),
  createEnsReader: () => ({ identityOf: reads.identity }),
}))

const address = '0x1111111111111111111111111111111111111111' as Address
const controller = '0x2222222222222222222222222222222222222222' as Address
const resolver = '0x3333333333333333333333333333333333333333' as Address
const tx = `0x${'ab'.repeat(32)}` as Hex
const config: EnsConfig = { mode: 'enrollment', chainId: 11155111, rpc: 'http://no-rpc-expected.invalid', parentName: 'dusk.eth', controller, universalResolver: resolver }

function connectedWallet() {
  let chain = 16602
  const writes: Array<{ from: Address; to: Address; data: Hex }> = []
  const provider = { request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return `0x${chain.toString(16)}`
    if (method === 'eth_accounts') return [address]
    if (method === 'eth_sendTransaction') {
      writes.push(params![0] as typeof writes[number])
      return tx
    }
    throw new Error(`Unexpected wallet request: ${method}`)
  }) } as unknown as EIP1193Provider
  const switchChain = vi.fn(async (target: { chainId: number }) => { chain = target.chainId })
  const signer: DuskSigner = { address, type: 'json-rpc', provider, switchChain, signTypedData: vi.fn() }
  return { signer, writes, switchChain }
}

beforeEach(() => {
  vi.clearAllMocks()
  reads.receipt.mockResolvedValue({ status: 'success', blockNumber: 1n })
  reads.block.mockResolvedValue({ timestamp: 1800n })
})

describe('ENS enrollment through a connected wallet', () => {
  it('checks role-name availability for the connected wallet rather than public availability', async () => {
    const wallet = connectedWallet()
    const client = createEnrollClient(config, wallet.signer)
    reads.contract.mockResolvedValueOnce(true)
    await expect(client.available('revoker')).resolves.toBe(true)
    expect(reads.contract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'availableTo', args: ['revoker', address] }))
    expect(wallet.writes).toHaveLength(0)
  })

  it('commits and registers through the wallet without requesting a private key', async () => {
    const wallet = connectedWallet()
    const client = createEnrollClient(config, wallet.signer)
    const op = newRegistration({ chainId: config.chainId, controller, wallet: address, parentName: config.parentName, label: 'alice', now: 1 })
    reads.contract.mockResolvedValue(commitmentOf(op))
    const saved: RegistrationOp[] = []
    const committed = await client.commit(op, (pending) => saved.push(pending))
    const registered = await client.register(committed, (pending) => saved.push(pending))
    expect(wallet.switchChain).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111 }))
    expect(wallet.writes).toHaveLength(2)
    expect(wallet.writes.every((write) => write.from.toLowerCase() === address && write.to.toLowerCase() === controller)).toBe(true)
    expect(saved[0]!.commitTx).toBe(tx)
    expect(saved[1]!.registerTx).toBe(tx)
    expect(registered.registeredAt).toBeDefined()
    expect(wallet.signer.publicKey).toBeUndefined()
  })

  it('refuses a reservation belonging to another wallet or deployment before signing', async () => {
    const wallet = connectedWallet()
    const client = createEnrollClient(config, wallet.signer)
    const op = newRegistration({ chainId: config.chainId, controller, wallet: address, parentName: config.parentName, label: 'alice', now: 1 })
    for (const foreign of [{ ...op, wallet: resolver }, { ...op, controller: resolver }, { ...op, chainId: 1 }]) {
      await expect(client.commit(foreign, () => {})).rejects.toThrow(/another wallet or namespace/)
      await expect(client.register(foreign, () => {})).rejects.toThrow(/another wallet or namespace/)
    }
    expect(wallet.writes).toHaveLength(0)
  })

  it('keeps a broadcast transaction resumable when its receipt times out', async () => {
    const wallet = connectedWallet()
    const client = createEnrollClient(config, wallet.signer)
    const op = newRegistration({ chainId: config.chainId, controller, wallet: address, parentName: config.parentName, label: 'alice', now: 1 })
    reads.contract.mockResolvedValue(commitmentOf(op))
    reads.receipt.mockRejectedValueOnce(new Error('receipt timeout'))
    let pending = op
    await expect(client.commit(op, (value) => { pending = value })).rejects.toThrow('receipt timeout')
    expect(pending.commitTx).toBe(tx)
    await client.commit(pending, () => {})
    expect(wallet.writes).toHaveLength(1)
  })

  it('checks current ownership before asking the wallet to edit a profile', async () => {
    const wallet = connectedWallet()
    const client = createEnrollClient(config, wallet.signer)
    reads.identity.mockResolvedValue({ wallet: address, status: 'banned', name: 'alice.dusk.eth' })
    await expect(client.setDescription('alice.dusk.eth', 'Hello')).rejects.toThrow(/no longer owns/)
    expect(wallet.writes).toHaveLength(0)
    reads.identity.mockResolvedValue({ wallet: address, status: 'active', name: 'alice.dusk.eth' })
    reads.contract.mockResolvedValue(resolver)
    reads.text.mockResolvedValue('Hello')
    await expect(client.setDescription('alice.dusk.eth', 'Hello')).resolves.toEqual({ hash: tx, verified: true })
    expect(wallet.writes[0]!.to.toLowerCase()).toBe(resolver)
    reads.text.mockRejectedValueOnce(new Error('RPC unavailable'))
    await expect(client.setDescription('alice.dusk.eth', 'Hello')).resolves.toEqual({ hash: tx, verified: false })
  })
})
