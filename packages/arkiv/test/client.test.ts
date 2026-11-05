import { describe, expect, it, vi } from 'vitest'
import type { Job } from '@dusk/core'
import { queryWith } from '../src/client'
import { encode } from '../src/codec'

const PAGE = 100

const job = {
  status: 'open',
  model: 'm',
  maxPricePer1kOut: 1n,
  maxTokens: 8,
  inputHash: `0x${'11'.repeat(32)}`,
  escrowId: `0x${'33'.repeat(32)}`,
  trustMode: 'verified',
  visibility: 'public',
  buyerPubkey: `0x${'22'.repeat(33)}`,
  expiresAt: 1_800_000_000_000,
}

function row(i: number): unknown {
  return {
    $key: `0x${String(i).padStart(64, '0')}`,
    $owner: `0x${'7f'.repeat(20)}`,
    ...encode('job', job),
  }
}

const full = (n: number): unknown[] => Array.from({ length: n }, (_, i) => row(i))

function stub(rows: unknown[], skippedPerPage = 0) {
  const offsets: number[] = []
  const fetch = vi.fn()
  const builder: Record<string, unknown> = {}
  let currentOffset = 0
  Object.assign(builder, {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    offset: (n: number) => {
      currentOffset = n
      return builder
    },
    fetch: async () => {
      offsets.push(currentOffset)
      fetch(currentOffset)
      const window = rows.slice(currentOffset, currentOffset + PAGE - skippedPerPage)
      return { entities: window, blockNumber: 100n, skipped: window.length > 0 ? skippedPerPage : 0 }
    },
  })
  const pub = { select: () => builder } as never
  return { pub, offsets }
}

describe('query paging', () => {
  it('returns rows from every page', async () => {
    const { pub } = stub(full(150))
    expect(await queryWith(pub)<Job>('job')).toHaveLength(150)
  })

  it('decodes rows from a later page the same way as the first', async () => {
    const { pub } = stub(full(101))
    const rows = await queryWith(pub)<Job>('job')
    expect(rows).toHaveLength(101)
    expect(rows[100]).toMatchObject({ status: 'open', model: 'm', maxTokens: 8 })
  })

  it('skips a row that does not decode instead of failing the whole query', async () => {
    const ad = { models: ['m'], trustModes: ['verified'], pricePer1kOut: 1n, creditsBucket: '>50%', payout: `0x${'7f'.repeat(20)}` }
    const good = { $key: `0x${'01'.padStart(64, '0')}`, $owner: `0x${'7f'.repeat(20)}`, ...encode('worker', ad as never) }
    const bad = { ...good, $key: `0x${'02'.padStart(64, '0')}`, models: { type: 'bytes', value: '0x7b7b' } }
    const notArray = { ...good, $key: `0x${'03'.padStart(64, '0')}`, models: { type: 'bytes', value: '0x2261626322' } }
    const { pub } = stub([good, bad, notArray])
    const rows = await queryWith(pub)<{ models: string[] }>('worker')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.models).toEqual(['m'])
  })

  it('walks more than two pages', async () => {
    const { pub } = stub(full(207))
    expect(await queryWith(pub)<Job>('job')).toHaveLength(207)
  })

  it('advances the offset by a whole page each time', async () => {
    const { pub, offsets } = stub(full(250))
    await queryWith(pub)<Job>('job')
    expect(offsets).toEqual([0, 100, 200])
  })

  it('stops after a short page, which is the end', async () => {
    const { pub, offsets } = stub(full(3))
    expect(await queryWith(pub)<Job>('job')).toHaveLength(3)
    expect(offsets).toEqual([0])
  })

  it('reads one more page after an exactly-full final page', async () => {
    const { pub, offsets } = stub(full(100))
    expect(await queryWith(pub)<Job>('job')).toHaveLength(100)
    expect(offsets).toEqual([0, 100])
  })

  it('returns an empty array for an empty first page', async () => {
    const { pub } = stub([])
    expect(await queryWith(pub)<Job>('job')).toEqual([])
  })

  it('advances by entities + skipped, not by the rows it got back', async () => {
    const { pub, offsets } = stub(full(250), 10)
    const rows = await queryWith(pub)<Job>('job')
    expect(offsets).toEqual([0, 100, 200])
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })
})
