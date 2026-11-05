import { describe, expect, it } from 'vitest'
import { eq } from '@arkiv-network/sdk/query'
import { attrEq } from '@dusk/arkiv'
import { fakeArkiv } from './fakes'

const WORKER_ADDR = `0x${'ee'.repeat(20)}`

describe('fakeArkiv().query — filter type-checking', () => {
  it('accepts a correctly-typed attrEq filter', async () => {
    const arkiv = fakeArkiv()
    await expect(
      arkiv.query('receipt', attrEq('receipt', 'worker', WORKER_ADDR)),
    ).resolves.toEqual([])
  })

  it('throws when a comparison tags an attribute as the wrong stored type', async () => {
    const arkiv = fakeArkiv()
    await expect(arkiv.query('receipt', eq('worker', WORKER_ADDR))).rejects.toThrow(
      /stored as addr/,
    )
  })

  it('throws when a comparison names an attribute the kind does not have', async () => {
    const arkiv = fakeArkiv()
    await expect(arkiv.query('receipt', eq('not_a_real_attribute', 'x'))).rejects.toThrow(
      /does not store/,
    )
  })

  it('still runs with no filter at all — a query that scopes only to the kind', async () => {
    const arkiv = fakeArkiv()
    await expect(arkiv.query('job')).resolves.toEqual([])
  })
})
