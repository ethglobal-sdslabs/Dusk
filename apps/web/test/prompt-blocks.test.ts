import { describe, expect, it } from 'vitest'
import { blockLabel, blocksSummary } from '../src/components/PromptBlocks'

describe('blockLabel', () => {
  it('shows the task, not its number, heading mark or the shared instruction', () => {
    expect(blockLabel('Answer briefly.\nWhat is Arkiv?')).toBe('What is Arkiv?')
    expect(blockLabel('# Intro\nsay hi')).toBe('say hi')
    expect(blockLabel('2) Pick a city')).toBe('Pick a city')
  })
  it('shortens long tasks', () => {
    expect(blockLabel('x'.repeat(40), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('blocksSummary', () => {
  it('describes the split before posting', () => {
    expect(blocksSummary('parallel', [{ label: 'a' }, { label: 'b' }])).toBe('2 pieces, worked on at once')
    expect(blocksSummary('serial', [{ label: 'a' }, { label: 'b' }])).toBe('2 pieces, one after another')
    expect(blocksSummary('single', [{ label: 'a' }])).toBe('One block — one worker runs it')
  })
  it('counts deliveries once pieces are tracked', () => {
    expect(
      blocksSummary('parallel', [
        { label: 'a', state: 'delivered' },
        { label: 'b', state: 'waiting' },
      ]),
    ).toBe('2 pieces, worked on at once — 1 of 2 delivered')
  })
})
