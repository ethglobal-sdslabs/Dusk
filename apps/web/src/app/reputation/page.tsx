'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { LoadingIndicator } from '../../components/LoadingIndicator'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'
import { WorkspaceHeading } from '../../components/WorkspaceHeading'
import { ScrollableTable } from '../../components/ScrollableTable'
import { WalletName } from '../../components/WalletName'
import { formatCount, formatWei } from '../../lib/market'
import { historySources, readReputation } from '../../lib/past-read'
import { EMPTY_ANSWER_PENALTY, ILLEGAL_PENALTY, LATE_FACTOR, LATE_PENALTY, PASS_BONUS, marketReputation, MIN_RESOLVED, REVIEW_BELOW, standingOf, type SellerRecord, type Standing } from '../../lib/reputation'

type Load = { state: 'reading' } | { state: 'error'; message: string } | { state: 'ready'; records: SellerRecord[]; readAt: number }

const STANDING: Record<Standing, string> = {
  banned: 'Banned',
  trusted: 'Trusted',
  good: 'Good',
  disputed: 'Disputed',
  new: 'New',
}

export default function ReputationPage() {
  const sources = useMemo(() => historySources(), [])
  const [load, setLoad] = useState<Load>({ state: 'reading' })
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!sources) return
    let live = true
    readReputation(sources)
      .then((records) => live && setLoad({ state: 'ready', records, readAt: Date.now() }))
      .catch((e) => live && setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) }))
    return () => {
      live = false
    }
  }, [sources])

  const records = load.state === 'ready' ? load.records : []
  const summary = marketReputation(records)
  const needle = query.trim().toLowerCase()
  const shown = needle ? records.filter((r) => r.worker.toLowerCase().includes(needle) || r.ensName?.toLowerCase().includes(needle)) : records

  return (
    <main className="reputation-board workspace">
      <WorkspaceHeader current="reputation" />
      <div className="ground">
        <div className="page stack">
          <WorkspaceHeading
            page="reputation"
            title="Seller reputation"
            description="Seller track records and scores."
          />

          {!sources && (
            <p className="notice">
              Escrow is not configured. Set its address in config.json and rebuild the app.
            </p>
          )}
          {sources && load.state === 'reading' && <div className="page-loading"><LoadingIndicator label="Loading seller reputation" /></div>}
          {load.state === 'error' && <p className="notice" role="alert">Could not read reputation: {load.message}</p>}

          {load.state === 'ready' && (
            <>
              <dl className="figures history-summary reputation-summary">
                <div>
                  <dt>Sellers</dt>
                  <dd className="figure">{formatCount(summary.sellers)}</dd>
                  <dd className="unit">{formatCount(summary.live)} online now</dd>
                </div>
                <div>
                  <dt>Jobs delivered</dt>
                  <dd className="figure">{formatCount(summary.delivered)}</dd>
                  <dd className="unit">all time</dd>
                </div>
              </dl>

              <section className="stack">
                <div className="reputation-toolbar">
                  <h2 id="reputation-sellers">Sellers</h2>
                  <label className="field reputation-search">
                    <span className="visually-hidden">Find a seller</span>
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8.75" cy="8.75" r="5.75" /><path d="m13 13 4 4" /></svg>
                    <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a seller by name or address…" spellCheck={false} autoComplete="off" />
                  </label>
                </div>

                {records.length === 0 ? (
                  <div className="empty panel">
                    <h2>No sellers yet</h2>
                    <p>Nobody has completed a job yet.</p>
                    <p><Link href="/earn">Start earning <span aria-hidden="true">↗</span></Link></p>
                  </div>
                ) : shown.length === 0 ? (
                  <p className="notice">No seller matches &ldquo;{query}&rdquo;.</p>
                ) : (
                  <ScrollableTable labelledBy="reputation-sellers">
                    <table className="ledger reputation-table" aria-labelledby="reputation-sellers">
                      <thead>
                        <tr>
                          <th scope="col">Seller</th>
                          <th scope="col">Standing</th>
                          <th scope="col" className="num">Score</th>
                          <th scope="col" className="num">Delivered</th>
                          <th scope="col" className="num">Reliability</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((r) => {
                          const standing = standingOf(r)
                          return (
                            <tr key={r.worker}>
                              <th scope="row">
                                <span className="reputation-seller figure"><WalletName address={r.worker} /></span>
                                <span className="reputation-presence" data-live={r.livePricePer1kOut !== null}>
                                  {r.livePricePer1kOut !== null ? `Online · ${formatWei(r.livePricePer1kOut)} wei / 1k out` : 'Offline'}
                                </span>
                                <details className="reputation-detail">
                                  <summary>More details</summary>
                                  <dl>
                                    <div><dt>Challenges</dt><dd>{formatCount(r.challenged)}</dd></div>
                                    <div><dt>Median delivery</dt><dd>{r.medianDeliverMs === null ? '—' : duration(r.medianDeliverMs)}</dd></div>
                                    <div><dt>Avg latency · 7 days</dt><dd>{r.avgLatencyMs === null ? '—' : `${(r.avgLatencyMs / 1000).toFixed(1)}s`}</dd></div>
                                    <div><dt>Earned</dt><dd>{formatWei(r.earnedWei)} wei</dd></div>
                                    <div><dt>Last active</dt><dd>{ago(r.lastActive, load.readAt)}</dd></div>
                                  </dl>
                                </details>
                              </th>
                              <td>
                                <span className="reputation-standing" data-standing={standing}>{STANDING[standing]}</span>
                                {r.moderationStatus === 'unknown' && <span className="reputation-sub">Ban status unavailable</span>}
                              </td>
                              <td className="num figure" title={`${r.badAnswers} bad answers · ${r.illegal} misconduct findings`}>
                                {r.score}
                                <span className="reputation-sub">
                                  {r.publishedReputationStatus === 'verified' ? 'Verified checkpoint' :
                                    r.publishedReputationStatus === 'stale' ? 'Estimate · stale checkpoint' : 'Estimate'}
                                </span>
                              </td>
                              <td className="num figure">
                                {formatCount(r.delivered)}
                                {r.pending > 0 && <span className="reputation-sub">{formatCount(r.pending)} pending</span>}
                              </td>
                              <td className="num figure">{r.reliability === null ? '—' : percent(r.reliability)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </ScrollableTable>
                )}
                <p className="meta">
                  Ranked by jobs completed.
                </p>
              </section>

              <details className="panel reputation-rules">
                <summary id="reputation-how">How standing works</summary>
                <ul>
                  <li><span className="reputation-standing" data-standing="banned">Banned</span>The authorized revoker recorded a ban in the on-chain identity controller. New work is refused; existing refunds and valid settlements remain available.</li>
                  <li><span className="reputation-standing" data-standing="new">New</span>Fewer than {MIN_RESOLVED} resolved jobs.</li>
                  <li><span className="reputation-standing" data-standing="trusted">Trusted</span>95%+ of jobs completed cleanly.</li>
                  <li><span className="reputation-standing" data-standing="good">Good</span>80% to 95%.</li>
                  <li><span className="reputation-standing" data-standing="disputed">Disputed</span>Under 80%, or an official score below the revocation threshold.</li>
                </ul>
                <p className="meta">
                  Every seller starts at 100, and canary jobs test them every few minutes. Each delivered canary adds {PASS_BONUS} (up to 100);
                  one delivered more than {LATE_FACTOR}× slower than the market&rsquo;s typical canary costs {LATE_PENALTY} instead. An empty
                  answer, or a canary claimed and never delivered, costs {EMPTY_ANSWER_PENALTY}. Cheating costs {ILLEGAL_PENALTY}. What an answer
                  says is not judged. Official scores come from company-authorized ENS checkpoints; users cannot edit them.
                  When decentralized enforcement is configured, the revoker contract removes membership below {REVIEW_BELOW} after at least {MIN_RESOLVED} resolved jobs.
                  Estimates shown without a verified checkpoint have no authority to revoke anyone.
                </p>
              </details>
            </>
          )}
        </div>
      </div>
    </main>
  )
}

function percent(x: number): string {
  return `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)}%`
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function ago(ms: number, now: number): string {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86_400)
  return d === 1 ? '1 day ago' : `${d} days ago`
}
