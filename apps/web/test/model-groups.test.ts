import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@dusk/core'
import { modelOptionGroups } from '../src/lib/model-groups'

const m = (id: string, verifiability?: string, out = ['text'], input = ['text']): ModelInfo => ({
  id,
  inputModalities: input,
  outputModalities: out,
  ...(verifiability ? { verifiability } : {}),
})

const catalog = [m('zeta', 'TeeML'), m('alpha', 'TeeML'), m('tls', 'TeeTLS'), m('plain'), m('embed', 'TeeML', ['embedding'])]

describe('modelOptionGroups', () => {
  it('splits the catalog’s chat models into private, verified and standard, sorted', () => {
    expect(modelOptionGroups(catalog, [])).toEqual([
      { tier: 'private', label: 'Private · TeeML', models: ['alpha', 'zeta'] },
      { tier: 'verified', label: 'Verified · TeeTLS', models: ['tls'] },
      { tier: 'standard', label: 'Standard', models: ['plain'] },
    ])
  })

  it('leaves out models that do not answer in text — unless named as extras', () => {
    expect(modelOptionGroups(catalog, []).flatMap((g) => g.models)).not.toContain('embed')
    expect(modelOptionGroups(catalog, ['embed'])[0]!.models).toContain('embed')
  })

  it('files an extra the catalog does not list under "Not in 0G’s catalog"', () => {
    const groups = modelOptionGroups(catalog, ['typo-model', 'alpha'])
    expect(groups.at(-1)).toEqual({ tier: 'other', label: 'Not in 0G’s catalog', models: ['typo-model'] })
    expect(groups.flatMap((g) => g.models).filter((x) => x === 'alpha')).toHaveLength(1)
  })

  it('leaves out a speech-to-text model: it answers in text but takes no text', () => {
    const groups = modelOptionGroups([...catalog, m('whisper', 'TeeML', ['text'], ['audio'])], [])
    expect(groups.flatMap((g) => g.models)).not.toContain('whisper')
  })

  it('drops an empty group rather than rendering a heading with nothing under it', () => {
    expect(modelOptionGroups([m('only', 'TeeML')], []).map((g) => g.tier)).toEqual(['private'])
  })

  it('offers only the extras while the catalog is unread', () => {
    expect(modelOptionGroups(null, ['a', 'b', 'a'])).toEqual([{ tier: 'other', label: 'Not in 0G’s catalog', models: ['a', 'b'] }])
    expect(modelOptionGroups(null, [''])).toEqual([])
  })
})
