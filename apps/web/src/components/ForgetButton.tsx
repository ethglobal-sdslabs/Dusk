'use client'

import { useState } from 'react'

export function ForgetButton(props: { holdsOutput: boolean; onForget: () => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  if (!props.holdsOutput) {
    return (
      <button
        type="button"
        className="ghost"
        title="Removes this row from this browser. The escrow id stays on chain in the Funded log, and this page reads it back from there."
        onClick={props.onForget}
      >
        Forget
      </button>
    )
  }
  if (!confirming) {
    return (
      <button type="button" className="ghost" onClick={() => setConfirming(true)}>
        Forget
      </button>
    )
  }
  return (
    <span className="meta">
      This deletes the saved prompt, answer and Swarm reference, which may be the only copies — the output hash stays
      on chain, but a hash cannot find the output.{' '}
      <button
        type="button"
        className="ghost"
        onClick={() => {
          setConfirming(false)
          props.onForget()
        }}
      >
        Forget anyway
      </button>{' '}
      <button type="button" className="ghost" onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </span>
  )
}
