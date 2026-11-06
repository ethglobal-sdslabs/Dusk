import { describe, expect, it } from 'vitest'
import { ensureWalletChain, WalletChainError } from '../src/index'

const ARKIV = { chainId: 7794095, name: 'Arkiv Rabdi', rpcUrl: 'https://rpc.rabdi.example' }

type Behaviour = {
  known?: number[]
  addActivates?: boolean
  rejectSwitch?: boolean
}

function fakeWallet(startChainId: number, behaviour: Behaviour = {}) {
  const known = new Set(behaviour.known ?? [startChainId])
  const calls: string[] = []
  let current = startChainId

  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      calls.push(method)
      if (method === 'eth_chainId') return `0x${current.toString(16)}`
      if (method === 'wallet_switchEthereumChain') {
        const want = Number((params as [{ chainId: string }])[0].chainId)
        if (behaviour.rejectSwitch) throw Object.assign(new Error('User rejected'), { code: 4001 })
        if (!known.has(want)) throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 })
        current = want
        return null
      }
      if (method === 'wallet_addEthereumChain') {
        const want = Number((params as [{ chainId: string }])[0].chainId)
        known.add(want)
        if (behaviour.addActivates) current = want
        return null
      }
      throw new Error(`unexpected ${method}`)
    },
  }
  return { provider, calls, chainId: () => current }
}

describe('ensureWalletChain', () => {
  it('leaves the wallet on the target chain when adding it does not activate it', async () => {
    const wallet = fakeWallet(16602, { addActivates: false })

    await ensureWalletChain(wallet.provider as never, ARKIV)

    expect(wallet.chainId()).toBe(7794095)
    expect(wallet.calls).toContain('wallet_addEthereumChain')
  })

  it('still ends on the target chain when adding does activate it', async () => {
    const wallet = fakeWallet(16602, { addActivates: true })

    await ensureWalletChain(wallet.provider as never, ARKIV)

    expect(wallet.chainId()).toBe(7794095)
  })

  it('switches without adding when the wallet already knows the chain', async () => {
    const wallet = fakeWallet(16602, { known: [16602, 7794095] })

    await ensureWalletChain(wallet.provider as never, ARKIV)

    expect(wallet.chainId()).toBe(7794095)
    expect(wallet.calls).not.toContain('wallet_addEthereumChain')
  })

  it('does nothing when the wallet is already on the target chain', async () => {
    const wallet = fakeWallet(7794095)

    await ensureWalletChain(wallet.provider as never, ARKIV)

    expect(wallet.calls).not.toContain('wallet_switchEthereumChain')
    expect(wallet.calls).not.toContain('wallet_addEthereumChain')
  })

  it('throws naming both chains when the wallet will not leave the wrong one', async () => {
    const wallet = fakeWallet(16602, { known: [16602, 7794095], rejectSwitch: true })

    const failure = await ensureWalletChain(wallet.provider as never, ARKIV).catch((e) => e)

    expect(failure).toBeInstanceOf(WalletChainError)
    expect(failure.message).toContain('Arkiv Rabdi')
    expect(failure.message).toContain('7794095')
    expect(failure.message).toContain('16602')
  })

  it('reports the chain the wallet actually ended on, not the one that was asked for', async () => {
    const quiet = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x40da'
        return null
      },
    }

    const failure = await ensureWalletChain(quiet as never, ARKIV).catch((e) => e)

    expect(failure).toBeInstanceOf(WalletChainError)
    expect(failure.message).toContain('16602')
  })
})
