export function WorkerStatus(props: {
  ticks: number
  intervalSeconds: number
  note: string | null
  loopError: string | null
  readError: string | null
  budget: { figure: string; note: string }
}) {
  return (
    <section className="stack" aria-labelledby="running">
      <h2 id="running">Status</h2>
      {props.note !== null && <p className="worker-status-indicator" role="status">{props.note}</p>}
      {props.note === null && props.readError === null && props.loopError === null && (
        <p className="worker-status-indicator" data-state={props.ticks > 0 ? 'running' : 'starting'} role="status">
          {props.ticks > 0 ? 'Worker running' : 'Starting worker…'}
        </p>
      )}
      {props.readError !== null && <p className="notice" role="status">{props.readError}</p>}
      {props.loopError !== null && <p className="notice" role="alert">Something went wrong: {props.loopError} Retrying.</p>}
      <details className="worker-details">
        <summary>Worker details</summary>
        <dl className="figures">
          <div>
            <dt>Checks</dt>
            <dd className="figure">{props.ticks}</dd>
            <dd className="unit">every {props.intervalSeconds}s</dd>
          </div>
          <div>
            <dt>Arkiv quota used</dt>
            <dd className="figure">{props.budget.figure}</dd>
            <dd className="unit">this month</dd>
          </div>
        </dl>
        <p className="meta">Keep this tab in front — background tabs run slower and claim fewer jobs.</p>
      </details>
    </section>
  )
}
