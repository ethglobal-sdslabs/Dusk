// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address } from 'viem'
import type { DuskSigner } from '@dusk/signer'
import type { EnsConfig, RegistrationOp, VerifiedIdentity } from '@dusk/ens'
import { EnsIdentity } from '../src/components/EnsIdentity'
import { enrollDraftKey, enrollStorageKey, saveOp } from '../src/lib/enroll'

const mocks = vi.hoisted(() => ({ setup: null as unknown, identity: vi.fn(), profile: vi.fn(), available: vi.fn(), paused: vi.fn(), commit: vi.fn(), register: vi.fn(), invalidate: vi.fn() }))
vi.mock('../src/lib/config', () => ({ browserEnsSetup: () => mocks.setup }))
vi.mock('../src/lib/ens', () => ({ invalidateWalletIdentity: (...args: unknown[]) => mocks.invalidate(...args) }))
vi.mock('@dusk/ens', async (original) => ({ ...await original<typeof import('@dusk/ens')>(), createEnsReader: () => ({ identityOf: mocks.identity, profileOf: mocks.profile }) }))
vi.mock('../src/lib/enroll', async (original) => ({
  ...await original<typeof import('../src/lib/enroll')>(),
  createEnrollClient: (_config: EnsConfig, signer: DuskSigner) => ({ address: signer.address, controller,
    available: mocks.available, registrationPaused: mocks.paused, commit: mocks.commit, register: mocks.register,
    timing: async () => ({ minAgeSec: 60, maxAgeSec: 86400 }), chainNowMs: async () => Date.now() }),
}))

const address = '0x1111111111111111111111111111111111111111' as Address
const other = '0x2222222222222222222222222222222222222222' as Address
const controller = '0x3333333333333333333333333333333333333333' as Address
const signer = { address, type: 'json-rpc' } as DuskSigner
const config: EnsConfig = { mode: 'enrollment', chainId: 11155111, parentName: 'dusk.eth', rpc: 'https://rpc.example', controller }
const snapshot = (status: VerifiedIdentity['status']): VerifiedIdentity => ({ wallet: address, chainId: 11155111, registry: controller, checkedAt: Date.now(), status })
let container: HTMLDivElement
let root: Root

async function render(wallet: DuskSigner | null = signer) { await act(async () => { root.render(createElement(EnsIdentity, { signer: wallet ?? undefined })) }) }
function input() { return container.querySelector<HTMLInputElement>('input[name="ens-label"]')! }
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  localStorage.clear()
  mocks.setup = { config, parentName: 'dusk.eth', chainId: 11155111, status: 'ready' }
  mocks.identity.mockResolvedValue(snapshot('unnamed'))
  mocks.profile.mockResolvedValue({})
  mocks.available.mockResolvedValue(true)
  mocks.paused.mockResolvedValue(false)
  mocks.commit.mockImplementation(async (op: RegistrationOp, sent: (op: RegistrationOp) => void) => {
    const next = { ...op, commitTx: `0x${'ab'.repeat(32)}` as const, committedAt: Date.now() }; sent(next); return next
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('the rendered Dusk name setup', () => {
  it('shows the name field before wallet connection and before ENS deployment', async () => {
    mocks.setup = { config: null, parentName: 'dusk.eth', chainId: 11155111, status: 'disabled' }
    await render(null)
    expect(input()).not.toBeNull()
    expect(input().disabled).toBe(true)
    expect(container.textContent).toContain('Connect a wallet to register a Dusk name.')
    await render(signer)
    expect(input().disabled).toBe(false)
    expect(button('Reserve name').disabled).toBe(true)
    expect(container.textContent).toContain('not available yet')
    expect(mocks.identity).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('keeps a draft across reloads without treating it as a registered name', async () => {
    mocks.setup = { config: null, parentName: 'dusk.eth', chainId: 11155111, status: 'disabled' }
    await render(); await type('alice')
    expect(localStorage.getItem(enrollDraftKey(11155111, 'dusk.eth', address))).toBe('alice')
    await act(async () => root.unmount()); root = createRoot(container); await render()
    expect(input().value).toBe('alice')
    expect(container.textContent).toContain('name preference')
    expect(container.textContent).not.toContain('verified on Sepolia')
  })

  it('isolates drafts when the connected wallet changes', async () => {
    mocks.setup = { config: null, parentName: 'dusk.eth', chainId: 11155111, status: 'disabled' }
    await render(); await type('alice')
    await render({ ...signer, address: other }); expect(input().value).toBe('')
    await type('bob'); await render(signer); expect(input().value).toBe('alice')
  })

  it('shows the input on an RPC failure but never enables a transaction', async () => {
    mocks.identity.mockResolvedValue(snapshot('unknown'))
    await render(); await type('alice')
    expect(input()).not.toBeNull()
    expect(button('Reserve name').disabled).toBe(true)
    expect(button('Check again')).toBeDefined()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('reuses an active name instead of offering the wallet a second registration', async () => {
    mocks.identity.mockResolvedValue({ ...snapshot('active'), name: 'alice.dusk.eth' })
    await render()
    expect(container.textContent).toContain('alice.dusk.eth')
    expect(container.querySelector('input[name="ens-label"]')).toBeNull()
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('reserves only after fresh eligibility, availability and pause checks', async () => {
    await render(); await type('alice')
    expect(button('Reserve name').disabled).toBe(false)
    await act(async () => button('Reserve name').click())
    expect(mocks.identity).toHaveBeenCalledTimes(2)
    expect(mocks.available).toHaveBeenCalledWith('alice')
    expect(mocks.paused).toHaveBeenCalledOnce()
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(input().disabled).toBe(true)
    expect(localStorage.getItem(enrollStorageKey(11155111, controller, address))).toContain('commitTx')
  })

  it('rechecks a newly banned wallet before opening any signing prompt', async () => {
    await render(); await type('alice')
    mocks.identity.mockResolvedValue(snapshot('banned'))
    await act(async () => button('Reserve name').click())
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('banned')
    expect(container.querySelector('input[name="ens-label"]')).toBeNull()
  })

  it('offers continuation after reload when an operation was saved before its first send', async () => {
    saveOp(localStorage, enrollStorageKey(11155111, controller, address), {
      chainId: 11155111, controller, wallet: address, label: 'alice', name: 'alice.dusk.eth', secret: `0x${'ab'.repeat(32)}`, createdAt: Date.now(),
    })
    await render()
    expect(button('Continue reservation')).toBeDefined()
    await act(async () => button('Continue reservation').click())
    expect(mocks.commit).toHaveBeenCalledOnce()
  })
})
