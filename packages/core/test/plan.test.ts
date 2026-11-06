import { describe, expect, it } from 'vitest'
import { planJob } from '../src/plan'

const LIMIT = 64

describe('planJob — numbered tasks run in parallel', () => {
  it('splits one piece per numbered task, keeping the shared instruction on each', () => {
    const plan = planJob('Answer briefly.\n1. What is Arkiv?\n2. What is Swarm?\n3) What is 0G?', 30, LIMIT)
    expect(plan.kind).toBe('parallel')
    if (plan.kind !== 'parallel') return
    expect(plan.pieces.map((p) => p.prompt)).toEqual([
      'Answer briefly.\nWhat is Arkiv?',
      'Answer briefly.\nWhat is Swarm?',
      'Answer briefly.\nWhat is 0G?',
    ])
  })

  it('shares the answer budget across the pieces, rounding up', () => {
    const plan = planJob('1. a\n2. b\n3. c', 8, LIMIT)
    if (plan.kind !== 'parallel') throw new Error('expected parallel')
    expect(plan.pieces.map((p) => p.maxTokens)).toEqual([3, 3, 3])
  })

  it('splits by section headings too', () => {
    const plan = planJob('# Intro\nsay hi\n# Outro\nsay bye', 8, LIMIT)
    expect(plan.kind).toBe('parallel')
    if (plan.kind !== 'parallel') return
    expect(plan.pieces.map((p) => p.prompt)).toEqual(['# Intro\nsay hi', '# Outro\nsay bye'])
  })

  it('does not split a single task', () => {
    expect(planJob('1. only one', 8, LIMIT)).toEqual({ kind: 'single' })
    expect(planJob('hi', 8, LIMIT)).toEqual({ kind: 'single' })
  })
})

describe('planJob — the model output limit', () => {
  it('splits so no piece asks for more than the model can return', () => {
    const plan = planJob('1. a\n2. b', 100, LIMIT)
    if (plan.kind !== 'parallel') throw new Error('expected parallel')
    expect(plan.pieces.every((p) => p.maxTokens <= LIMIT)).toBe(true)
    expect(plan.pieces.map((p) => p.maxTokens)).toEqual([50, 50])
  })

  it('refuses a job over the limit that has nothing to split on', () => {
    expect(planJob('write a long essay', 100, LIMIT)).toEqual({ kind: 'too-big', limit: LIMIT })
  })

  it('refuses when even the split pieces are over the limit', () => {
    expect(planJob('1. a\n2. b', 200, LIMIT)).toEqual({ kind: 'too-big', limit: LIMIT })
  })
})

describe('planJob — steps that depend on each other', () => {
  it('runs numbered steps that refer to an earlier answer in order', () => {
    expect(planJob('1. Pick a city\n2. Then describe the city from step 1', 8, LIMIT)).toEqual({
      kind: 'serial',
      pieces: [
        { prompt: 'Pick a city', maxTokens: 4 },
        { prompt: 'Then describe the city from step 1', maxTokens: 4 },
      ],
    })
  })
})

describe('planJob — a list asked about as a whole', () => {
  it('keeps a list whose preamble asks about the whole list as one job', () => {
    expect(planJob('Rank these from best to worst:\n1. Python\n2. Rust\n3. Go\nOne line each.', 30, LIMIT)).toEqual({ kind: 'single' })
    expect(planJob('Compare:\n# Cats\n# Dogs', 8, LIMIT)).toEqual({ kind: 'single' })
  })

  it('still splits independent questions', () => {
    expect(planJob('Answer these briefly:\n1. Capital of France?\n2. Capital of Spain?', 8, LIMIT)).toMatchObject({ kind: 'parallel' })
  })
})
