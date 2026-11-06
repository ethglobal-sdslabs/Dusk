import { joinPieces, type PieceRow } from '../lib/pieces'
import { blockLabel, PromptBlocks } from './PromptBlocks'

export function JoinedAnswers({ rows }: { rows: readonly PieceRow[] }) {
  const jobs = joinPieces(rows)
  if (jobs.length === 0) return null
  return (
    <section className="panel stack" aria-labelledby="joined-answers">
      <h2 id="joined-answers">Split jobs</h2>
      {jobs.map((j) => {
        const done = j.pieces.filter((p) => p.state === 'delivered').length
        return (
          <details key={j.parentId} open>
            <summary>
              <span className="figure">{j.parentId.slice(0, 10)}…</span>{' '}
              {j.complete
                ? `All ${j.count} pieces delivered`
                : j.partial
                  ? `Partial — ${done} of ${j.count} delivered; the rest are refundable`
                  : `${done} of ${j.count} pieces delivered…`}
            </summary>
            <PromptBlocks
              mode="parallel"
              pieces={j.pieces.map((p) => ({ label: p.prompt ? blockLabel(p.prompt) : '', state: p.state }))}
              assembled={j.complete}
            />
            {j.text ? <pre className="figure" style={{ whiteSpace: 'pre-wrap' }}>{j.text}</pre> : <p className="meta">No answers yet.</p>}
          </details>
        )
      })}
    </section>
  )
}
