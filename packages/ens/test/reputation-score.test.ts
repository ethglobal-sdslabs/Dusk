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
type Previous = { badAnswers: number; illegal: number; late?: number; passed?: number; flags: Map<string, number> }
function evaluation(f = facts(), previous: Previous = { badAnswers: 0, illegal: 0, flags: new Map<string, number>() }) {
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
    const v = receipt({ id: 'v', creator: verifier, result: 'bad', check: 'empty-answer', outputHash: undefined })
    expect(evaluation({ ...f, verifications: [v] }).evaluation.score).toBe(80)
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
    expect(evaluation(f, existing).evaluation.score).toBe(30)
    expect(evaluation({ ...f, receipts: [receipt()] }, existing).evaluation.illegal).toBe(1)
    // dismissed illegal: bit 2 << 4
    expect(evaluation({ ...f, receipts: [receipt()] }, { badAnswers: 0, illegal: 0, flags: new Map([[job, 2 << 4]]) }).evaluation.score).toBe(100)
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
    expect(evaluation({ ...f, commits: [], resolutions: [] }).evaluation).toMatchObject({ late: 0, passed: 0, policyVersion: 2 })
  })
})

describe('policy v2 — canary output and latency', () => {
  const canary = (n: number, result: 'pass' | 'bad' | 'illegal', check: string, latencyMs?: number): ReputationEntity =>
    ({ id: `c${n}`, creator: verifier, readonly: true, createdAtBlock: 50n, worker: wallet, escrowId: id(n), result, check, ...(latencyMs !== undefined ? { latencyMs } : {}) })

  it('adds 10 per delivered canary, never above 100', () => {
    const f = facts()
    const r = evaluation({ ...f, receipts: [receipt()], verifications: [canary(2, 'pass', 'delivered', 20_000)] }).evaluation
    expect(r).toMatchObject({ illegal: 1, passed: 1, score: 60 })
    expect(evaluation({ ...f, verifications: [canary(1, 'pass', 'delivered', 20_000)] }).evaluation.score).toBe(100)
  })

  it('charges late (-10) over 2x the median once there are 3 delivered canaries', () => {
    const f = facts()
    const many = { ...f, commits: [1, 2, 3, 4].map((n) => ({ ...f.commits[0]!, escrowId: id(n) })) }
    const vs = [canary(1, 'pass', 'delivered', 20_000), canary(2, 'pass', 'delivered', 20_000), canary(3, 'pass', 'delivered', 20_000), canary(4, 'pass', 'delivered', 90_000)]
    expect(evaluation({ ...many, resolutions: [], verifications: vs }).evaluation).toMatchObject({ passed: 3, late: 1, score: 100 })
  })

  it('charges -20 for a canary claimed and never delivered, with no commit behind it', () => {
    const f = facts()
    expect(evaluation({ ...f, verifications: [canary(42, 'bad', 'no-delivery')] }).evaluation).toMatchObject({ badAnswers: 1, score: 80 })
  })

  it('does not judge answer quality: an old wrong-answer verdict counts as nothing', () => {
    expect(evaluation({ ...facts(), verifications: [canary(1, 'bad', 'wrong-answer')] }).evaluation.score).toBe(100)
  })

  // The contract keeps one finding per job, worst wins; the workflow must predict that
  // exactly or the contract refuses the whole evaluation.
  it('predicts the contract: a late finding replaces a pass already on chain for that job', () => {
    const f = facts()
    const many = { ...f, commits: [1, 2, 3, 4].map((n) => ({ ...f.commits[0]!, escrowId: id(n) })), resolutions: [] }
    const job4 = reputationJobId(f.sources, id(4))
    const onChainPass = { badAnswers: 0, illegal: 0, late: 0, passed: 1, flags: new Map([[job4, 1 << 3]]) }
    const vs = [canary(1, 'pass', 'delivered', 20_000), canary(2, 'pass', 'delivered', 20_000), canary(3, 'pass', 'delivered', 20_000), canary(4, 'pass', 'delivered', 90_000)]
    const r = evaluation({ ...many, verifications: vs }, onChainPass).evaluation
    expect(r).toMatchObject({ passed: 3, late: 1 })
    expect(r.findings.find((x) => x.job === job4)?.kind).toBe(3)
  })
})
