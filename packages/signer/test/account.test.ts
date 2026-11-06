import { describe, expect, it } from 'vitest'
import { custom, type Address, type EIP1193Provider } from 'viem'
import { signerTransport, walletSignerFor } from '../src/index'

const alice = '0x1111111111111111111111111111111111111111' as Address
const bob = '0x2222222222222222222222222222222222222222' as Address
const data = { domain: { name: 'Dusk' }, types: { Message: [{ name: 'text', type: 'string' }] }, primaryType: 'Message', message: { text: 'example' } } as const

function wallet() {
  let selected: Address | undefined = alice
  const signed: string[] = []
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return selected ? [selected] : []
    signed.push(method)
    return '0x'
  } } as unknown as EIP1193Provider
  return { provider, signed, select: (next?: Address) => { selected = next } }
}

describe('wallet account binding', () => {
  it('refuses queued typed-data signatures after an account switch or disconnect', async () => {
    const w = wallet()
    const signer = walletSignerFor(w.provider, alice)
    for (const selected of [bob, undefined]) {
      w.select(selected)
      await expect(signer.signTypedData(data)).rejects.toThrow(/wallet changed or disconnected/)
    }
    expect(w.signed).toEqual([])
    w.select(alice)
    await expect(signer.signTypedData(data)).resolves.toBe('0x')
    expect(w.signed).toEqual(['eth_signTypedData_v4'])
  })

  it('refuses a transaction from a stale signer while leaving public reads available', async () => {
    const w = wallet()
    const signer = walletSignerFor(w.provider, alice)
    const transport = signerTransport(signer, custom({ request: async () => '0x1' }))({ retryCount: 0 })
    w.select(bob)
    await expect(transport.request({ method: 'eth_sendTransaction', params: [{ from: alice, to: bob }] })).rejects.toThrow(/wallet changed or disconnected/)
    expect(w.signed).toEqual([])
    expect(await transport.request({ method: 'eth_blockNumber' })).toBe('0x1')
  })
})
