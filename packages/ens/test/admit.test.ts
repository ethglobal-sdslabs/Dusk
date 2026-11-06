import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { admitFromEnv, createAdmit, loadEnsConfig, type VerifiedIdentity } from '../src'

const REG = '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4' as const
const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const
const CTRL = '0x5555555555555555555555555555555555555555' as const
const wallet = '0x1111111111111111111111111111111111111111' as Address
const reader = (status: VerifiedIdentity['status'], checkedAt = 1_000) => ({
  identityOf: async (w: Address): Promise<VerifiedIdentity> => ({ wallet: w, chainId: 11155111, registry: REG, status, checkedAt }),
})
const cfg = (mode: string) => loadEnsConfig({
  ENS_MODE: mode, ENS_REGISTRY_ADDRESS: REG, ENS_UNIVERSAL_RESOLVER: UR, ENS_CONTROLLER_ADDRESS: CTRL,
})

describe('createAdmit', () => {
  it('is null with ENS off, so nothing is wired and nothing changes', () => {
    expect(createAdmit(loadEnsConfig({}), reader('active'))).toBeNull()
  })

  it('display mode refuses only an explicit ban', async () => {
    const admit = createAdmit(cfg('display'), reader('banned'), () => 1_000)!
    expect((await admit('new-claim', wallet)).allowed).toBe(false)
    expect((await createAdmit(cfg('display'), reader('unnamed'), () => 1_000)!('new-claim', wallet)).allowed).toBe(true)
    expect((await createAdmit(cfg('display'), reader('unknown'), () => 1_000)!('new-claim', wallet)).allowed).toBe(true)
  })

  it('application-enforced mode needs an active name and fails closed on unknown', async () => {
    expect((await createAdmit(cfg('application-enforced'), reader('active'), () => 1_000)!('new-job', wallet)).allowed).toBe(true)
    for (const status of ['unnamed', 'unknown', 'mismatch', 'expired', 'banned'] as const) {
      expect((await createAdmit(cfg('application-enforced'), reader(status), () => 1_000)!('new-job', wallet)).allowed).toBe(false)
    }
  })

  it('marks a refusal that rests on an unknown read as retryable, and only that one', async () => {
    const unknown = await createAdmit(cfg('application-enforced'), reader('unknown'), () => 1_000)!('new-claim', wallet)
    expect(unknown).toMatchObject({ allowed: false, retryable: true })
    for (const status of ['unnamed', 'banned', 'revoked'] as const) {
      const verdict = await createAdmit(cfg('application-enforced'), reader(status), () => 1_000)!('new-claim', wallet)
      expect(verdict.allowed).toBe(false)
      expect(verdict.retryable).toBeUndefined()
    }
  })

  it('a ban never blocks a refund or a settlement', async () => {
    const admit = createAdmit(cfg('application-enforced'), reader('banned'), () => 1_000)!
    expect((await admit('refund', wallet)).allowed).toBe(true)
    expect((await admit('settle-existing', wallet)).allowed).toBe(true)
  })

  it('remembers a verdict per action and wallet for 15 s, but not a failed read', async () => {
    let t = 1_000
    let reads = 0
    let fail = false
    const counting = { identityOf: async (w: Address): Promise<VerifiedIdentity> => {
      reads++
      if (fail) throw new Error('down')
      return { wallet: w, chainId: 11155111, registry: REG, status: 'active', checkedAt: t }
    } }
    const admit = createAdmit(cfg('application-enforced'), counting, () => t)!
    await admit('new-claim', wallet); await admit('new-claim', wallet)
    expect(reads).toBe(1)
    await admit('new-job', wallet)
    expect(reads).toBe(2)
    t += 15_000
    await admit('new-claim', wallet)
    expect(reads).toBe(3)
    fail = true
    t += 15_000
    await expect(admit('new-claim', wallet)).rejects.toThrow()
    await expect(admit('new-claim', wallet)).rejects.toThrow()
    expect(reads).toBe(5)
  })

  it('remembers a refusal resting on an unknown read for only 5 s', async () => {
    let t = 1_000
    let status: VerifiedIdentity['status'] = 'unknown'
    let reads = 0
    const flaky = { identityOf: async (w: Address): Promise<VerifiedIdentity> => { reads++; return { wallet: w, chainId: 11155111, registry: REG, status, checkedAt: t } } }
    const admit = createAdmit(cfg('application-enforced'), flaky, () => t, async () => {})!
    expect((await admit('new-grant', wallet)).allowed).toBe(false)
    expect(reads).toBe(3)
    t += 4_000
    expect((await admit('new-grant', wallet)).allowed).toBe(false)
    expect(reads).toBe(3)
    status = 'active'
    t += 1_000
    expect((await admit('new-grant', wallet)).allowed).toBe(true)
    expect(reads).toBe(4)
  })

  it('admits when an unknown read recovers on retry', async () => {
    let reads = 0
    const flaky = { identityOf: async (w: Address): Promise<VerifiedIdentity> => ({ wallet: w, chainId: 11155111, registry: REG, status: ++reads === 1 ? 'unknown' : 'active', name: 'a.dusk.eth', checkedAt: 1_000 }) }
    const admit = createAdmit(cfg('application-enforced'), flaky, () => 1_000, async () => {})!
    expect((await admit('new-job', wallet)).allowed).toBe(true)
    expect(reads).toBe(2)
  })

  it('ENS off (or unset) wires no gate at all, and reads nothing', () => {
    expect(admitFromEnv({ ENS_CHILD_REGISTRY: '0x123' }, () => { throw new Error('must not read') })).toBeUndefined()
    expect(admitFromEnv({ ENS_MODE: 'off', ENS_RPC: 'nope' }, () => { throw new Error('must not read') })).toBeUndefined()
  })

  it('an enabled but incomplete setup blocks new work without throwing or blocking recovery', async () => {
    const unavailable = admitFromEnv({ ENS_MODE: 'display' }, () => { throw new Error('must not read') })!
    expect(await unavailable('new-claim', wallet)).toMatchObject({ allowed: false })
    expect(await unavailable('refund', wallet)).toEqual({ allowed: true })
    expect(await unavailable('settle-existing', wallet)).toEqual({ allowed: true })
    expect(typeof admitFromEnv({ ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: REG, ENS_UNIVERSAL_RESOLVER: UR }, () => reader('active'))).toBe('function')
  })

  it('never extends a positive snapshot age by the time spent reading it', async () => {
    let time = 1000
    let reads = 0
    const slow = { identityOf: async (): Promise<VerifiedIdentity> => { reads++; const checkedAt = time; time += 8000; return { wallet, chainId: 11155111, registry: REG, status: 'active', checkedAt } } }
    const admit = createAdmit(cfg('application-enforced'), slow, () => time)!
    expect((await admit('new-job', wallet)).allowed).toBe(true)
    time = 16000
    await admit('new-job', wallet)
    expect(reads).toBe(2)
  })
})
