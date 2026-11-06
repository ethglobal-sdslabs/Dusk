import { describe, expect, it } from 'vitest'
import { requestWalletAccounts, revokeWalletAccess } from '../src/index'

function fakeWallet(opts: { accounts?: string[]; supportsRevoke?: boolean; supportsPermissions?: boolean } = {}) {
  const accounts = opts.accounts ?? ['0x1111111111111111111111111111111111111111']
  const calls: string[] = []
  let permitted = true

  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method)
      if (method === 'wallet_revokePermissions') {
        if (opts.supportsRevoke === false) {
          throw Object.assign(new Error('The method does not exist'), { code: -32601 })
        }
        permitted = false
        return null
      }
      if (method === 'wallet_requestPermissions') {
        if (opts.supportsPermissions === false) {
          throw Object.assign(new Error('The method does not exist'), { code: -32601 })
        }
        permitted = true
        return [{ parentCapability: 'eth_accounts' }]
      }
      if (method === 'eth_requestAccounts') {
        permitted = true
        return accounts
      }
      if (method === 'eth_accounts') return permitted ? accounts : []
      throw new Error(`unexpected ${method}`)
    },
  }
  return { provider, calls, permitted: () => permitted }
}

describe('revokeWalletAccess', () => {
  it('gives the eth_accounts permission back, so the site is really disconnected', async () => {
    const wallet = fakeWallet()

    await revokeWalletAccess(wallet.provider as never)

    expect(wallet.calls).toContain('wallet_revokePermissions')
    expect(wallet.permitted()).toBe(false)
    expect(await wallet.provider.request({ method: 'eth_accounts' })).toEqual([])
  })

  it('does not throw on a wallet with no revoke method', async () => {
    const wallet = fakeWallet({ supportsRevoke: false })

    await expect(revokeWalletAccess(wallet.provider as never)).resolves.toBeUndefined()
  })
})

describe('requestWalletAccounts', () => {
  it('asks for permission first, so the account picker opens even if a permission survived', async () => {
    const wallet = fakeWallet()

    const accounts = await requestWalletAccounts(wallet.provider as never)

    expect(wallet.calls.indexOf('wallet_requestPermissions')).toBeLessThan(
      wallet.calls.indexOf('eth_requestAccounts'),
    )
    expect(accounts).toEqual(['0x1111111111111111111111111111111111111111'])
  })

  it('still connects on a wallet without wallet_requestPermissions', async () => {
    const wallet = fakeWallet({ supportsPermissions: false })

    expect(await requestWalletAccounts(wallet.provider as never)).toEqual([
      '0x1111111111111111111111111111111111111111',
    ])
  })

  it('propagates a rejected prompt rather than reporting a connection', async () => {
    const provider = {
      request: async () => {
        throw Object.assign(new Error('User rejected the request'), { code: 4001 })
      },
    }

    await expect(requestWalletAccounts(provider as never)).rejects.toThrow(/rejected/i)
  })
})
