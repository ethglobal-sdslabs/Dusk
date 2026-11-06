import { describe, expect, it } from 'vitest'
import {
  applyFinding,
  canaryScore,
  dismissFinding,
  FINDING,
  lateThresholdMs,
  newFindingState,
  verdictFinding,
} from '../src/canary-score'

describe('canaryScore — 100 + 10 per pass − 10 per late − 20 per empty − 50 per illegal, within 0..100', () => {
  it('scores the counts', () => {
    expect(canaryScore({ empty: 0, illegal: 0, late: 0, passed: 0 })).toBe(100)
    expect(canaryScore({ empty: 1, illegal: 1, late: 0, passed: 1 })).toBe(40)
    expect(canaryScore({ empty: 0, illegal: 0, late: 2, passed: 1 })).toBe(90)
  })
  it('never leaves 0..100', () => {
    expect(canaryScore({ empty: 0, illegal: 0, late: 0, passed: 9 })).toBe(100)
    expect(canaryScore({ empty: 0, illegal: 3, late: 0, passed: 0 })).toBe(0)
  })
})

describe('lateThresholdMs — 2x the median delivered canary, once there are 3, never under 10s', () => {
  const pass = (n: number, latencyMs: number) => ({ escrowId: `0x${n}`, result: 'pass' as const, latencyMs })
  it('is null with fewer than 3 delivered canaries', () => {
    expect(lateThresholdMs([pass(1, 30_000), pass(2, 30_000)])).toBeNull()
  })
  it('is twice the median', () => {
    expect(lateThresholdMs([pass(1, 20_000), pass(2, 30_000), pass(3, 40_000)])).toBe(60_000)
  })
  it('never goes under 10s', () => {
    expect(lateThresholdMs([pass(1, 1_000), pass(2, 1_000), pass(3, 1_000)])).toBe(10_000)
  })
})

// The contract keeps one record per job. Because "late" is relative, a job judged on time
// today can be judged late later; without one-finding-per-job it would count both ways.
describe('applyFinding — one finding per job, the worst one wins', () => {
  it('counts a new finding once', () => {
    const s = newFindingState()
    expect(applyFinding(s, 'j1', FINDING.pass)).toBe(true)
    expect(applyFinding(s, 'j1', FINDING.pass)).toBe(false)
    expect(s.counts).toEqual({ empty: 0, illegal: 0, late: 0, passed: 1 })
  })
  it('replaces a lesser finding with a worse one, undoing its points', () => {
    const s = newFindingState()
    applyFinding(s, 'j1', FINDING.pass)
    expect(applyFinding(s, 'j1', FINDING.late)).toBe(true)
    expect(s.counts).toEqual({ empty: 0, illegal: 0, late: 1, passed: 0 })
    applyFinding(s, 'j1', FINDING.illegal)
    expect(s.counts).toEqual({ empty: 0, illegal: 1, late: 0, passed: 0 })
  })
  it('never lets a lesser finding replace a worse one', () => {
    const s = newFindingState()
    applyFinding(s, 'j1', FINDING.empty)
    expect(applyFinding(s, 'j1', FINDING.pass)).toBe(false)
    expect(applyFinding(s, 'j1', FINDING.late)).toBe(false)
    expect(s.counts).toEqual({ empty: 1, illegal: 0, late: 0, passed: 0 })
  })
  it('a dismissed finding cannot come back, but a different one still can', () => {
    const s = newFindingState()
    applyFinding(s, 'j1', FINDING.empty)
    dismissFinding(s, 'j1', FINDING.empty)
    expect(s.counts.empty).toBe(0)
    expect(applyFinding(s, 'j1', FINDING.empty)).toBe(false)
    expect(applyFinding(s, 'j1', FINDING.illegal)).toBe(true)
  })
  it('stores flags exactly as the contract does: kind k is bit 1<<(k-1), dismissed is that bit << 4', () => {
    const s = newFindingState()
    applyFinding(s, 'j1', FINDING.late)
    expect(s.flags.get('j1')).toBe(1 << (FINDING.late - 1))
    dismissFinding(s, 'j1', FINDING.late)
    expect(s.flags.get('j1')).toBe((1 << (FINDING.late - 1)) << 4)
  })
})

describe('verdictFinding — what a verifier verdict counts as', () => {
  it('maps illegal, empty and no-delivery, and pass or late by the threshold', () => {
    expect(verdictFinding({ result: 'illegal', check: 'output-hash-mismatch' }, null)).toBe(FINDING.illegal)
    expect(verdictFinding({ result: 'bad', check: 'empty-answer' }, null)).toBe(FINDING.empty)
    expect(verdictFinding({ result: 'bad', check: 'no-delivery' }, null)).toBe(FINDING.empty)
    expect(verdictFinding({ result: 'pass', check: 'delivered', latencyMs: 20_000 }, 60_000)).toBe(FINDING.pass)
    expect(verdictFinding({ result: 'pass', check: 'delivered', latencyMs: 90_000 }, 60_000)).toBe(FINDING.late)
  })
  it('does not judge answer quality: an old wrong-answer verdict counts as nothing', () => {
    expect(verdictFinding({ result: 'bad', check: 'wrong-answer' }, null)).toBeNull()
  })
})
