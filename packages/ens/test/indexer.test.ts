import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex, type Log } from 'viem'
import type { IdentityMirror, ModerationMirror } from '@dusk/core'
import { fakeArkiv } from '../../../worker/test/fakes'
import { DuskIdentityControllerAbi, indexOnce, loadEnsConfig, refreshMirrors } from '../src'

const CONTROLLER = '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' as Address
const CHILD = '0xe3674be612B1F08eF2cF40Ae8139B57A12efeaC5' as Address
const config = loadEnsConfig({
  ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4',
  ENS_UNIVERSAL_RESOLVER: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe', ENS_CONTROLLER_ADDRESS: CONTROLLER,
})

const registered = (block: bigint, label: string, wallet: Address): Log => ({
  address: CONTROLLER,
  topics: encodeEventTopics({ abi: DuskIdentityControllerAbi, eventName: 'Registered', args: { wallet, labelhash: keccak256(toHex(label)) } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: 'string' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint64' }], [label, 1n, CHILD, 1n]),
  blockNumber: block, blockHash: `0x${'bb'.repeat(32)}`, transactionHash: keccak256(toHex(`tx-${label}`)), logIndex: 0, transactionIndex: 0, removed: false,
} as Log)

const banned = (block: bigint, wallet: Address): Log => ({
  address: CONTROLLER,
  topics: encodeEventTopics({ abi: DuskIdentityControllerAbi, eventName: 'ModerationDecision', args: { wallet, decisionId: keccak256(toHex('d')), sequence: 1n } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint16' }, { type: 'bytes32' }, { type: 'uint32' }], [1, 0, `0x${'00'.repeat(32)}`, 1]),
  blockNumber: block, blockHash: `0x${'cc'.repeat(32)}`, transactionHash: keccak256(toHex('tx-ban')), logIndex: 1, transactionIndex: 0, removed: false,
} as Log)

const alice = '0x1111111111111111111111111111111111111111' as Address
const bob = '0x2222222222222222222222222222222222222222' as Address

function chain(logs: Log[], finalized: bigint) {
  const calls: Array<[bigint, bigint]> = []
  return {
    calls,
    finalizedBlock: async () => finalized,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([fromBlock, toBlock])
      return logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock)
    },
  }
}

describe('indexOnce', () => {
  const logs = [registered(10n, 'alice', alice), registered(250n, 'bob', bob), banned(260n, alice)]

  it('mirrors every controller event up to the finalized block, in bounded chunks', async () => {
    const arkiv = fakeArkiv()
    const c = chain(logs, 300n)
    const out = await indexOnce({ config, namespaceRegistry: CHILD, arkiv, chain: c, ttlSeconds: 2_592_000, chunk: 100n }, 0n)
    expect(out).toEqual({ nextBlock: 301n, written: 3, skipped: 0 })
    expect(arkiv.all<IdentityMirror>('identity_v1').map((r) => r.ensName)).toEqual(['alice.dusk.eth', 'bob.dusk.eth'])
    expect(arkiv.all<ModerationMirror>('moderation_v1')[0]).toMatchObject({ subjectWallet: alice, action: 'ban' })
    expect(c.calls).toEqual([[0n, 99n], [100n, 199n], [200n, 299n], [300n, 300n]])
    expect(arkiv.rows.every((r) => r.expiresAtMs === 1_000 + 2_592_000_000)).toBe(true)
  })

  it('is idempotent: a second pass over the same range writes nothing', async () => {
    const arkiv = fakeArkiv()
    const deps = { config, namespaceRegistry: CHILD, arkiv, chain: chain(logs, 300n), ttlSeconds: 2_592_000 }
    await indexOnce(deps, 0n)
    expect(await indexOnce(deps, 0n)).toMatchObject({ written: 0, skipped: 3 })
    expect(arkiv.rows).toHaveLength(3)
  })

  it('does not count a row someone else wrote as already mirrored', async () => {
    const arkiv = fakeArkiv()
    const deps = { config, namespaceRegistry: CHILD, arkiv, chain: chain(logs, 300n), ttlSeconds: 2_592_000 }
    await indexOnce(deps, 0n)
    const other = Object.assign(Object.create(arkiv) as typeof arkiv, { address: '0x9999999999999999999999999999999999999999' as Address })
    expect((await indexOnce({ ...deps, arkiv: other }, 0n)).written).toBe(3)
  })

  it('repairs a mirror that expired or was deleted', async () => {
    const arkiv = fakeArkiv()
    const deps = { config, namespaceRegistry: CHILD, arkiv, chain: chain(logs, 300n), ttlSeconds: 2_592_000 }
    await indexOnce(deps, 0n)
    arkiv.rows.splice(0, 1)
    expect(await indexOnce(deps, 0n)).toMatchObject({ written: 1, skipped: 2 })
  })

  it('waits when nothing new is finalized', async () => {
    const out = await indexOnce({ config, namespaceRegistry: CHILD, arkiv: fakeArkiv(), chain: chain(logs, 300n), ttlSeconds: 2 }, 301n)
    expect(out).toEqual({ nextBlock: 301n, written: 0, skipped: 0 })
  })

  it('refreshes its own rows every half-TTL, without reading any logs', async () => {
    const arkiv = fakeArkiv()
    const deps = { config, namespaceRegistry: CHILD, arkiv, chain: chain(logs, 300n), ttlSeconds: 2_592_000 }
    await indexOnce(deps, 0n)
    expect(await refreshMirrors(deps, { nowMs: 1_000_000, lastRefreshMs: 1_000_000 - 1_000 })).toBe(0)
    expect(await refreshMirrors(deps, { nowMs: 2_000_000_000, lastRefreshMs: 0 })).toBe(3)
    expect(arkiv.extensions.map((e) => e.ttlSeconds)).toEqual([2_592_000, 2_592_000, 2_592_000])
  })

  it('never extends a row another account wrote', async () => {
    const arkiv = fakeArkiv()
    const deps = { config, namespaceRegistry: CHILD, arkiv, chain: chain(logs, 300n), ttlSeconds: 2_592_000 }
    await indexOnce(deps, 0n)
    const other = Object.assign(Object.create(arkiv) as typeof arkiv, { address: '0x9999999999999999999999999999999999999999' as Address })
    expect(await refreshMirrors({ ...deps, arkiv: other }, { nowMs: 2_000_000_000, lastRefreshMs: 0 })).toBe(0)
  })
})
