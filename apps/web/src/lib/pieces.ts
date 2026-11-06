import type { Hex } from 'viem'

export type PieceRow = {
  parentId?: Hex
  pieceIndex?: number
  pieceCount?: number
  outputText?: string
  expiresAt: number
  prompt?: string
}

export type PieceState = {
  index: number
  state: 'delivered' | 'waiting' | 'missing'
  text?: string
  prompt?: string
}

export type JoinedJob = {
  parentId: Hex
  count: number
  pieces: PieceState[]
  complete: boolean
  partial: boolean
  text: string
}

export function joinPieces(rows: readonly PieceRow[], now = Date.now()): JoinedJob[] {
  const groups = new Map<string, { parentId: Hex; count: number; byIndex: Map<number, PieceRow> }>()
  for (const r of rows) {
    if (!r.parentId || r.pieceIndex === undefined || !r.pieceCount) continue
    const key = r.parentId.toLowerCase()
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { parentId: r.parentId, count: r.pieceCount, byIndex: new Map() }))
    g.byIndex.set(r.pieceIndex, r)
  }
  return [...groups.values()].map((g) => {
    const pieces: PieceState[] = Array.from({ length: g.count }, (_, index) => {
      const r = g.byIndex.get(index)
      const prompt = r?.prompt !== undefined ? { prompt: r.prompt } : {}
      if (r?.outputText !== undefined) return { index, state: 'delivered', text: r.outputText, ...prompt }
      return { index, state: !r || r.expiresAt <= now ? 'missing' : 'waiting', ...prompt }
    })
    const text = pieces
      .filter((p) => p.state !== 'waiting')
      .map((p) => (p.state === 'delivered' ? p.text! : `[piece ${p.index + 1} not delivered — refundable]`))
      .join('\n\n')
    return {
      parentId: g.parentId,
      count: g.count,
      pieces,
      complete: pieces.every((p) => p.state === 'delivered'),
      partial: pieces.some((p) => p.state === 'missing'),
      text,
    }
  })
}
