import type { CSSProperties } from 'react'

export type BlockState = 'idle' | 'waiting' | 'delivered' | 'missing'
export type BlocksMode = 'single' | 'parallel' | 'serial' | 'too-big'

export type BlockPiece = { label: string; state?: BlockState }

export function blockLabel(prompt: string, max = 28): string {
  const lines = prompt.split('\n').map((l) => l.replace(/^\s*(#{1,6}|\d+[.)])\s+/, '').trim()).filter(Boolean)
  const line = lines.at(-1) ?? ''
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

export function blocksSummary(mode: BlocksMode, pieces: readonly BlockPiece[]): string {
  const n = pieces.length
  const done = pieces.filter((p) => p.state === 'delivered').length
  const tracking = pieces.some((p) => p.state && p.state !== 'idle')
  if (mode === 'too-big') return 'Too big for one worker, and nothing to split it on'
  if (mode === 'single') return tracking ? (done ? 'Delivered' : 'Waiting for a worker') : 'One block — one worker runs it'
  const shape = mode === 'serial' ? `${n} pieces, one after another` : `${n} pieces, worked on at once`
  return tracking ? `${shape} — ${done} of ${n} delivered` : shape
}

export function PromptBlocks({
  mode,
  pieces,
  assembled = false,
}: {
  mode: BlocksMode
  pieces: readonly BlockPiece[]
  assembled?: boolean
}) {
  const n = pieces.length
  const split = (mode === 'parallel' || mode === 'serial') && n > 1
  const summary = blocksSummary(mode, pieces)

  return (
    <figure className="blocks-figure">
      <div
        key={`${mode}:${n}`}
        className="blocks"
        data-mode={mode}
        data-split={split || undefined}
        data-assembled={(assembled && split) || undefined}
        role="img"
        aria-label={summary}
      >
        {pieces.map((p, i) => (
          <div key={i} className="block-slot">
            {mode === 'serial' && i > 0 && <span className="blocks-link" aria-hidden />}
            <div
              className="block"
              data-state={p.state ?? 'idle'}
              style={{ '--i': i, '--n': n, '--offset': (n - 1) / 2 - i } as CSSProperties}
            >
              {split && (
                <>
                  <span className="block-shard" data-shard="1" aria-hidden />
                  <span className="block-shard" data-shard="2" aria-hidden />
                  <span className="block-shard" data-shard="3" aria-hidden />
                </>
              )}
              {split && <span className="block-num">{String(i + 1).padStart(2, '0')}</span>}
              <span className="block-label">{p.label || (split ? `Piece ${i + 1}` : 'Your prompt')}</span>
              {p.state === 'delivered' && <span className="block-mark" aria-hidden>✓</span>}
              {p.state === 'missing' && <span className="block-mark" aria-hidden>✕</span>}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="blocks-caption">{summary}</figcaption>
    </figure>
  )
}
