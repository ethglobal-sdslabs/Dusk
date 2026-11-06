import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, getAbiItem, keccak256, namehash, toHex, type Address, type Hex, type Log } from 'viem'
import type { ReputationMirror } from '@dusk/core'
import { encode, decode, type SchemaRow, attributeTypesFor } from '../../arkiv/src/codec'
import { DuskReputationAbi } from '../src/reputation-abi'
import { createPublishedReputationReader, reputationMirrorsFromLogs, verifyReputationMirror, type ReputationChainClient } from '../src/reputation-mirror'
import type { EnsConfig } from '../src/config'

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const hash = (s: string) => keccak256(toHex(s))
const wallet = address(1), controller = address(2), reputation = address(3), registry = address(4)
const config: EnsConfig = { mode: 'display', chainId: 11155111, parentName: 'dusk.eth', rpc: 'https://rpc.example', controller, reputation, childRegistry: registry }
const record = {
  score: 90, standing: 2, policyVersion: 1, policyEpoch: 3, generation: 1n, sequence: 5n,
  evaluatedAt: 1000n, publishedAtBlock: 100n, galileoBlock: 80n, arkivBlock: 90n,
  resolvedJobs: 3, badAnswers: 1, illegal: 0, evidenceHash: hash('evidence'), namehash: namehash('alice.dusk.eth'),
  sourceContextHash: hash('sources'), evidenceRef: hash('swarm'),
}
const publication = getAbiItem({ abi: DuskReputationAbi, name: 'ReputationPublished' })
function log(): Log {
  return { address: reputation, blockNumber: 100n, blockHash: hash('block'), transactionHash: hash('transaction'),
    transactionIndex: 0, logIndex: 7, removed: false,
    topics: encodeEventTopics({ abi: DuskReputationAbi, eventName: 'ReputationPublished', args: { wallet, namehash: record.namehash, generation: 1n } }),
    data: encodeAbiParameters(publication.inputs.filter((p) => !p.indexed), ['alice', record]),
  } as Log
}
function row(): ReputationMirror { return { id: 'mirror', ...reputationMirrorsFromLogs(config, registry, [log()])[0]! } }
function world() {
  const state = { finalized: 100n, canonical: hash('block'), epoch: 3, sequence: 5n, chainId: 11155111, fail: false }
  const client = {
    getChainId: async () => state.chainId,
    getBlock: async () => ({ number: state.finalized, hash: state.canonical }),
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 100n, blockHash: hash('block'), logs: [log()] }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (state.fail) throw new Error('RPC unavailable')
      if (functionName === 'CONTROLLER') return controller
      if (functionName === 'REGISTRY') return registry
      if (functionName === 'policyEpoch') return state.epoch
      if (functionName === 'reputationOf') return { ...record, sequence: state.sequence }
      throw new Error('unexpected read')
    },
  } as unknown as ReputationChainClient
  return { state, client }
}

describe('official reputation mirrors', () => {
  it('derives a complete historical snapshot and round-trips the Arkiv schema', () => {
    const mirror = row()
    expect(mirror).toMatchObject({ wallet, controller: reputation, identityController: controller, score: 90, standing: 'trusted', sequence: 5, generation: 1, ensName: 'alice.dusk.eth', sourceBlock: 100 })
    const back = decode<ReputationMirror>('reputation_v1', { $key: hash('row'), ...encode('reputation_v1', mirror) } as SchemaRow)
    expect({ ...back, id: 'mirror' }).toEqual(mirror)
    expect(Object.keys(attributeTypesFor('reputation_v1')).length).toBeLessThanOrEqual(32)
    expect(JSON.stringify(encode('reputation_v1', mirror), (_, v: unknown) => typeof v === 'bigint' ? String(v) : v)).not.toMatch(/\b(?:sk|mk)-|privateKey/)
  })

  it('requires the exact finalized canonical publication, not a self-written Arkiv claim', async () => {
    const { state, client } = world()
    expect(await verifyReputationMirror(config, client, row(), registry)).toBe(true)
    for (const forged of [{ score: 100 }, { standing: 'good' }, { generation: 2 }, { sequence: 99 }, { badAnswers: 0 }, { resolvedJobs: 100 },
      { evidenceHash: hash('forged') }, { evidenceRef: hash('forged') }, { identityController: wallet }, { namespaceRegistry: wallet }, { controller: wallet }, { sourceBlockHash: hash('fork') }]) {
      expect(await verifyReputationMirror(config, client, { ...row(), ...forged } as ReputationMirror, registry)).toBe(false)
    }
    state.finalized = 99n
    expect(await verifyReputationMirror(config, client, row(), registry)).toBe(false)
    state.finalized = 100n; state.canonical = hash('other branch')
    expect(await verifyReputationMirror(config, client, row(), registry)).toBe(false)
    state.chainId = 1
    expect(await verifyReputationMirror(config, client, row(), registry)).toBe(false)
  })

  it('uses the current typed record and never lets a republished old or fake high sequence roll it back', async () => {
    const { client } = world()
    const reader = createPublishedReputationReader(config, client, { now: () => 1000_000 })
    expect(await reader.read(wallet, [row()])).toMatchObject({ status: 'verified', source: 'mirror', record: { score: 90, sequence: 5 } })
    expect(await reader.read(wallet, [{ ...row(), sequence: 999, score: 100 }, { ...row(), sequence: 4, score: 100 }])).toMatchObject({ status: 'verified', source: 'chain', record: { score: 90, sequence: 5 } })
    expect(await reader.read(wallet, [{ ...row(), score: 100 }])).toMatchObject({ status: 'verified', source: 'chain', record: { score: 90 } })
  })

  it('distinguishes missing, stale, changed-policy and unavailable checkpoints', async () => {
    const { state, client } = world()
    state.sequence = 0n
    expect(await createPublishedReputationReader(config, client).read(wallet)).toEqual({ status: 'missing' })
    state.sequence = 5n
    expect((await createPublishedReputationReader(config, client, { now: () => 1000_000 + 6 * 3600_000 }).read(wallet)).status).toBe('stale')
    state.epoch = 4
    expect((await createPublishedReputationReader(config, client, { now: () => 1000_000 }).read(wallet)).status).toBe('stale')
    state.fail = true
    expect(await createPublishedReputationReader(config, client).read(wallet)).toEqual({ status: 'unknown' })
  })
})
