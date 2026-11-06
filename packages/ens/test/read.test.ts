import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { createEnsReader, loadEnsConfig, sanitizeProfileText, type EnsChainClient } from '../src'

const ETH_REGISTRY = '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4' as const
const CHILD = '0x3333333333333333333333333333333333333333' as const
const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' as const
const alice = '0x1111111111111111111111111111111111111111' as const
const bob = '0x2222222222222222222222222222222222222222' as const
const NOW = 1_800_000_000n
const ZERO = '0x0000000000000000000000000000000000000000' as const

const config = loadEnsConfig({
  ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: ETH_REGISTRY, ENS_UNIVERSAL_RESOLVER: UR,
  ENS_RPC: 'https://rpc.example/secret-path',
})

type Entry = { status: number; expiry: bigint; owner: Address; version?: number }
type World = {
  chainId?: number
  parent?: Entry
  child?: Address
  names?: Record<string, Entry>
  addr?: Record<string, Address | null>
  reverse?: Record<string, string | null>
  text?: Record<string, string | null>
  fail?: string
  members?: Record<string, { label: string; generation: bigint; status: number }>
  bans?: Record<string, boolean>
  controllerRegistry?: Address
  issued?: Record<string, Address>
  deployed?: Record<string, bigint>
  prunedBefore?: bigint
}
const CONTROLLER = '0x5555555555555555555555555555555555555555' as const

const id = (label: string) => BigInt(keccak256(toHex(label)))
const state = (e: Entry | undefined, label: string) => {
  const version = BigInt(e?.version ?? 0)
  return {
    status: e?.status ?? 0, expiry: e?.expiry ?? 0n, latestOwner: e?.owner ?? ZERO,
    tokenId: id(label), resource: (id(label) ^ (id(label) & 0xffffffffn)) | version,
  }
}

function chain(w: World): EnsChainClient & { calls: string[] } {
  const calls: string[] = []
  const guard = (what: string) => { calls.push(what); if (w.fail === what) throw new Error('fetch failed https://rpc.example/secret-path') }
  const label = (anyId: bigint, names: Record<string, Entry>) =>
    Object.keys(names).find((l) => id(l) === anyId) ?? ''
  return {
    calls,
    getChainId: async () => { guard('getChainId'); return w.chainId ?? 11155111 },
    getBlock: async () => { guard('getBlock'); return { number: 100n, hash: '0xabc', timestamp: NOW } },
    readContract: (async ({ address, functionName, args }: { address: Address; functionName: string; args: readonly unknown[] }) => {
      guard(functionName)
      if (address.toLowerCase() === ETH_REGISTRY.toLowerCase()) {
        if (functionName === 'getSubregistry') return args[0] === 'dusk' ? (w.child ?? ZERO) : ZERO
        if (functionName === 'getState') return state(args[0] === id('dusk') ? w.parent : undefined, 'dusk')
      }
      if (address.toLowerCase() === CONTROLLER.toLowerCase()) {
        const who = String(args?.[0] ?? '').toLowerCase()
        if (functionName === 'REGISTRY') return w.controllerRegistry ?? CHILD
        if (functionName === 'banOf') return [w.bans?.[who] ?? false, 1n, 7, `0x${'00'.repeat(32)}`]
        if (functionName === 'membershipOf') {
          const m = w.members?.[who]
          return m ? [m.label, m.generation, ZERO, NOW + 100n, m.status] : ['', 0n, ZERO, 0n, 0]
        }
      }
      if (w.child && address.toLowerCase() === w.child.toLowerCase() && functionName === 'getState') {
        const names = w.names ?? {}
        const l = label(args[0] as bigint, names)
        return state(names[l], l || 'x')
      }
      throw new Error(`unexpected ${functionName} on ${address}`)
    }) as EnsChainClient['readContract'],
    getEnsAddress: async ({ name }) => { guard('getEnsAddress'); return w.addr?.[name] ?? null },
    getEnsName: async ({ address }) => { guard('getEnsName'); return w.reverse?.[address.toLowerCase()] ?? null },
    getEnsText: async ({ name, key }) => { guard('getEnsText'); return w.text?.[`${name}:${key}`] ?? null },
    getCode: async ({ address, blockNumber }) => {
      guard('getCode')
      if (w.prunedBefore !== undefined && blockNumber < w.prunedBefore) {
        throw Object.assign(new Error('RPC Request failed'), { details: 'pruned history unavailable: requested 1, earliest available 2' })
      }
      const deploy = w.deployed?.[address.toLowerCase()]
      return deploy !== undefined && blockNumber >= deploy ? '0x60006000' : '0x'
    },
    getLogs: (async (args: { address: Address; event?: { name?: string } }) => {
      guard('getLogs')
      const { address, event } = args
      if (event?.name !== 'LabelRegistered' || !w.child || address.toLowerCase() !== w.child.toLowerCase()) return []
      const names = w.names ?? {}
      return Object.entries(names).map(([label, entry], i) => ({
        address: w.child!,
        blockNumber: 100n,
        blockHash: null,
        transactionHash: `0x${String(i + 1).padStart(64, '0')}` as Hex,
        transactionIndex: null,
        logIndex: i,
        removed: false,
        data: '0x',
        topics: [],
        args: { label, owner: w.issued?.[label] ?? entry.owner, expiry: entry.expiry },
      }))
    }) as unknown as EnsChainClient['getLogs'],
  }
}

const parent: Entry = { status: 2, expiry: NOW + 1000n, owner: '0x1DCbDe884e9fb92E0f73034eF994080eDc3b6068' }
const live = (owner: Address, version = 0): Entry => ({ status: 2, expiry: NOW + 100n, owner, version })
const base: World = {
  parent, child: CHILD,
  names: { alice: live(alice, 3) },
  addr: { 'alice.dusk.eth': alice },
  reverse: { [alice.toLowerCase()]: 'alice.dusk.eth' },
  deployed: { [CHILD.toLowerCase()]: 50n },
}

const read = (w: World, wallet: Address = alice, candidate?: string) =>
  createEnsReader(config, chain(w), { now: () => 5_000 }).identityOf(wallet, candidate === undefined ? {} : { candidate })

describe('identityOf — a name is active only when every independent check agrees', () => {
  it('verifies ownership, forward resolution and the namespace pointer', async () => {
    const s = await read(base)
    expect(s).toMatchObject({
      status: 'active', name: 'alice.dusk.eth', wallet: alice, chainId: 11155111,
      registry: ETH_REGISTRY, subregistry: CHILD, checkedAt: 5_000, blockNumber: 100n,
    })
  })

  it('takes a caller-supplied candidate instead of the reverse record', async () => {
    const s = await read({ ...base, reverse: {} }, alice, 'Alice')
    expect(s.status).toBe('active')
    expect(s.name).toBe('alice.dusk.eth')
  })

  it('a reverse record pointing at somebody else\'s name is not that name', async () => {
    const s = await read({ ...base, reverse: { [bob.toLowerCase()]: 'alice.dusk.eth' } }, bob)
    expect(s.status).toBe('unnamed')
    expect(s.name).toBeUndefined()
  })

  it('an address record alone proves nothing: an owner-mismatched name is unnamed for the stranger', async () => {
    const s = await read({ ...base, addr: { 'alice.dusk.eth': bob } }, bob, 'alice')
    expect(s.status).toBe('unnamed')
  })

  it('the owner whose address record points elsewhere is a mismatch, not active', async () => {
    const s = await read({ ...base, addr: { 'alice.dusk.eth': bob } })
    expect(s.status).toBe('mismatch')
    expect(s.name).toBe('alice.dusk.eth')
  })

  it('an expired registration reads as expired, never active', async () => {
    const s = await read({ ...base, names: { alice: { status: 0, expiry: NOW - 1n, owner: alice } } })
    expect(s.status).toBe('expired')
  })

  it('a wildcard address for an unregistered label is not membership', async () => {
    const s = await read({ ...base, names: {}, addr: { 'ghost.dusk.eth': alice } }, alice, 'ghost')
    expect(s.status).toBe('unnamed')
  })

  it.each([
    ['outside the namespace', 'alice.evil.eth'],
    ['a nested name', 'a.alice.dusk.eth'],
    ['the parent itself', 'dusk.eth'],
    ['a lookalike', 'аlice.dusk.eth'],
  ])('ignores a reverse record %s', async (_, name) => {
    const s = await read({ ...base, names: {}, reverse: { [alice.toLowerCase()]: name } })
    expect(s.status).toBe('unnamed')
  })

  it('no child registry means nobody can hold a name yet — unnamed, not unknown', async () => {
    const s = await read({ ...base, child: undefined })
    expect(s.status).toBe('unnamed')
    expect(s.subregistry).toBeUndefined()
  })
})

describe('identityOf — with a DuskIdentityController', () => {
  const withController = loadEnsConfig({
    ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: ETH_REGISTRY, ENS_UNIVERSAL_RESOLVER: UR, ENS_CONTROLLER_ADDRESS: CONTROLLER,
  })
  const member = { [alice.toLowerCase()]: { label: 'alice', generation: 4n, status: 1 } }
  const readC = (w: World, wallet: Address = alice) => createEnsReader(withController, chain(w), { now: () => 5_000 }).identityOf(wallet)

  it('finds the name from the controller, with no reverse record, and takes its generation', async () => {
    const s = await readC({ ...base, reverse: {}, members: member })
    expect(s).toMatchObject({ status: 'active', name: 'alice.dusk.eth', generation: 4n })
  })

  it('a banned wallet reads banned, whatever the registry says', async () => {
    expect((await readC({ ...base, members: member, bans: { [alice.toLowerCase()]: true } })).status).toBe('banned')
  })

  it('a ban outlives the name: revoked and unregistered still reads banned', async () => {
    const s = await readC({ ...base, names: {}, members: { [alice.toLowerCase()]: { label: 'alice', generation: 1n, status: 3 } }, bans: { [alice.toLowerCase()]: true } })
    expect(s.status).toBe('banned')
  })

  it('a registry-issued name verifies even without controller membership', async () => {
    const s = await readC({ ...base, reverse: {}, members: {} })
    expect(s).toMatchObject({ status: 'active', name: 'alice.dusk.eth' })
  })

  it('no membership and nothing in the registry is unnamed', async () => {
    expect((await readC({ ...base, names: {}, members: {} })).status).toBe('unnamed')
  })

  it('a registry name that moved to another owner is not that name', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, issued: { alice: alice }, names: { alice: live(bob) } })
    expect(s.status).toBe('unnamed')
  })

  it('a registry name whose forward resolution points elsewhere does not verify', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, addr: { 'alice.dusk.eth': bob } })
    expect(s.status).toBe('unnamed')
  })

  it('an expired registry name does not verify', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, names: { alice: { status: 0, expiry: NOW - 1n, owner: alice } } })
    expect(s.status).toBe('unnamed')
  })

  it('finds the registry scan floor by code presence when no deploy block is configured', async () => {
    const s = await readC({ ...base, reverse: {}, members: {} })
    expect(s.status).toBe('active')
  })

  it('a configured deploy block skips the code-presence discovery', async () => {
    const pinned = loadEnsConfig({
      ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: ETH_REGISTRY, ENS_UNIVERSAL_RESOLVER: UR, ENS_CONTROLLER_ADDRESS: CONTROLLER,
      ENS_CHILD_REGISTRY_DEPLOY_BLOCK: '50',
    })
    const c = chain({ ...base, reverse: {}, members: {} })
    const s = await createEnsReader(pinned, c, { now: () => 5_000 }).identityOf(alice)
    expect(s.status).toBe('active')
    expect(c.calls).not.toContain('getCode')
  })

  it('a registry with no deployed code has nothing to scan — unnamed, not unknown', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, deployed: {} })
    expect(s.status).toBe('unnamed')
  })

  it('treats a pruned getCode as absent and still finds the name', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, prunedBefore: 60n })
    expect(s.status).toBe('active')
  })

  it('an RPC failure in getCode is unknown and the reason never repeats the RPC URL', async () => {
    const s = await readC({ ...base, reverse: {}, members: {}, fail: 'getCode' })
    expect(s.status).toBe('unknown')
    expect(JSON.stringify(s, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/rpc\.example|secret/)
  })

  it('still checks the registry and forward resolution behind the controller', async () => {
    expect((await readC({ ...base, members: member, addr: { 'alice.dusk.eth': bob } })).status).toBe('mismatch')
    expect((await readC({ ...base, members: member, names: { alice: live(bob) } })).status).toBe('unnamed')
  })

  it('a controller issuing into some other registry is unknown', async () => {
    const s = await readC({ ...base, members: member, controllerRegistry: '0x6666666666666666666666666666666666666666' })
    expect(s.status).toBe('unknown')
  })
})

describe('identityOf — failure is unknown, never allowed', () => {
  it('a wrong-chain RPC is unknown and reads nothing else', async () => {
    const c = chain({ ...base, chainId: 1 })
    const s = await createEnsReader(config, c, { now: () => 5_000 }).identityOf(alice)
    expect(s.status).toBe('unknown')
    expect(s.reason).toMatch(/chain/i)
    expect(c.calls).toEqual(['getChainId'])
  })

  it('an expired parent namespace is unknown', async () => {
    expect((await read({ ...base, parent: { ...parent, expiry: NOW } })).status).toBe('unknown')
  })

  it('a subregistry pointer that moved away from the pinned one is unknown', async () => {
    const pinned = loadEnsConfig({
      ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: ETH_REGISTRY, ENS_UNIVERSAL_RESOLVER: UR,
      ENS_CHILD_REGISTRY: '0x4444444444444444444444444444444444444444',
    })
    const s = await createEnsReader(pinned, chain(base), { now: () => 5_000 }).identityOf(alice)
    expect(s.status).toBe('unknown')
    expect(s.reason).toMatch(/subregistry/i)
  })

  it.each(['getBlock', 'getSubregistry', 'getState', 'getEnsAddress', 'getEnsName'])(
    'an RPC failure in %s is unknown and the reason never repeats the RPC URL',
    async (fail) => {
      const s = await read({ ...base, fail })
      expect(s.status).toBe('unknown')
      expect(JSON.stringify(s, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/rpc\.example|secret/)
    },
  )

  it('an RPC failure in getLogs is unknown and the reason never repeats the RPC URL', async () => {
    const s = await read({ ...base, names: {}, reverse: {}, fail: 'getLogs' })
    expect(s.status).toBe('unknown')
    expect(JSON.stringify(s, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/rpc\.example|secret/)
  })

  it('refuses a malformed wallet rather than reading for it', async () => {
    const s = await read(base, '0xnot' as Address)
    expect(s.status).toBe('unknown')
  })
})

describe('profileOf', () => {
  it('returns only sanitized text for a verified name', async () => {
    const reader = createEnsReader(config, chain({
      ...base,
      text: {
        'alice.dusk.eth:description': 'GPU‮ holder\u0000 <b>hi</b>',
        'alice.dusk.eth:url': 'javascript:alert(1)',
      },
    }), { now: () => 5_000 })
    const p = await reader.profileOf(await reader.identityOf(alice))
    expect(p).toEqual({ description: 'GPU holder <b>hi</b>' })
  })

  it('keeps an https url and drops anything with credentials', async () => {
    const reader = createEnsReader(config, chain({
      ...base, text: { 'alice.dusk.eth:url': 'https://alice.example/' },
    }), { now: () => 5_000 })
    expect((await reader.profileOf(await reader.identityOf(alice))).url).toBe('https://alice.example/')
    const evil = createEnsReader(config, chain({
      ...base, text: { 'alice.dusk.eth:url': 'https://u:p@alice.example/' },
    }), { now: () => 5_000 })
    expect((await evil.profileOf(await evil.identityOf(alice))).url).toBeUndefined()
  })

  it('reads nothing for an unverified identity', async () => {
    const c = chain({ ...base, addr: { 'alice.dusk.eth': bob } })
    const reader = createEnsReader(config, c, { now: () => 5_000 })
    const s = await reader.identityOf(alice)
    const before = c.calls.length
    expect(await reader.profileOf(s)).toEqual({})
    expect(c.calls.length).toBe(before)
  })

  it('bounds text by UTF-8 bytes, not string length', () => {
    expect(new TextEncoder().encode(sanitizeProfileText('é'.repeat(400), 280)).length).toBeLessThanOrEqual(280)
    expect(sanitizeProfileText('ab😀c', 5)).toBe('ab')
    expect(sanitizeProfileText('ab😀c', 6)).toBe('ab😀')
  })

  it('sanitizes a hostile 1 MB record in linear time', () => {
    const started = performance.now()
    const out = sanitizeProfileText('😀'.repeat(256 * 1024), 280)
    expect(performance.now() - started).toBeLessThan(200)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(280)
  })
})

describe('configuration for reads', () => {
  it('accepts only a two-label parent, the depth the reader actually walks', () => {
    expect(() => loadEnsConfig({ ENS_PARENT_NAME: 'team.dusk.eth' })).toThrow(/two labels/)
    expect(loadEnsConfig({ ENS_PARENT_NAME: 'dusk.eth' }).parentName).toBe('dusk.eth')
  })

  it('display mode needs the universal resolver, because forward resolution is one of the checks', () => {
    expect(() => loadEnsConfig({ ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: ETH_REGISTRY })).toThrow(/UNIVERSAL_RESOLVER/)
  })

  it('parses the child registry deploy block and refuses garbage', () => {
    const c = loadEnsConfig({ ENS_CHILD_REGISTRY_DEPLOY_BLOCK: '12076762' })
    expect(c.childRegistryFromBlock).toBe(12076762n)
    expect(() => loadEnsConfig({ ENS_CHILD_REGISTRY_DEPLOY_BLOCK: 'abc' })).toThrow(/non-negative integer/)
    expect(() => loadEnsConfig({ ENS_CHILD_REGISTRY_DEPLOY_BLOCK: '-1' })).toThrow(/non-negative integer/)
  })
})
