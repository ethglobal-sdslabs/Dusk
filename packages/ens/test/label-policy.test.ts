import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeLabel, RESERVED_LABELS } from '../src'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/test/fixtures/ens-labels.json', import.meta.url), 'utf8')) as {
  valid: string[]; invalid: string[]; reserved: string[]
}

describe('label policy shared with DuskIdentityController.validLabel', () => {
  it.each(fixture.valid)('accepts %j', (label) => expect(normalizeLabel(label)).toBe(label))
  it.each(fixture.invalid)('rejects %j', (label) => expect(() => normalizeLabel(label)).toThrow())
  it('reserves exactly the list the controller is deployed with', () => {
    expect([...RESERVED_LABELS]).toEqual(fixture.reserved)
    for (const label of fixture.reserved) expect(() => normalizeLabel(label)).toThrow(/reserved/)
  })
})
