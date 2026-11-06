import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { evaluateReputation, reputationFindings, reputationJobId, reputationScore, reputationSourceHash, type ReputationEntity, type ReputationFacts } from '../src/reputation-score'

const wallet = '0x1111111111111111111111111111111111111111' as Address
const stranger = '0x2222222222222222222222222222222222222222' as Address
const verifier = '0x3333333333333333333333333333333333333333' as Address
const hash = (s: string) => keccak256(toHex(s))
const id = (n: number) => hash(String(n))
function facts(): ReputationFacts {
  return {
    sources: { ensChainId: 11155111, controller: wallet, galileoChainId: 16602, escrow: stranger, arkivChainId: 7794095, verifiers: [verifier] },
    commits: [1, 2, 3].map((n) => ({ escrowId: id(n), worker: wallet, outputHash: hash('correct'), blockNumber: BigInt(n), transactionHash: hash(`commit-${n}`) })),
    resolutions: [1, 2, 3].map((n) => ({ escrowId: id(n), worker: wallet, result: n === 3 ? 'rejected' as const : 'settled' as const, blockNumber: BigInt(n + 10), transactionHash: hash(`resolved-${n}`) })),
    receipts: [], verifications: [], finalizedArkivBlock: 100n,
  }
}
function receipt(over: Partial<ReputationEntity> = {}): ReputationEntity {
  return { id: 'receipt', creator: wallet, readonly: true, createdAtBlock: 50n, worker: wallet, escrowId: id(1), outputHash: hash('lie'), ...over }
}
function evaluation(f = facts(), previous = { badAnswers: 0, illegal: 0, flags: new Map<string, number>() }) {
  return evaluateReputation({ wallet, generation: 1n, evaluatedAt: 1000n, galileoBlock: 100n, facts: f, previous })
}

describe('official reputation evaluation', () => {
  it('uses exact current resolved jobs and rejects partial or contradictory chain evidence', () => {
    const f = facts()
    expect(reputationFindings(wallet, f)).toMatchObject({ settledJobs: 2, rejectedJobs: 1 })
    expect(() => evaluation({ ...f, commits: [] })).toThrow(/Incomplete/)
    expect(() => evaluation({ ...f, commits: [...f.commits, { ...f.commits[0]!, worker: stranger }] })).toThrow(/Contradictory/)
    expect(() => evaluation({ ...f, resolutions: [...f.resolutions, { ...f.resolutions[0]!, result: 'rejected' }] })).toThrow(/Contradictory/)
  })

  it('authenticates immutable receipt creators, not transferable owners or payload claims', () => {
    const f = facts()
    for (const bad of [receipt({ creator: stranger }), receipt({ creator: undefined }), receipt({ worker: stranger }), receipt({ readonly: false }), receipt({ createdAtBlock: 101n }), receipt({ createdAtBlock: undefined }), receipt({ escrowId: id(999) })]) {
      expect(evaluation({ ...f, receipts: [bad] }).evaluation.illegal).toBe(0)
    }
    expect(evaluation({ ...f, receipts: [receipt()] }).evaluation).toMatchObject({ illegal: 1, score: 50 })
    expect(evaluation({ ...f, receipts: [receipt({ outputHash: hash('correct') })] }).evaluation.illegal).toBe(0)
  })

  it('uses only approved verifier creators on a job the subject actually committed', () => {
    const f = facts()
    const v = receipt({ id: 'v', creator: verifier, result: 'bad', outputHash: undefined })
    expect(evaluation({ ...f, verifications: [v] }).evaluation.score).toBe(90)
    expect(evaluation({ ...f, verifications: [{ ...v, creator: stranger }] }).evaluation.score).toBe(100)
    expect(evaluation({ ...f, verifications: [{ ...v, escrowId: id(99) }] }).evaluation.score).toBe(100)
    expect(evaluation({ ...f, verifications: [{ ...v, worker: stranger }] }).evaluation.score).toBe(100)
  })

  it('counts each job and finding kind once, however many rows or verifiers repeat it', () => {
    const f = facts()
    const v = receipt({ creator: verifier, result: 'illegal' })
    const r = evaluation({ ...f, receipts: [receipt(), receipt({ id: 'duplicate' })], verifications: [v, { ...v, id: 'v2' }], resolutions: [...f.resolutions, ...f.resolutions] })
    expect(r.evaluation).toMatchObject({ score: 50, illegal: 1, settledJobs: 2, rejectedJobs: 1 })
    expect(r.evaluation.findings).toHaveLength(1)
  })

  it('preserves on-chain findings after source deletion and excludes company-dismissed findings', () => {
    const f = facts()
    const job = reputationJobId(f.sources, id(1))
    const existing = { badAnswers: 1, illegal: 1, flags: new Map([[job, 2]]) }
    expect(evaluation(f, existing).evaluation.score).toBe(40)
    expect(evaluation({ ...f, receipts: [receipt()] }, existing).evaluation.illegal).toBe(1)
    expect(evaluation({ ...f, receipts: [receipt()] }, { badAnswers: 0, illegal: 0, flags: new Map([[job, 8]]) }).evaluation.score).toBe(100)
  })

  it('binds evidence and policy sources deterministically and isolates escrow deployments', () => {
    const f = facts()
    const a = evaluation({ ...f, receipts: [receipt(), receipt({ id: 'another', escrowId: id(2) })] })
    const b = evaluation({ ...f, commits: [...f.commits].reverse(), resolutions: [...f.resolutions].reverse(), receipts: [receipt({ id: 'another', escrowId: id(2) }), receipt()] })
    expect(a.evaluation.evidenceHash).toBe(b.evaluation.evidenceHash)
    expect(a.evaluation.evidenceHash).toBe(keccak256(toHex(a.evidence)))
    expect(reputationSourceHash({ ...f.sources, verifiers: [verifier, verifier] })).toBe(reputationSourceHash(f.sources))
    expect(reputationSourceHash({ ...f.sources, verifiers: [] })).not.toBe(reputationSourceHash(f.sources))
    expect(reputationJobId({ ...f.sources, escrow: wallet }, id(1))).not.toBe(reputationJobId(f.sources, id(1)))
  })

  it('keeps empty history unassessed and never manufactures failures from missing records', () => {
    const f = facts()
    expect(evaluation({ ...f, commits: [], resolutions: [] }).evaluation).toMatchObject({ score: 100, settledJobs: 0, rejectedJobs: 0, badAnswers: 0, illegal: 0 })
    for (const n of [-1, NaN, Infinity, 0x100000000]) expect(() => reputationScore(n, 0)).toThrow()
  })
})
