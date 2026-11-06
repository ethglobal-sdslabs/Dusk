'use client'

import Link from 'next/link'
import { DEFAULT_IMAGE_MODELS, isImageModel, jobAmountWei } from '@dusk/core'
import { browserReadConfig } from '../../lib/config'
import { useLiveEntities, type MarketSnapshot } from '../../lib/arkiv'
import {
  claimForJob,
  demandRows,
  formatCount,
  formatWei,
  isEmptyMarket,
  marketSummary,
  marketView,
  supplyRows,
} from '../../lib/market'
import { LoadingIndicator } from '../../components/LoadingIndicator'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'
import { WorkspaceHeading } from '../../components/WorkspaceHeading'
import { ScrollableTable } from '../../components/ScrollableTable'
import { WalletName } from '../../components/WalletName'
import { NavIcon } from '../../components/NavIcon'

export default function MarketPage() {
  const live = useLiveEntities()

  const snapshot: MarketSnapshot = {
    workers: live.workers,
    jobs: live.jobs,
    claims: live.claims,
    receipts: live.receipts,
    readAt: live.readAt,
  }
  const summary = marketSummary(snapshot)
  const openJobs = demandRows(snapshot)
  const hasAnswer = live.readAt > 0
  const cheapestPrice = !hasAnswer || summary.cheapestPer1kOut === null ? '—' : formatWei(summary.cheapestPer1kOut)
  const view = marketView({ hasAnswer, error: live.error, empty: isEmptyMarket(snapshot) })

  return (
    <main className="market-observatory workspace">
      <WorkspaceHeader current="market" />

      <div className="ground">
        <div className="page stack">
          <WorkspaceHeading page="market" id="market-data" title={<>The <em>inference</em> market</>} description="Live offers and open jobs." actions={<><Link href="/buy">Post a job</Link><Link href="/earn">Offer credits</Link></>} />
          <div className="market-read-status" role="status" data-state={live.error ? 'unavailable' : hasAnswer ? 'ready' : 'reading'}>{!hasAnswer && !live.error ? <LoadingIndicator label="Loading market" /> : <><i aria-hidden="true" />{live.error ? hasAnswer ? 'Showing the last update' : 'Waiting for connection' : 'Live market'}</>}{live.readAt > 0 && <span>Updated {utcTime(live.readAt)} UTC</span>}</div>

          <dl className="figures market-summary" data-long-price={cheapestPrice.length > 9}>
            <div>
              <dt>Live supply</dt>
              <dd className="figure">{hasAnswer ? formatCount(summary.liveWorkers) : '—'}</dd>
              <dd className="unit">{summary.liveWorkers === 1 ? 'holder serving jobs' : 'holders serving jobs'}</dd>
            </div>
            <div>
              <dt>Cheapest</dt>
              <dd className="figure money market-price">{cheapestPrice}</dd>
              <dd className="unit">wei per 1,000 tokens</dd>
            </div>
            <div>
              <dt>Open jobs</dt>
              <dd className="figure">{hasAnswer ? formatCount(summary.openJobs) : '—'}</dd>
              <dd className="unit">
                {!hasAnswer
                  ? 'not read yet'
                  : summary.activeClaims === 0
                    ? 'none claimed yet'
                    : `${formatCount(summary.activeClaims)} being worked on`}
              </dd>
            </div>
          </dl>

          {live.error !== null && (
            <p className="notice" role="status">
              {live.error}
            </p>
          )}

          {view === 'empty' && <EmptyMarket />}
          {view === 'market' && (
            <>
              <Supply snapshot={snapshot} />
              <Demand snapshot={snapshot} openJobs={openJobs} />
            </>
          )}

        </div>
      </div>
    </main>
  )
}

function EmptyMarket() {
  return (
    <div className="empty panel">
      <h2>The market is quiet</h2>
      <p>Nothing live right now. Post a job or offer your credits.</p>
      <div className="market-entry-paths">
        <Link href="/buy"><NavIcon destination="buy" /><div><h3>Bring a task</h3><p>Set your model, budget, and deadline.</p><span>Post a job <span aria-hidden="true">↗</span></span></div></Link>
        <Link href="/earn"><NavIcon destination="earn" /><div><h3>Bring your credits</h3><p>Let a worker turn spare capacity into results.</p><span>Offer credits <span aria-hidden="true">↗</span></span></div></Link>
      </div>
    </div>
  )
}

function Supply({ snapshot }: { snapshot: MarketSnapshot }) {
  if (snapshot.workers.length === 0) {
    return (
      <section className="stack">
        <h2>Supply</h2>
        <p>No sellers online right now.</p>
      </section>
    )
  }

  return (
    <section className="stack">
      <h2 id="market-supply">Supply</h2>
      <ScrollableTable labelledBy="market-supply">
        <table className="ledger" aria-labelledby="market-supply">
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col" className="num">
                Price per 1k out
              </th>
              <th scope="col" className="num">
                Models
              </th>
              <th scope="col" className="num">
                Credits left
              </th>
            </tr>
          </thead>
          <tbody>
            {supplyRows(snapshot).map((worker) => (
              <tr key={worker.id}>
                <th scope="row" className="figure">
                  {worker.owner ? <WalletName address={worker.owner} /> : shortId(worker.id)}
                </th>
                <td className="num figure money">{formatWei(worker.pricePer1kOut)}</td>
                <td className="num figure">{formatCount(worker.models.length)}</td>
                <td className="num figure">{worker.creditsBucket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollableTable>
      <p className="meta">Credits left is a rough range, not an exact balance.</p>
    </section>
  )
}

function marketImageModels(): readonly string[] {
  try {
    return browserReadConfig().og.imageModels
  } catch {
    return DEFAULT_IMAGE_MODELS
  }
}

function Demand({ snapshot, openJobs }: { snapshot: MarketSnapshot; openJobs: MarketSnapshot['jobs'] }) {
  const imageModels = marketImageModels()
  if (openJobs.length === 0) {
    return (
      <section className="stack">
        <h2>Open jobs</h2>
        <p>No open jobs right now.</p>
      </section>
    )
  }

  return (
    <section className="stack">
      <h2 id="market-jobs">Open jobs</h2>
      <ScrollableTable labelledBy="market-jobs">
        <table className="ledger" aria-labelledby="market-jobs">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Buyer</th>
              <th scope="col">Model</th>
              <th scope="col" className="num">
                Max price per 1k out
              </th>
              <th scope="col" className="num">
                Max output
              </th>
              <th scope="col" className="num">
                Escrowed
              </th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {openJobs.map((job) => {
              const claim = claimForJob(snapshot, job.id)
              return (
                <tr key={job.id}>
                  <th scope="row" className="figure">
                    {shortId(job.id)}
                  </th>
                  <td className="figure">{job.owner ? <WalletName address={job.owner} /> : '—'}</td>
                  <td>{job.model}</td>
                  <td className="num figure money">{formatWei(job.maxPricePer1kOut)}</td>
                  <td className="num figure">
                    {isImageModel(job.model, imageModels) ? '1 image' : formatCount(job.maxTokens)}
                  </td>
                  <td className="num figure money">{formatWei(jobAmountWei(job, job.maxPricePer1kOut, imageModels))}</td>
                  <td>{claim ? <span className="warm">claimed</span> : 'waiting'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollableTable>
      <p className="meta">Escrowed is the most the buyer will pay, in wei. If a worker stops, the job goes back to waiting.</p>
    </section>
  )
}

function shortId(id: string): string {
  const bare = id.startsWith('0x') ? id.slice(2) : id
  return bare.length <= 10 ? bare : `${bare.slice(0, 6)}…${bare.slice(-4)}`
}

function utcTime(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
}
