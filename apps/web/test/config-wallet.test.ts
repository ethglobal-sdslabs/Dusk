// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { useWallet } from '../src/lib/wallet'
import { GET } from '../src/app/api/config/route'
import { seal } from '@dusk/crypto'

const sample = vi.hoisted(() => ({ buyer: `0x${'11'.repeat(32)}`, worker: `0x${'22'.repeat(32)}`, operator: `0x${'33'.repeat(32)}` }))
vi.mock('@dusk/core/credentials-file', () => ({ readCredentials: () => ({ buyerPrivateKey: sample.buyer, workerPrivateKey: sample.worker, settings: { ENS_OWNER_PRIVATE_KEY: sample.operator } }) }))
const req = (query: string, site = 'same-origin') => ({ url: `http://localhost:3000/api/config${query}`, headers: { get: (name: string) => name === 'host' ? 'localhost:3000' : name === 'sec-fetch-site' ? site : null } }) as unknown as Request

describe('configured local wallet access', () => {
  afterEach(() => vi.restoreAllMocks())
  it('exposes only the requested party key on loopback, never operator keys', async () => {
    expect(await (await GET(req('?wallet=buyer'))).json()).toEqual({ privateKey: sample.buyer })
    expect(await (await GET(req('?wallet=worker'))).json()).toEqual({ privateKey: sample.worker })
    expect(JSON.stringify(await (await GET(req(''))).json())).not.toContain(sample.operator)
    expect((await GET(req('?wallet=buyer', 'cross-site'))).status).toBe(403)
    expect((await GET(req('?wallet=operator'))).status).toBe(400)
  })
  it('loads the configured worker signer without contacting an injected wallet', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ privateKey: sample.worker }), { status: 200 }))
    const request = vi.fn()
    Object.defineProperty(window, 'ethereum', { value: { request }, configurable: true })
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    function Probe() { const wallet = useWallet('worker'); return createElement('p', null, `${wallet.status}:${wallet.address ?? ''}`) }
    await act(async () => { root.render(createElement(Probe)) })
    expect(container.textContent).toContain(privateKeyToAccount(sample.worker as `0x${string}`).address)
    expect(fetchMock).toHaveBeenCalledWith('/api/config?wallet=worker', expect.any(Object))
    expect(request).not.toHaveBeenCalled()
    await act(async () => root.unmount()); container.remove()
  })
  it('hands out an unseal capability for the configured key, never the key itself', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ privateKey: sample.worker }), { status: 200 }))
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    let state: ReturnType<typeof useWallet> | undefined
    function Probe() { state = useWallet('worker'); return null }
    await act(async () => { root.render(createElement(Probe)) })
    const account = privateKeyToAccount(sample.worker as `0x${string}`)
    expect(state?.unseal).toBeTypeOf('function')
    expect(state!.unseal!(seal('a'.repeat(128), account.publicKey))).toBe('a'.repeat(128))
    expect(JSON.stringify(Object.keys(state!))).not.toMatch(/privateKey/)
    await act(async () => root.unmount()); container.remove()
  })
})
