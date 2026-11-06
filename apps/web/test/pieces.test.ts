import { describe, expect, it } from 'vitest'
import { joinPieces } from '../src/lib/pieces'

const P = `0x${'5a'.repeat(32)}` as const
const row = (pieceIndex: number, over: object = {}) => ({ parentId: P, pieceIndex, pieceCount: 3, expiresAt: 10_000, ...over })

describe('joinPieces', () => {
  it('joins delivered answers in piece order, whatever order they arrived in', () => {
    const [j] = joinPieces([row(2, { outputText: 'c' }), row(0, { outputText: 'a' }), row(1, { outputText: 'b' })], 0)
    expect(j).toMatchObject({ complete: true, partial: false, text: 'a\n\nb\n\nc' })
  })

  it('is still waiting, not partial, while an undelivered piece has time left', () => {
    const [j] = joinPieces([row(0, { outputText: 'a' }), row(1), row(2, { outputText: 'c' })], 0)
    expect(j).toMatchObject({ complete: false, partial: false })
    expect(j!.pieces[1]!.state).toBe('waiting')
  })

  it('marks the result partial once a piece expired undelivered, and says where the gap is', () => {
    const [j] = joinPieces([row(0, { outputText: 'a' }), row(1), row(2, { outputText: 'c' })], 20_000)
    expect(j).toMatchObject({ complete: false, partial: true })
    expect(j!.text).toBe('a\n\n[piece 2 not delivered — refundable]\n\nc')
  })

  it('ignores ordinary jobs', () => {
    expect(joinPieces([{ expiresAt: 1, outputText: 'x' }], 0)).toEqual([])
  })
})
