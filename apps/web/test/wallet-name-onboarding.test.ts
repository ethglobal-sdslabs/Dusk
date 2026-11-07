// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { DuskSigner } from '@dusk/signer'
import type { VerifiedIdentity } from '@dusk/ens'
import { WalletNameOnboarding } from '../src/components/WalletNameOnboarding'
import type { WalletState } from '../src/lib/wallet'

const mocks = vi.hoisted(() => ({ setup: null as unknown, read: vi.fn(), disconnect: vi.fn() }))
vi.mock('../src/lib/config', () => ({ browserEnsSetup: () => mocks.setup }))
vi.mock('@dusk/ens', async (original) => ({ ...await original<typeof import('@dusk/ens')>(), createEnsReader: () => ({ identityOf: mocks.read }) }))
vi.mock('../src/components/EnsIdentity', () => ({ EnsIdentity: () => createElement('input', { name: 'ens-label' }) }))
const address = '0x1111111111111111111111111111111111111111' as Address
const other = '0x2222222222222222222222222222222222222222' as Address
const registry = '0x3333333333333333333333333333333333333333' as Address
const snapshot = (wallet: Address, status: VerifiedIdentity['status']): VerifiedIdentity => ({ wallet, status, name: status === 'active' ? 'alice.dusk.eth' : undefined, registry, chainId: 11155111, checkedAt: Date.now() })
const wallet = (value: Address | null): WalletState => ({ status: value ? 'connected' : 'disconnected', address: value,
  signer: value ? { address: value } as DuskSigner : null, unseal: null, error: null, local: true, connect: async () => {}, pasteKey: () => null, disconnect: mocks.disconnect })
let container: HTMLDivElement
let root: Root
const render = async (value: Address | null = address) => { await act(async () => root.render(createElement(WalletNameOnboarding, { wallet: wallet(value) }))) }
const dialog = () => container.querySelector('dialog')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.open = false })
  mocks.setup = { config: { mode: 'enrollment', chainId: 11155111, registry, controller: registry }, status: 'ready' }
  mocks.read.mockImplementation(async (value: Address) => snapshot(value, 'unnamed'))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('compulsory first-wallet name setup', () => {
  it('keeps anonymous browsing available and opens setup immediately for an unnamed wallet', async () => {
    await render(null); expect(dialog()).toBeNull(); expect(mocks.read).not.toHaveBeenCalled()
    await render(); expect(dialog()?.open).toBe(true)
    expect(container.querySelector('input[name="ens-label"]')).not.toBeNull()
  })

  it('reuses an existing verified name without flashing the setup prompt', async () => {
    let resolve!: (value: VerifiedIdentity) => void
    mocks.read.mockReturnValue(new Promise<VerifiedIdentity>((done) => { resolve = done }))
    await render(); expect(dialog()).toBeNull()
    await act(async () => resolve(snapshot(address, 'active')))
    expect(dialog()).toBeNull()
  })

  it('closes setup only after a changed name verifies on-chain', async () => {
    await render(); expect(dialog()?.open).toBe(true)
    mocks.read.mockResolvedValue(snapshot(address, 'active'))
    await act(async () => window.dispatchEvent(new CustomEvent('dusk:identity-changed', { detail: address })))
    expect(dialog()).toBeNull()
  })

  it('does not use a previous wallet’s late verified result to admit the next wallet', async () => {
    let resolve!: (value: VerifiedIdentity) => void
    mocks.read.mockImplementation((value: Address) => value === address ? new Promise<VerifiedIdentity>((done) => { resolve = done }) : Promise.resolve(snapshot(value, 'unnamed')))
    await render(address); await render(other)
    expect(dialog()?.open).toBe(true)
    await act(async () => resolve(snapshot(address, 'active')))
    expect(dialog()?.open).toBe(true)
  })

  it('asks for no name with ENS off, and still requires one when the RPC is unavailable', async () => {
    mocks.setup = { config: null, status: 'disabled' }
    await render(); expect(dialog()).toBeNull(); expect(mocks.read).not.toHaveBeenCalled()
    await act(async () => root.unmount()); root = createRoot(container)
    mocks.setup = { config: { mode: 'enrollment', chainId: 11155111, registry, controller: registry } }
    mocks.read.mockRejectedValue(new Error('RPC down'))
    await render(); expect(dialog()?.open).toBe(true)
  })

  it('lets Escape disconnect to browse instead of skipping the required name', async () => {
    await render()
    const cancel = new Event('cancel', { cancelable: true })
    await act(async () => dialog()!.dispatchEvent(cancel))
    expect(cancel.defaultPrevented).toBe(true)
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    await render(null); expect(dialog()).toBeNull()
  })
})
