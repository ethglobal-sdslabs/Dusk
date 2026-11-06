'use client'

import { redactKeyish } from '../../lib/worker-browser'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'

export default function EarnError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="space-transaction workspace">
      <WorkspaceHeader current="earn" />
      <div className="ground">
        <div className="page stack">
          <h1 id="start">Earning stopped</h1>
          <p>Try again to resume. Existing claims expire automatically; committed payments remain collectible.</p>
          <p className="notice" role="alert">
            {redactKeyish(error.message || 'No message came with it.')}
          </p>
          <p>
            <button type="button" onClick={reset}>
              Start over
            </button>
          </p>
        </div>
      </div>
    </main>
  )
}
