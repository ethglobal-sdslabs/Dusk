import { attributeTypesFor } from '@dusk/arkiv'
import { ARKIV_BLOCK_TIME_SEC } from '@dusk/core'
import { render } from '@arkiv-network/sdk/query'
import { describe, expect, it } from 'vitest'
import { EMPTY_SNAPSHOT, MARKET_POLL_MS, marketQueries, readMarket } from '../src/lib/arkiv'

function comparisons(rendered: string): Array<{ name: string; tag: string }> {
  return [...rendered.matchAll(/([a-z][a-z0-9._]*)\s*(?:=|>=|<=|>|<|!=)\s*([a-z0-9]+)\(/g)].map((m) => ({
    name: m[1]!,
    tag: m[2]!,
  }))
}

describe('marketQueries', () => {
  it('reads the four kinds the market is made of', () => {
    expect(Object.keys(marketQueries()).sort()).toEqual(['claims', 'jobs', 'receipts', 'workers'])
    const kinds = Object.values(marketQueries()).map((q) => q.kind)
    expect(kinds.sort()).toEqual(['claim', 'job', 'receipt', 'worker'])
  })

  it('tags every comparison with the attribute’s own stored Arkiv type', () => {
    for (const query of Object.values(marketQueries())) {
      if (!query.filter) continue
      const types = attributeTypesFor(query.kind)
      const found = comparisons(render(query.filter))
      expect(found.length, `${query.kind}: a filter that renders no comparison filters nothing`).toBeGreaterThan(0)
      for (const { name, tag } of found) {
        expect(types[name], `${query.kind}.${name} is not a queryable attribute`).toBeDefined()
        expect(tag, `${query.kind}.${name} is stored as ${types[name]} and queried as ${tag}`).toBe(types[name])
      }
    }
  })

  it('asks for open jobs specifically, because that is what a market shows', () => {
    const rendered = render(marketQueries().jobs.filter!)
    expect(rendered).toContain('status')
    expect(rendered).toContain('open')
  })

  it('leaves the other three kinds unfiltered, because the market enumerates them whole', () => {
    expect(marketQueries().workers.filter).toBeUndefined()
    expect(marketQueries().claims.filter).toBeUndefined()
    expect(marketQueries().receipts.filter).toBeUndefined()
  })

  it('never spells an Arkiv attribute name in a form the chain would reject', () => {
    for (const query of Object.values(marketQueries())) {
      if (!query.filter) continue
      for (const { name } of comparisons(render(query.filter))) {
        expect(name).toMatch(/^[a-z][a-z0-9._-]*$/)
      }
    }
  })
})

describe('readMarket', () => {
  function fakeReader(rows: Record<string, unknown[]>) {
    const asked: Array<{ kind: string; filtered: boolean }> = []
    return {
      asked,
      reader: {
        async query<T>(kind: string, filter?: unknown): Promise<T[]> {
          asked.push({ kind, filtered: filter !== undefined })
          return (rows[kind] ?? []) as T[]
        },
      },
    }
  }

  it('reads all four kinds and stamps when it read them', async () => {
    const { reader, asked } = fakeReader({})
    const snapshot = await readMarket(reader as never, 1_700_000_000_000)
    expect(asked.map((a) => a.kind).sort()).toEqual(['claim', 'job', 'receipt', 'worker'])
    expect(snapshot.readAt).toBe(1_700_000_000_000)
    expect(snapshot).toEqual({ ...EMPTY_SNAPSHOT, readAt: 1_700_000_000_000 })
  })

  it('puts each kind in its own field rather than guessing from the shape', async () => {
    const { reader } = fakeReader({
      worker: [{ id: 'w1' }],
      job: [{ id: 'j1' }, { id: 'j2' }],
      claim: [{ id: 'c1' }],
      receipt: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
    })
    const snapshot = await readMarket(reader as never, 0)
    expect(snapshot.workers).toHaveLength(1)
    expect(snapshot.jobs).toHaveLength(2)
    expect(snapshot.claims).toHaveLength(1)
    expect(snapshot.receipts).toHaveLength(3)
  })

  it('passes the job filter through and nothing else', async () => {
    const { reader, asked } = fakeReader({})
    await readMarket(reader as never, 0)
    expect(asked.find((a) => a.kind === 'job')?.filtered).toBe(true)
    expect(asked.find((a) => a.kind === 'worker')?.filtered).toBe(false)
    expect(asked.find((a) => a.kind === 'claim')?.filtered).toBe(false)
    expect(asked.find((a) => a.kind === 'receipt')?.filtered).toBe(false)
  })
})

describe('MARKET_POLL_MS', () => {
  it('reads every Arkiv block, regardless of the claim lease', () => {
    expect(MARKET_POLL_MS).toBe(2000)
    expect(MARKET_POLL_MS).toBe(ARKIV_BLOCK_TIME_SEC * 1000)
  })
})
