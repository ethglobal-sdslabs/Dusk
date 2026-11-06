import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, keccak256, namehash, toHex, type Address, type Hex, type Log } from 'viem'
import type { IdentityMirror, ModerationMirror } from '@dusk/core'
import {
  DuskIdentityControllerAbi, banStateFrom, loadEnsConfig, mirrorsFromLogs, verifyIdentityMirror, verifyModerationMirror,
  type MirrorChainClient,
} from '../src'

const CONTROLLER = '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' as Address
const CHILD = '0xe3674be612B1F08eF2cF40Ae8139B57A12efeaC5' as Address
const alice = '0xe5489A08eF6A0f212D13B720799f255B55A8B4aB' as Address
const resolver = '0x3B5960b848B96878db93162B3783ebA9CAE23bc6' as Address
const config = loadEnsConfig({
  ENS_MODE: 'display', ENS_REGISTRY_ADDRESS: '0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4',
  ENS_UNIVERSAL_RESOLVER: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe', ENS_CONTROLLER_ADDRESS: CONTROLLER, ENS_CHILD_REGISTRY: CHILD,
})

const TX1 = `0x${'01'.repeat(32)}` as Hex
const TX2 = `0x${'02'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'bb'.repeat(32)}` as Hex

function registeredLog(over: { address?: Address; wallet?: Address; label?: string; generation?: bigint; tx?: Hex; logIndex?: number } = {}): Log {
  const label = over.label ?? 'ashura'
  return {
    address: over.address ?? CONTROLLER,
    topics: encodeEventTopics({ abi: DuskIdentityControllerAbi, eventName: 'Registered', args: { wallet: over.wallet ?? alice, labelhash: keccak256(toHex(label)) } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'string' }, { type: 'uint64' }, { type: 'address' }, { type: 'uint64' }], [label, over.generation ?? 1n, resolver, 1_801_357_728n]),
    blockNumber: 100n, blockHash: BLOCK_HASH, transactionHash: over.tx ?? TX1, logIndex: over.logIndex ?? 3, transactionIndex: 0, removed: false,
  } as Log
}

function decisionLog(over: { sequence?: bigint; action?: number; tx?: Hex; logIndex?: number; wallet?: Address } = {}): Log {
  return {
    address: CONTROLLER,
    topics: encodeEventTopics({ abi: DuskIdentityControllerAbi, eventName: 'ModerationDecision', args: {
      wallet: over.wallet ?? alice, decisionId: keccak256(toHex(`d${over.sequence ?? 1n}`)), sequence: over.sequence ?? 1n,
    } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint16' }, { type: 'bytes32' }, { type: 'uint32' }], [over.action ?? 1, 3, `0x${'77'.repeat(32)}`, 1]),
    blockNumber: 101n, blockHash: BLOCK_HASH, transactionHash: over.tx ?? TX2, logIndex: over.logIndex ?? 1, transactionIndex: 0, removed: false,
  } as Log
}

function chainWith(receipts: Record<Hex, Log[]>, status: 'success' | 'reverted' = 'success'): MirrorChainClient {
  return {
    getTransactionReceipt: async ({ hash }) => {
      const logs = receipts[hash]
      if (!logs) throw new Error('not found https://rpc.example/secret')
      return { status, blockNumber: logs[0]!.blockNumber!, blockHash: logs[0]!.blockHash!, logs }
    },
  }
}

describe('mirrorsFromLogs', () => {
  it('turns Registered and ModerationDecision logs into mirror rows', () => {
    const { identities, moderations } = mirrorsFromLogs(config, CHILD, [registeredLog(), decisionLog()])
    expect(identities).toEqual([{
      wallet: alice, ensChainId: 11155111, controller: CONTROLLER, namespaceRegistry: CHILD, ensName: 'ashura.dusk.eth',
      ensNamehash: namehash('ashura.dusk.eth'), generation: 1, resolver, sourceTx: TX1, sourceBlock: 100, sourceLogIndex: 3, schemaVersion: 1,
    }])
    expect(moderations[0]).toMatchObject({ subjectWallet: alice, sequence: 1, action: 'ban', reasonCode: 3, sourceBlockHash: BLOCK_HASH, sourceLogIndex: 1 })
  })

  it('ignores logs from any address but the configured controller', () => {
    const { identities } = mirrorsFromLogs(config, CHILD, [registeredLog({ address: '0x000000000000000000000000000000000000dEaD' })])
    expect(identities).toHaveLength(0)
  })
})

describe('verifyIdentityMirror — a row is a candidate until the chain agrees', () => {
  const [row] = mirrorsFromLogs(config, CHILD, [registeredLog()]).identities
  const mirror = { ...row!, id: 'x' } as IdentityMirror

  it('accepts a row whose exact log is in its transaction', async () => {
    expect(await verifyIdentityMirror(config, chainWith({ [TX1]: [registeredLog()] }), mirror, CHILD)).toBe(true)
  })

  it.each([
    ['a forged name', { ensName: 'admin.dusk.eth' }],
    ['a forged wallet', { wallet: '0x000000000000000000000000000000000000bEEF' }],
    ['a forged generation', { generation: 9 }],
    ['a forged resolver', { resolver: '0x000000000000000000000000000000000000bEEF' }],
    ['the wrong log index', { sourceLogIndex: 4 }],
    ['the wrong block', { sourceBlock: 99 }],
    ['a foreign controller', { controller: '0x000000000000000000000000000000000000bEEF' }],
  ] as const)('rejects %s', async (_, over) => {
    expect(await verifyIdentityMirror(config, chainWith({ [TX1]: [registeredLog()] }), { ...mirror, ...over } as IdentityMirror, CHILD)).toBe(false)
  })

  it('rejects a real event republished under a different namespace registry', async () => {
    const chain = chainWith({ [TX1]: [registeredLog()] })
    const foreign = '0x000000000000000000000000000000000000bEEF' as Address
    expect(await verifyIdentityMirror(config, chain, { ...mirror, namespaceRegistry: foreign }, CHILD)).toBe(false)
  })

  it('rejects a row whose transaction does not exist, or reverted', async () => {
    expect(await verifyIdentityMirror(config, chainWith({}), mirror, CHILD)).toBe(false)
    expect(await verifyIdentityMirror(config, chainWith({ [TX1]: [registeredLog()] }, 'reverted'), mirror, CHILD)).toBe(false)
  })

  it('rejects a log emitted by a different contract at the same index', async () => {
    const impostor = registeredLog({ address: '0x000000000000000000000000000000000000dEaD' })
    expect(await verifyIdentityMirror(config, chainWith({ [TX1]: [impostor] }), mirror, CHILD)).toBe(false)
  })
})

describe('verifyModerationMirror and banStateFrom', () => {
  const rows = (logs: Log[]) => mirrorsFromLogs(config, CHILD, logs).moderations.map((m, i) => ({ ...m, id: `m${i}` }) as ModerationMirror)

  it('accepts the real decision and rejects a flipped action', async () => {
    const [m] = rows([decisionLog()])
    const chain = chainWith({ [TX2]: [decisionLog()] })
    expect(await verifyModerationMirror(config, chain, m!, CHILD)).toBe(true)
    expect(await verifyModerationMirror(config, chain, { ...m!, action: 'unban' }, CHILD)).toBe(false)
    expect(await verifyModerationMirror(config, chain, { ...m!, sourceBlockHash: `0x${'cc'.repeat(32)}` }, CHILD)).toBe(false)
    expect(await verifyModerationMirror(config, chain, { ...m!, namespaceRegistry: '0x000000000000000000000000000000000000bEEF' }, CHILD)).toBe(false)
  })

  it('the highest sequence wins, whatever order the rows arrive in', () => {
    const ban = rows([decisionLog({ sequence: 1n, action: 1 })])[0]!
    const unban = rows([decisionLog({ sequence: 2n, action: 2, tx: `0x${'03'.repeat(32)}` })])[0]!
    expect(banStateFrom([unban, ban]).get(alice.toLowerCase())).toMatchObject({ banned: false, sequence: 2 })
    expect(banStateFrom([ban, unban, ban]).get(alice.toLowerCase())).toMatchObject({ banned: false, sequence: 2 })
  })
})
