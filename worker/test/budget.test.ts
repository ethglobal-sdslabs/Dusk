import { describe, expect, it } from 'vitest'
import {
  canAfford,
  defaultUnitsPerTokenFrom,
  estimateInputTokens,
  learnFromBalance,
  newBudget,
  recordSpend,
  unitsPerToken,
  unsettledUnits,
  worstCaseUnits,
} from '../src/budget'

const MODEL = '0gm-1.0-35b-a3b'

describe('estimateInputTokens', () => {
  it('over-counts: a token per 3 characters plus the chat wrapper', () => {
    expect(estimateInputTokens(0)).toBe(20)
    expect(estimateInputTokens(2)).toBe(21)
    expect(estimateInputTokens(300)).toBe(120)
  })
})

describe('worstCaseUnits', () => {
  it('prices input and the whole output budget at the unmeasured default', () => {
    const b = newBudget(1)
    expect(worstCaseUnits(b, MODEL, 2, 8)).toBe(29)
  })

  it('uses what it has measured for that model once it has', () => {
    const b = newBudget(1)
    b.unitsPerToken.set(MODEL, 0.5)
    expect(worstCaseUnits(b, MODEL, 2, 8)).toBe(15)
  })
})

describe('canAfford', () => {
  it('keeps a 10% margin', () => {
    const b = newBudget(1)
    expect(canAfford(b, 32n, MODEL, 2, 8, 0)).toBe(true)
    expect(canAfford(b, 31n, MODEL, 2, 8, 0)).toBe(false)
  })

  it('subtracts spending the balance has not caught up with yet', () => {
    const b = newBudget(1)
    recordSpend(b, { at: 0, model: MODEL, tokens: 10 })
    expect(unsettledUnits(b, 30_000)).toBe(10)
    expect(canAfford(b, 40n, MODEL, 2, 8, 30_000)).toBe(false)
    expect(unsettledUnits(b, 61_000)).toBe(0)
    expect(canAfford(b, 40n, MODEL, 2, 8, 61_000)).toBe(true)
  })
})

describe('learnFromBalance', () => {
  it('learns a model price from one isolated spend once the balance has settled', () => {
    const b = newBudget(1)
    recordSpend(b, { at: 0, model: MODEL, tokens: 20, before: 1_000n })
    learnFromBalance(b, 1_000n, 10_000)
    expect(b.unitsPerToken.has(MODEL)).toBe(false)
    learnFromBalance(b, 993n, 45_000)
    expect(unitsPerToken(b, MODEL)).toBeCloseTo(7 / 20)
  })

  it('learns nothing from a balance that has not moved', () => {
    const b = newBudget(1)
    recordSpend(b, { at: 0, model: MODEL, tokens: 20, before: 1_000n })
    learnFromBalance(b, 1_000n, 45_000)
    expect(b.unitsPerToken.has(MODEL)).toBe(false)
  })

  it('refuses to learn when two spends overlap, since the drop cannot be split', () => {
    const b = newBudget(1)
    recordSpend(b, { at: 0, model: MODEL, tokens: 20, before: 1_000n })
    recordSpend(b, { at: 20_000, model: MODEL, tokens: 20, before: 1_000n })
    learnFromBalance(b, 986n, 50_000)
    expect(b.unitsPerToken.has(MODEL)).toBe(false)
  })

  it('smooths a new measurement into the old one', () => {
    const b = newBudget(1)
    b.unitsPerToken.set(MODEL, 0.4)
    recordSpend(b, { at: 0, model: MODEL, tokens: 10, before: 100n })
    learnFromBalance(b, 92n, 45_000)
    expect(unitsPerToken(b, MODEL)).toBeCloseTo(0.6)
  })
})

describe('defaultUnitsPerTokenFrom', () => {
  it('defaults to 1 credit unit per token — about 2.5× what one mainnet completion measured', () => {
    expect(defaultUnitsPerTokenFrom({})).toBe(1)
  })
  it('reads a positive number', () => {
    expect(defaultUnitsPerTokenFrom({ DUSK_UNITS_PER_TOKEN: '0.5' })).toBe(0.5)
  })
  it.each(['0', '-1', 'abc'])('refuses %j', (raw) => {
    expect(() => defaultUnitsPerTokenFrom({ DUSK_UNITS_PER_TOKEN: raw })).toThrow(/DUSK_UNITS_PER_TOKEN/)
  })
})
