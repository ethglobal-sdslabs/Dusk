import { describe, expect, it } from 'vitest'
import type { VerifiedIdentity } from '@dusk/ens'
import { browserEns } from '../src/lib/config'
import { browserAdmit, walletLabel } from '../src/lib/ens'
import { loadConfig } from '@dusk/core'
import { generatePrivateKey } from 'viem/accounts'
import { buildBrowserBuyer } from '../src/lib/buy'
import { buildBrowserWorker } from '../src/lib/worker-browser'

const REG = '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4'
const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe'
const wallet = '0x1111111111111111111111111111111111111111' as const

describe('browserEns', () => {
  it('is null when ENS is not switched on, so no page makes a Sepolia call by default', () => {
    expect(browserEns({})).toBeNull()
    expect(browserEns({ NEXT_PUBLIC_ENS_MODE: 'off', NEXT_PUBLIC_ENS_REGISTRY_ADDRESS: REG })).toBeNull()
  })

  it('ignores every other ENS value while ENS is off, even a malformed one', () => {
    expect(browserEns({ NEXT_PUBLIC_ENS_MODE: 'off', NEXT_PUBLIC_ENS_CHILD_REGISTRY: '0x123' })).toBeNull()
    expect(browserEns({ NEXT_PUBLIC_ENS_CHILD_REGISTRY: '0x123' })).toBeNull()
    expect(browserAdmit({ NEXT_PUBLIC_ENS_MODE: 'off', NEXT_PUBLIC_ENS_RPC: 'not a url' })).toBeUndefined()
  })

  it('reads only NEXT_PUBLIC_ENS_ names', () => {
    expect(browserEns({ ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: REG, ENS_UNIVERSAL_RESOLVER: UR })).toBeNull()
    const config = browserEns({
      NEXT_PUBLIC_ENS_MODE: 'display',
      NEXT_PUBLIC_ENS_REGISTRY_ADDRESS: REG,
      NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER: UR,
    })
    expect(config).toMatchObject({ mode: 'display', chainId: 11155111, parentName: 'dusk.eth' })
  })

  it('names the NEXT_PUBLIC_ variable when a value is wrong', () => {
    expect(() => browserEns({ NEXT_PUBLIC_ENS_MODE: 'display', NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER: UR })).toThrow(/NEXT_PUBLIC_ENS_REGISTRY_ADDRESS/)
  })

  it('refuses a key-shaped value without repeating it', () => {
    let message = ''
    try { browserEns({ NEXT_PUBLIC_ENS_MODE: 'display', NEXT_PUBLIC_ENS_RPC: 'https://x.example/sk-abc123' }) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/NEXT_PUBLIC_ENS_RPC/)
    expect(message).not.toMatch(/sk-abc123/)
  })
})

const identity = (status: VerifiedIdentity['status'], name?: string): VerifiedIdentity => ({
  wallet, chainId: 11155111, registry: REG, status, checkedAt: 0, ...(name ? { name } : {}),
})

describe('walletLabel', () => {
  it('shows the short address until a name verifies', () => {
    expect(walletLabel(wallet)).toEqual({ text: '0x1111…1111', title: wallet, verified: false })
    for (const status of ['unknown', 'unnamed', 'expired', 'revoked', 'banned'] as const) {
      expect(walletLabel(wallet, identity(status, 'alice.dusk.eth')).text).toBe('0x1111…1111')
    }
  })

  it('shows the name only when it is active, and keeps the address reachable', () => {
    expect(walletLabel(wallet, identity('active', 'alice.dusk.eth'))).toEqual({
      text: 'alice.dusk.eth', title: `alice.dusk.eth · ${wallet}`, verified: true,
    })
  })

  it('flags a mismatch instead of displaying the claimed name', () => {
    const label = walletLabel(wallet, identity('mismatch', 'alice.dusk.eth'))
    expect(label.text).toBe('0x1111…1111')
    expect(label.verified).toBe(false)
    expect(label.note).toMatch(/does not resolve/i)
  })

  it('never displays an identity read for a different wallet', () => {
    const other = { ...identity('active', 'bob.dusk.eth'), wallet: '0x2222222222222222222222222222222222222222' as const }
    expect(walletLabel(wallet, other).text).toBe('0x1111…1111')
  })
})

describe('browser admission', () => {
  const config = loadConfig({ OG_BASE_URL: 'https://router-api.0g.ai' })
  const admit = async () => ({ allowed: false })

  it('wires no gate with ENS off', () => {
    expect(browserAdmit({})).toBeUndefined()
    expect('admit' in buildBrowserBuyer({ config, signingKey: generatePrivateKey() })).toBe(false)
  })

  it('requires a verified name when ENS is on but namespace setup is incomplete', async () => {
    const admit = browserAdmit({ NEXT_PUBLIC_ENS_MODE: 'application-enforced', NEXT_PUBLIC_ENS_REGISTRY_ADDRESS: REG, NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER: UR })!
    expect(await admit('new-job', wallet)).toMatchObject({ allowed: false })
    expect(await admit('new-claim', wallet)).toMatchObject({ allowed: false })
    expect(await admit('refund', wallet)).toEqual({ allowed: true })
    expect(await admit('settle-existing', wallet)).toEqual({ allowed: true })
  })

  it('exists once ENS is switched on', () => {
    expect(typeof browserAdmit({ NEXT_PUBLIC_ENS_MODE: 'application-enforced', NEXT_PUBLIC_ENS_REGISTRY_ADDRESS: REG, NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER: UR, NEXT_PUBLIC_ENS_CONTROLLER_ADDRESS: '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' })).toBe('function')
  })

  it('reaches both the /buy deps and the /earn worker deps', () => {
    expect(buildBrowserBuyer({ config, signingKey: generatePrivateKey(), admit }).admit).toBe(admit)
    const worker = buildBrowserWorker({ config, inferKey: 'sk-test-0123456789abcdef', workerKey: generatePrivateKey(), pricePer1kOut: 1n, models: ['m'], admit })
    expect(worker.admit).toBe(admit)
  })
})
