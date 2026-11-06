import { describe, expect, it } from 'vitest'
import { render } from '@arkiv-network/sdk/query'
import type { IdentityMirror, ModerationMirror } from '@dusk/core'
import { attrEq, attributeTypesFor, decode, encode, kindTag, type SchemaRow } from '../src/codec'

const KEY = `0x${'ef'.repeat(32)}` as const
const INDEXER = `0x${'ab'.repeat(20)}` as const

const identity: IdentityMirror = {
  id: '',
  wallet: '0xe5489A08eF6A0f212D13B720799f255B55A8B4aB',
  ensChainId: 11155111,
  controller: '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27',
  namespaceRegistry: '0xe3674be612B1F08eF2cF40Ae8139B57A12efeaC5',
  ensName: 'ashura.dusk.eth',
  ensNamehash: `0x${'12'.repeat(32)}`,
  generation: 1,
  resolver: '0x3B5960b848B96878db93162B3783ebA9CAE23bc6',
  sourceTx: `0x${'34'.repeat(32)}`,
  sourceBlock: 12_073_900,
  sourceLogIndex: 7,
  schemaVersion: 1,
}

const moderation: ModerationMirror = {
  id: '',
  subjectWallet: '0xe5489A08eF6A0f212D13B720799f255B55A8B4aB',
  sourceChainId: 11155111,
  controller: '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27',
  namespaceRegistry: '0xe3674be612B1F08eF2cF40Ae8139B57A12efeaC5',
  sequence: 1,
  decisionId: `0x${'56'.repeat(32)}`,
  action: 'ban',
  policyVersion: 1,
  reasonCode: 3,
  evidenceHash: `0x${'78'.repeat(32)}`,
  sourceTx: `0x${'9a'.repeat(32)}`,
  sourceBlock: 12_073_950,
  sourceBlockHash: `0x${'bc'.repeat(32)}`,
  sourceLogIndex: 2,
}

const row = (kind: 'identity_v1' | 'moderation_v1', data: unknown) =>
  ({ $key: KEY, $owner: INDEXER, ...encode(kind, data) }) as SchemaRow

describe('ENS mirror kinds', () => {
  it('are versioned, namespaced tags', () => {
    expect(kindTag('identity_v1')).toBe('dusk.identity_v1')
    expect(kindTag('moderation_v1')).toBe('dusk.moderation_v1')
  })

  it.each([['identity_v1', identity], ['moderation_v1', moderation]] as const)('%s round-trips every field', (kind, data) => {
    const back = decode<typeof data>(kind, row(kind, data))
    expect({ ...back, id: '' }).toEqual({ ...data, owner: INDEXER })
  })

  it.each([['identity_v1', identity], ['moderation_v1', moderation]] as const)('%s uses short lowercase columns within the limits', (kind, data) => {
    const names = Object.keys(encode(kind, data))
    expect(names.length).toBeLessThanOrEqual(32)
    expect(Object.keys(attributeTypesFor(kind)).length).toBeLessThanOrEqual(32)
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9._-]*$/)
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(32)
    }
  })

  it('filters by wallet as an addr and by name as a str', () => {
    expect(render(attrEq('identity_v1', 'wallet', identity.wallet))).toMatch(/wallet\s*=\s*addr\(/)
    expect(render(attrEq('identity_v1', 'ensName', 'ashura.dusk.eth'))).toMatch(/ens_name\s*=\s*str\(/)
    expect(render(attrEq('moderation_v1', 'subjectWallet', moderation.subjectWallet))).toMatch(/subject_wallet\s*=\s*addr\(/)
  })

  it('never writes anything key-shaped', () => {
    const written = JSON.stringify([encode('identity_v1', identity), encode('moderation_v1', moderation)], (_, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? Array.from(v) : v)
    expect(written).not.toMatch(/\b(sk|mk)-/)
  })

  it('refuses a name over the 128-byte string limit', () => {
    expect(() => encode('identity_v1', { ...identity, ensName: `${'a'.repeat(130)}.dusk.eth` })).toThrow(/ensName/)
  })
})
