// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { checkSigningKey, forgetPastedKeys, useWallet, type WalletState } from '../src/lib/wallet'

const KEY = `0x${'44'.repeat(32)}` as const

async function mount(parties: Array<'buyer' | 'worker'>) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const states: WalletState[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  function Probe({ party, index }: { party: 'buyer' | 'worker'; index: number }) { states[index] = useWallet(party); return null }
  await act(async () => { root.render(parties.map((party, index) => createElement(Probe, { key: index, party, index }))) })
  return { states, unmount: async () => { await act(async () => root.unmount()); container.remove() } }
}

describe('wallet on a public deployment', () => {
  afterEach(() => { vi.restoreAllMocks(); forgetPastedKeys() })

  it('treats a 403 from /api/config as public, not as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }))
    const { states, unmount } = await mount(['buyer'])
    expect(states[0]).toMatchObject({ local: false, status: 'disconnected', error: null, signer: null })
    await unmount()
  })

  it('adopts a pasted key in memory and shares it with every hook for that party only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }))
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const { states, unmount } = await mount(['buyer', 'buyer', 'worker'])
    let problem: string | null = 'unset'
    await act(async () => { problem = states[0]!.pasteKey(KEY.slice(2)) })
    expect(problem).toBeNull()
    const address = privateKeyToAccount(KEY).address
    expect(states[0]!.address).toBe(address)
    expect(states[1]!.address).toBe(address)
    expect(states[2]!.address).toBeNull()
    expect(storage).not.toHaveBeenCalled()
    await act(async () => { states[1]!.disconnect() })
    expect(states[0]!.signer).toBeNull()
    await unmount()
  })

  it('keeps a pasted key across remounts within the tab', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }))
    const first = await mount(['worker'])
    await act(async () => { first.states[0]!.pasteKey(KEY) })
    await first.unmount()
    const second = await mount(['worker'])
    expect(second.states[0]!.address).toBe(privateKeyToAccount(KEY).address)
    await second.unmount()
  })

  it('rejects 0G keys and malformed input without echoing them', () => {
    const og = checkSigningKey('sk-abcdefghijklmnop')
    expect(og.ok).toBe(false)
    expect(JSON.stringify(og)).not.toContain('abcdefghijklmnop')
    expect(checkSigningKey('0x1234').ok).toBe(false)
    expect(checkSigningKey(` ${KEY.toUpperCase().replace('0X', '0x')} `)).toEqual({ ok: true, key: KEY })
  })
})
