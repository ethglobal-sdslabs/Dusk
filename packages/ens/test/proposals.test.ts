import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import type { Deal } from '@dusk/core'
import { proposeBans, REPUTATION_POLICY } from '../src'

const W = '0x1111111111111111111111111111111111111111' as Address
const HONEST = '0x2222222222222222222222222222222222222222' as Address
const B1 = '0xb100000000000000000000000000000000000001' as Address
const B2 = '0xb200000000000000000000000000000000000002' as Address
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const h = (s: string) => keccak256(toHex(s))
const NOW = 2_000_000_000
const EARLY = NOW - 7_200

function deal(over: Partial<Deal>): Deal {
  return { buyer: B1, worker: '0x0000000000000000000000000000000000000000', amount: 0n, outputHash: `0x${'00'.repeat(32)}`, commitAtSec: 0, deadlineSec: NOW - 10, state: 'refunded', ...over }
}

describe('proposeBans (Phase F, observation only)', () => {
  it('proposes nothing from no evidence', () => {
    expect(proposeBans({ deals: new Map(), receipts: [], grants: [], nowSec: NOW })).toEqual([])
  })

  it('flags a receipt that contradicts the hash its own author committed on chain', () => {
    const deals = new Map([[id(1), deal({ worker: W, buyer: B1, outputHash: h('real'), state: 'settled' })]])
    const [p, ...rest] = proposeBans({ deals, receipts: [{ owner: W, escrowId: id(1), outputHash: h('claimed') }], grants: [], nowSec: NOW })
    expect(rest).toEqual([])
    expect(p!.wallet).toBe(W.toLowerCase())
    expect(p!.reasonCode).toBe(REPUTATION_POLICY.reasonCodes.receiptContradictsChain)
    expect(p!.signals[0]!.kind).toBe('receipt-contradicts-chain')
    expect(p!.evidenceHash).toBe(keccak256(toHex(p!.evidence)))
    expect(p!.decisionId.startsWith('dusk-rep-v2-')).toBe(true)
  })

  it('ignores a receipt for a deal someone else committed, or one that matches', () => {
    const deals = new Map([
      [id(1), deal({ worker: HONEST, outputHash: h('real'), state: 'settled' })],
      [id(2), deal({ worker: W, outputHash: h('ok'), state: 'settled' })],
    ])
    expect(proposeBans({ deals, receipts: [{ owner: W, escrowId: id(1), outputHash: h('x') }, { owner: W, escrowId: id(2), outputHash: h('ok') }], grants: [], nowSec: NOW })).toEqual([])
  })

  it('flags repeated abandonment of granted jobs across distinct buyers', () => {
    const deals = new Map([
      [id(1), deal({ buyer: B1 })],
      [id(2), deal({ buyer: B2 })],
      [id(3), deal({ buyer: B1, state: 'funded', deadlineSec: NOW - 1 })],
    ])
    const grants = [1, 2, 3].map((n) => ({ owner: n === 2 ? B2 : B1, escrowId: id(n), worker: W, grantedAtSec: EARLY }))
    const [p] = proposeBans({ deals, receipts: [], grants, nowSec: NOW })
    expect(p!.signals[0]).toMatchObject({ kind: 'granted-not-committed', abandoned: 3, served: 0, buyers: 2, buyerInfluenced: true, buyersVerified: false })
    expect(p!.reasonCode).toBe(REPUTATION_POLICY.reasonCodes.grantedNotCommitted)
  })

  it('does not let one buyer frame a worker, count a live deal, or a grant the deal does not back', () => {
    const many = [1, 2, 3, 4].map((n) => [id(n), deal({ buyer: B1 })] as const)
    const grants = [1, 2, 3, 4].map((n) => ({ owner: B1, escrowId: id(n), worker: W, grantedAtSec: EARLY }))
    expect(proposeBans({ deals: new Map(many), receipts: [], grants, nowSec: NOW })).toEqual([])
    const live = new Map([[id(1), deal({ buyer: B1, state: 'funded', deadlineSec: NOW + 60 })], [id(2), deal({ buyer: B2 })], [id(3), deal({ buyer: B2 })]])
    const g2 = [1, 2, 3].map((n) => ({ owner: n === 1 ? B1 : B2, escrowId: id(n), worker: W, grantedAtSec: EARLY }))
    expect(proposeBans({ deals: live, receipts: [], grants: g2, nowSec: NOW })).toEqual([])
    const forged = [1, 2, 3].map((n) => ({ owner: B2, escrowId: id(n), worker: W, grantedAtSec: EARLY }))
    const d3 = new Map([[id(1), deal({ buyer: B1 })], [id(2), deal({ buyer: B2 })], [id(3), deal({ buyer: B2 })]])
    expect(proposeBans({ deals: d3, receipts: [], grants: forged, nowSec: NOW })).toEqual([])
  })

  it('does not flag a worker that serves most of what it is granted', () => {
    const entries: Array<[Hex, Deal]> = []
    const grants = []
    for (let n = 1; n <= 10; n++) {
      const abandoned = n <= 3
      entries.push([id(n), deal({ buyer: n % 2 ? B1 : B2, ...(abandoned ? {} : { worker: W, state: 'settled', outputHash: h(`o${n}`) }) })])
      grants.push({ owner: n % 2 ? B1 : B2, escrowId: id(n), worker: W, grantedAtSec: EARLY })
    }
    expect(proposeBans({ deals: new Map(entries), receipts: [], grants, nowSec: NOW })).toEqual([])
  })

  it('is deterministic, so a re-run yields the same decision id (which the controller refuses twice)', () => {
    const deals = new Map([[id(1), deal({ worker: W, outputHash: h('real'), state: 'committed' })]])
    const e = { deals, receipts: [{ owner: W, escrowId: id(1), outputHash: h('claimed') }], grants: [], nowSec: NOW }
    expect(proposeBans(e)).toEqual(proposeBans({ ...e, receipts: [...e.receipts, ...e.receipts] }))
  })

  it('skips wallets already banned', () => {
    const deals = new Map([[id(1), deal({ worker: W, outputHash: h('real'), state: 'settled' })]])
    expect(proposeBans({ deals, receipts: [{ owner: W, escrowId: id(1), outputHash: h('x') }], grants: [], nowSec: NOW, exclude: new Set([W.toLowerCase()]) })).toEqual([])
  })

  it('does not count a grant written too late to deliver, or one with no known time', () => {
    const deals = new Map([[id(1), deal({ buyer: B1 })], [id(2), deal({ buyer: B2 })], [id(3), deal({ buyer: B1 })]])
    const late = (n: number) => deal({}).deadlineSec - REPUTATION_POLICY.minGrantLeadSec + n
    const grants = [
      { owner: B1, escrowId: id(1), worker: W, grantedAtSec: EARLY },
      { owner: B2, escrowId: id(2), worker: W, grantedAtSec: EARLY },
      { owner: B1, escrowId: id(3), worker: W, grantedAtSec: late(1) },
    ]
    expect(proposeBans({ deals, receipts: [], grants, nowSec: NOW })).toEqual([])
    expect(proposeBans({ deals, receipts: [], grants: grants.map((g, i) => (i === 2 ? { owner: g.owner, escrowId: g.escrowId, worker: g.worker } : g)), nowSec: NOW })).toEqual([])
  })

  it('counts only verified buyers as distinct when verification is available', () => {
    const deals = new Map([[id(1), deal({ buyer: B1 })], [id(2), deal({ buyer: B2 })], [id(3), deal({ buyer: B1 })]])
    const grants = [1, 2, 3].map((n) => ({ owner: n === 2 ? B2 : B1, escrowId: id(n), worker: W, grantedAtSec: EARLY }))
    expect(proposeBans({ deals, receipts: [], grants, nowSec: NOW, verifiedBuyers: new Set([B1.toLowerCase()]) })).toEqual([])
    const [p] = proposeBans({ deals, receipts: [], grants, nowSec: NOW, verifiedBuyers: new Set([B1.toLowerCase(), B2.toLowerCase()]) })
    expect(p!.signals[0]).toMatchObject({ buyers: 2, buyersVerified: true })
  })
})
