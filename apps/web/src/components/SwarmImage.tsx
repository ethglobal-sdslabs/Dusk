'use client'

import { LoadingIndicator } from './LoadingIndicator'
import type { SwarmRef } from '@dusk/core'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { useEffect, useMemo, useState } from 'react'
import { loadSwarmImage } from '../lib/image-view'

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'shown'; url: string } | { kind: 'error'; message: string }

export function SwarmImage(props: {
  swarmRef: SwarmRef
  downloadUrl?: string
  alt: string
  lazy?: boolean
}): React.JSX.Element {
  const base = (props.downloadUrl ?? DEFAULT_DOWNLOAD_URL).replace(/\/+$/, '')
  const swarm = useMemo(() => createSwarmStore({ uploadUrl: DEFAULT_UPLOAD_URL, downloadUrl: base }), [base])
  const [wanted, setWanted] = useState(!props.lazy)
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    let url: string | undefined
    setState({ kind: 'loading' })
    loadSwarmImage(swarm, props.swarmRef).then(
      (r) => {
        url = r.url
        if (cancelled) URL.revokeObjectURL(r.url)
        else setState({ kind: 'shown', url: r.url })
      },
      (e: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [wanted, swarm, props.swarmRef])

  const href = `${base}/bzz/${props.swarmRef}/`
  return (
    <figure className="swarm-image stack">
      {!wanted ? (
        <p>
          <button type="button" onClick={() => setWanted(true)}>
            Show picture
          </button>
        </p>
      ) : state.kind === 'shown' ? (
        <img src={state.url} alt={props.alt} style={{ maxWidth: '100%', height: 'auto', borderRadius: 6 }} />
      ) : state.kind === 'error' ? (
        <p className="notice" role="alert">
          Could not load the picture ({state.message}).
        </p>
      ) : (
        <LoadingIndicator label="Fetching the picture from Swarm" />
      )}
      <figcaption className="meta">
        On Swarm:{' '}
        <a href={href} target="_blank" rel="noreferrer" className="figure">
          {props.swarmRef.slice(0, 12)}…
        </a>
      </figcaption>
    </figure>
  )
}
