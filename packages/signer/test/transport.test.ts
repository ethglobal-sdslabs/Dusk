import { describe, expect, it } from 'vitest'
import { hybridTransport, walletHandles } from '../src/index'

describe('walletHandles', () => {
  it('sends state-changing and signing methods to the wallet', () => {
    for (const method of [
      'eth_sendTransaction',
      'eth_sendRawTransaction',
      'eth_sign',
      'eth_signTypedData_v4',
      'personal_sign',
      'eth_accounts',
      'eth_requestAccounts',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_revokePermissions',
    ]) {
      expect(walletHandles(method), method).toBe(true)
    }
  })

  it('sends eth_chainId to the wallet, because that is what makes viem’s chain assertion real', () => {
    expect(walletHandles('eth_chainId')).toBe(true)
  })

  it('sends reads to Dusk’s own transport, which is the one carrying the Arkiv access key', () => {
    for (const method of [
      'eth_blockNumber',
      'eth_call',
      'eth_estimateGas',
      'eth_getTransactionReceipt',
      'eth_getTransactionByHash',
      'eth_getBlockByNumber',
      'eth_getLogs',
      'eth_gasPrice',
      'arkiv_query',
      'arkiv_getEntity',
      'arkiv_getBlockTiming',
    ]) {
      expect(walletHandles(method), method).toBe(false)
    }
  })
})

describe('hybridTransport', () => {
  function routed() {
    const seen: Array<{ at: 'wallet' | 'read'; method: string }> = []
    const provider = {
      request: async ({ method }: { method: string }) => {
        seen.push({ at: 'wallet', method })
        return 'from-wallet'
      },
    }
    const read = () => ({
      config: { key: 'fake', name: 'fake', request: async () => null, type: 'fake' },
      request: async ({ method }: { method: string }) => {
        seen.push({ at: 'read', method })
        return 'from-read'
      },
      value: undefined,
    })
    const transport = hybridTransport(provider as never, read as never)({})
    return { transport, seen }
  }

  it('routes a send to the wallet and a receipt lookup to the read transport', async () => {
    const { transport, seen } = routed()

    expect(await transport.request({ method: 'eth_sendTransaction', params: [] })).toBe('from-wallet')
    expect(await transport.request({ method: 'eth_getTransactionReceipt', params: [] })).toBe('from-read')

    expect(seen).toEqual([
      { at: 'wallet', method: 'eth_sendTransaction' },
      { at: 'read', method: 'eth_getTransactionReceipt' },
    ])
  })

  it('routes the Arkiv gas estimate to the read transport, not through the wallet', async () => {
    const { transport, seen } = routed()

    await transport.request({ method: 'eth_estimateGas', params: [] })
    await transport.request({ method: 'eth_blockNumber', params: [] })

    expect(seen.every((s) => s.at === 'read')).toBe(true)
  })

  it('asks the wallet for eth_chainId even though the read transport could answer it', async () => {
    const { transport, seen } = routed()

    await transport.request({ method: 'eth_chainId', params: [] })

    expect(seen).toEqual([{ at: 'wallet', method: 'eth_chainId' }])
  })
})
