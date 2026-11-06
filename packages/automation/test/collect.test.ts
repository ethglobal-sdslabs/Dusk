import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import { collectReputationReports } from '../src/collect'
import { parseReputationWorkflowConfig } from '../src/config'
import { world, config, h, user, addr, reputation, receipt, decoded, verifier } from './fixtures'

describe('decentralized scheduled evaluator', () => {
  it('recomputes every registered wallet, publishes retained evidence, and encodes the exact contract report', () => {
    const { state, rpc } = world()
    state.wallets = [user, addr(10), addr(11)]
    state.receipts = [receipt(1), receipt(2)]
    const bundles: string[] = []
    const out = collectReputationReports(config, rpc, 1000n, (body) => { bundles.push(body); return h('swarm ref') })
    const [chainId, receiver, epoch, sources, evaluations] = decoded(out.reports[0]!)
    expect(out.evaluated).toBe(3)
    expect([chainId, receiver.toLowerCase(), epoch, sources]).toEqual([11155111n, reputation, 3, state.sourceHash])
    expect(evaluations[0]).toMatchObject({ wallet: user, score: 0, settledJobs: 3, rejectedJobs: 0, illegal: 2, evidenceRef: h('swarm ref') })
    expect(evaluations[1]).toMatchObject({ score: 100, settledJobs: 0, rejectedJobs: 0 })
    const bundle = JSON.parse(bundles[0]!)
    expect(keccak256(toHex(JSON.stringify(bundle.records[0])))).toBe(evaluations[0]!.evidenceHash)
  })

  it('reads fresh sources again on the next pass and carries on-chain penalties across source deletion', () => {
    const { state, rpc } = world()
    const first = collectReputationReports(config, rpc, 1000n, () => h('evidence'))
    expect(decoded(first.reports[0]!)[4][0]!.score).toBe(100)
    const before = state.calls.length
    state.receipts = [receipt(1), receipt(2)]
    const second = collectReputationReports(config, rpc, 2000n, () => h('evidence'))
    expect(decoded(second.reports[0]!)[4][0]!.score).toBe(0)
    expect(state.calls.length).toBeGreaterThan(before)
    state.receipts = []; state.illegal = 2
    expect(decoded(collectReputationReports(config, rpc, 3000n, () => h('evidence')).reports[0]!)[4][0]!.score).toBe(0)
  })

  it('walks more than one inventory/evidence page and bounds each on-chain report', () => {
    const { state, rpc } = world()
    state.wallets = Array.from({ length: 101 }, (_, i) => addr(i + 100))
    state.receipts = Array.from({ length: 101 }, (_, i) => receipt(i + 1))
    const out = collectReputationReports(config, rpc, 1000n, () => h('evidence'))
    expect(out.evaluated).toBe(101)
    expect(out.reports).toHaveLength(6)
    expect(out.reports.map((r) => decoded(r)[4].length)).toEqual([20, 20, 20, 20, 20, 1])
    expect(state.calls.filter((c) => c.endsWith('arkiv_query'))).toHaveLength(3)
  })

  it('never converts a failed, partial, paused or wrong-policy read into zero reputation', () => {
    for (const failure of ['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'arkiv_query', 'eth_call']) {
      const { state, rpc } = world(); state.fail = failure
      expect(() => collectReputationReports(config, rpc, 1000n, () => { throw new Error('must not upload') })).toThrow()
    }
    const { state, rpc } = world(); state.missingInventory = true
    expect(() => collectReputationReports(config, rpc, 1000n, () => h('evidence'))).toThrow(/inventory/)
    state.missingInventory = false; state.sourceHash = h('wrong')
    expect(() => collectReputationReports(config, rpc, 1000n, () => h('evidence'))).toThrow(/sources/)
    state.paused = true
    expect(() => collectReputationReports(config, rpc, 1000n, () => h('evidence'))).toThrow(/paused/)
  })

  it('refuses truncated scans and missing public evidence retention', () => {
    const { state, rpc } = world(); state.receipts = Array.from({ length: 100 }, (_, i) => receipt(i + 1))
    expect(() => collectReputationReports({ ...config, limits: { ...config.limits, maxPages: 1 } }, rpc, 1000n, () => h('evidence'))).toThrow(/partial/)
    state.receipts = []
    expect(() => collectReputationReports(config, rpc, 1000n, () => `0x${'00'.repeat(32)}`)).toThrow(/retained/)
    state.wallets = [user, addr(10)]
    expect(() => collectReputationReports({ ...config, limits: { ...config.limits, maxWallets: 1 } }, rpc, 1000n, () => h('evidence'))).toThrow(/partial/)
  })

  it('filters forged creators and unfinalized evidence even when a user claims authority in attributes', () => {
    const { state, rpc } = world()
    state.receipts = [receipt(1, verifier), { ...receipt(2), createdAt: '0x65' }, { ...receipt(3), creationFlags: 0 }]
    expect(decoded(collectReputationReports(config, rpc, 1000n, () => h('evidence')).reports[0]!)[4][0]!.score).toBe(100)
  })

  it('projects public config without carrying unknown operator credentials', () => {
    const parsed = parseReputationWorkflowConfig({ ...config, operators: { privateKey: h('private') }, ens: { ...config.ens, ownerPrivateKey: h('private') } })
    expect(JSON.stringify(parsed)).not.toContain(h('private'))
    expect(parsed.schedule).toBe('0 0 */4 * * *')
  })
})
