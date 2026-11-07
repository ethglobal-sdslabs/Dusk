'use client'

import { JoinedAnswers } from '../../components/JoinedAnswers'
import { loadLedger } from '../../lib/history'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isAddress, type Address } from 'viem'
import { WalletName } from '../../components/WalletName'
import { LoadingIndicator } from '../../components/LoadingIndicator'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'
import { WorkspaceHeading } from '../../components/WorkspaceHeading'
import { ScrollableTable } from '../../components/ScrollableTable'
import { creditDayStart, DEFAULT_IMAGE_MODELS, isImageModel } from '@dusk/core'
import { SwarmImage } from '../../components/SwarmImage'
import { ForgetButton } from '../../components/ForgetButton'
import { dropRow } from '../../lib/history'
import { browserClock, browserPricing, browserReadConfig } from '../../lib/config'
import { fetchPrefill, type Prefill } from '../../lib/prefill'
import { useWallet } from '../../lib/wallet'
import { formatCount, formatWei } from '../../lib/market'
import {
  formatUsd,
  orderTotals,
  saleTotals,
  savingsOf,
  savingsWindows,
  profitWindows,
  type ProfitTotals,
  type OrderRow,
  type OrderTotals,
  type OrderStatus,
  type Pricing,
  type SaleRow,
  type SaleStatus,
} from '../../lib/past'
import { historySources, readOrders, readSales } from '../../lib/past-read'

type View = 'orders' | 'sales'

type Load =
  | { state: 'idle' }
  | { state: 'reading' }
  | { state: 'error'; message: string }
  | { state: 'orders'; rows: OrderRow[]; address: Address }
  | { state: 'sales'; rows: SaleRow[]; address: Address }

export default function HistoryPage() {
  const sources = useMemo(() => historySources(), [])
  const pricing = useMemo(() => {
    try {
      return { value: browserPricing(), error: null }
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [])
  const [view, setView] = useState<View>('orders')
  const [fetched, setPrefill] = useState<Prefill | null>(null)
  const buyerWallet = useWallet('buyer')
  const workerWallet = useWallet('worker')
  const prefill = useMemo<Prefill | null>(() => {
    if (!fetched) return null
    const buyerAddress = fetched.buyerAddress ?? (buyerWallet.address as Address | null) ?? undefined
    const workerAddress = fetched.workerAddress ?? (workerWallet.address as Address | null) ?? undefined
    return { ...fetched, ...(buyerAddress ? { buyerAddress } : {}), ...(workerAddress ? { workerAddress } : {}) }
  }, [fetched, buyerWallet.address, workerWallet.address])
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const request = useRef(0)
  async function show(nextView: View, who: string) {
    if (!sources || !isAddress(who, { strict: false })) return
    const mine = ++request.current
    setLoad({ state: 'reading' })
    window.history.replaceState(null, '', `?view=${nextView}`)
    try {
      const result: Load =
        nextView === 'orders'
          ? { state: 'orders', rows: await readOrders(sources, who as Address), address: who as Address }
          : { state: 'sales', rows: await readSales(sources, who as Address), address: who as Address }
      if (mine === request.current) setLoad(result)
    } catch (e) {
      if (mine === request.current) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setView(params.get('view') === 'sales' ? 'sales' : 'orders')
    let cancelled = false
    void fetchPrefill().then((from) => { if (!cancelled) setPrefill(from) })
    return () => { cancelled = true; request.current++ }
  }, [])

  useEffect(() => {
    if (!prefill) return
    const address = view === 'sales' ? prefill.workerAddress : prefill.buyerAddress
    if (!address) { request.current++; setLoad({ state: 'idle' }); return }
    void show(view, address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, view])

  function switchView(next: View) {
    if (next !== view) { request.current++; setLoad({ state: 'idle' }); setView(next) }
  }

  return (
    <main className="history-ledger workspace">
      <WorkspaceHeader current="history" />
      <div className="ground">
        <div className="page stack">
          <WorkspaceHeading
            page="history"
            title="Your history"
            description="See the orders and sales for your configured wallets."
          />

          {!sources ? (
            <p className="notice">
              Escrow is not configured. Set <span className="figure">escrow.address</span> in config.json and restart.
            </p>
          ) : (
            <section className="history-lookup">
              <div className="history-tabs" role="tablist" aria-label="Which history" data-view={view}>
                <button type="button" role="tab" aria-selected={view === 'orders'} onClick={() => switchView('orders')}>
                  Orders
                </button>
                <button type="button" role="tab" aria-selected={view === 'sales'} onClick={() => switchView('sales')}>
                  Sales
                </button>
              </div>
              {prefill && !(view === 'sales' ? prefill.workerAddress : prefill.buyerAddress) && (
                <p className="notice">{buyerWallet.local === false
                  ? <>Add a wallet key on the <Link href={view === 'sales' ? '/earn' : '/buy'}>{view === 'sales' ? 'Earn' : 'Buy'}</Link> page to see this history.</>
                  : <>Add {view === 'sales' ? 'worker.address' : 'buyer.address'} to config.json to see this history.</>}</p>
              )}
            </section>
          )}

          {load.state !== 'idle' && <div className="history-results stack" key={`${view}-${load.state}`}>
          {(load.state === 'orders' || load.state === 'sales') && (
            <p className="meta">Wallet <WalletName address={load.address} className="figure" /></p>
          )}
          {load.state === 'reading' && <div className="page-loading"><LoadingIndicator label="Loading history" /></div>}
          {load.state === 'error' && <p className="notice" role="alert">Could not read this history: {load.message}</p>}
          {load.state === 'orders' && (
            <Orders
              rows={load.rows}
              pricing={pricing.value}
              pricingError={pricing.error}
              ttlSec={sources?.receiptTtlSec ?? 0}
              onForget={(escrowId) => {
                dropRow(load.address, escrowId)
                void show('orders', load.address)
              }}
            />
          )}
          {load.state === 'orders' && <JoinedAnswers rows={loadLedger(load.address)} />}
          {load.state === 'sales' && <Sales rows={load.rows} ttlSec={sources?.receiptTtlSec ?? 0} />}
          </div>}
        </div>
      </div>
    </main>
  )
}

const ORDER_STATUS: Record<OrderStatus, string> = {
  delivered: 'Delivered',
  'in-challenge': 'Delivered · awaiting settlement',
  waiting: 'Waiting for a worker',
  refundable: 'Expired · refundable',
  refunded: 'Refunded',
  unknown: 'Unknown',
}

const SALE_STATUS: Record<SaleStatus, string> = {
  collected: 'Collected',
  awaiting: 'Ready to collect',
  refunded: 'Refunded',
  unknown: 'Unknown',
}

function Orders({
  rows,
  pricing,
  pricingError,
  ttlSec,
  onForget,
}: {
  rows: OrderRow[]
  pricing: Pricing | null
  pricingError: string | null
  ttlSec: number
  onForget: (escrowId: OrderRow['escrowId']) => void
}) {
  const totals = orderTotals(rows, pricing)
  if (rows.length === 0) return <Empty what="orders" />
  return (
    <>
      <SavingsBox rows={rows} pricing={pricing} />
      <dl className="figures history-summary">
        <div>
          <dt>Orders</dt>
          <dd className="figure">{formatCount(totals.orders)}</dd>
          <dd className="unit">{formatCount(totals.delivered)} delivered · {formatCount(totals.refunded)} refunded</dd>
        </div>
        <div>
          <dt>Spent</dt>
          <dd className="figure money">{formatWei(totals.spentWei)}</dd>
          <dd className="unit">wei, excluding refunds</dd>
        </div>
      </dl>

      <section className="stack">
        <h2 id="history-orders">Past orders</h2>
        <ScrollableTable labelledBy="history-orders">
          <table className="ledger" aria-labelledby="history-orders">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Order</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">Tokens in / out</th>
                <th scope="col">Output hash</th>
                <th scope="col" className="num">Paid (wei)</th>
                <th scope="col" className="num">Saved</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const saving = savingsOf(row, pricing)
                return (
                  <tr key={row.escrowId}>
                    <td className="figure">{utcDate(row.at)}</td>
                    <th scope="row" className="figure" title={row.escrowId}>{shortId(row.escrowId)}</th>
                    <td title={row.receiptFrom === 'saved' ? 'From your own saved copy — this receipt has expired off Arkiv' : undefined}>
                      {row.receipt?.modelServed ?? '—'}
                      {row.receiptFrom === 'saved' && <span className="meta"> (saved)</span>}
                    </td>
                    <td className="num figure">{row.receipt ? `${formatCount(row.receipt.tokensIn)} / ${formatCount(row.receipt.tokensOut)}` : '—'}</td>
                    <td className="figure" title={row.outputHash}>{row.outputHash ? shortId(row.outputHash) : '—'}</td>
                    <td className="num figure money">{formatWei(row.paidWei)}</td>
                    <td className="num figure money" title={saving ? `List ${formatUsd(saving.listUsd)} − paid ${formatUsd(saving.paidUsd)}` : undefined}>
                      {saving ? formatUsd(saving.savedUsd) : '—'}
                    </td>
                    <td><span className="history-status" data-status={row.status}>{ORDER_STATUS[row.status]}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </ScrollableTable>
        <p className="meta">
          Model and tokens are only kept for {days(ttlSec)}, so older orders show &ldquo;—&rdquo; unless marked{' '}
          <span className="meta">(saved)</span> in this browser.
          {pricing && <> Saved is an estimate against the 0G list price.</>}
        </p>
        <Deliveries rows={rows} onForget={onForget} />
        {pricingError && <p className="notice">{pricingError}</p>}
      </section>
    </>
  )
}

function Deliveries({ rows, onForget }: { rows: readonly OrderRow[]; onForget: (escrowId: OrderRow['escrowId']) => void }) {
  let imageModels: readonly string[] = DEFAULT_IMAGE_MODELS
  let downloadUrl: string | undefined
  try {
    const c = browserReadConfig()
    imageModels = c.og.imageModels
    downloadUrl = c.swarm.downloadEndpoint
  } catch {
  }
  const delivered = rows.filter((row) => row.outputRef !== undefined || row.outputText !== undefined || row.savedHere)
  if (delivered.length === 0) return null
  return (
    <details className="setup-details history-deliveries">
      <summary>
        {formatCount(delivered.length)} {delivered.length === 1 ? 'order' : 'orders'} with a prompt or an output you can
        still reach
      </summary>
      <ul className="posted-list">
        {delivered.map((row) => (
          <li key={row.escrowId}>
            <span className="figure full-id">{row.escrowId}</span>
            {row.outputHash && <span className="meta figure full-id">output hash {row.outputHash}</span>}
            {row.outputRef && <span className="meta figure full-id">on Swarm at {row.outputRef}</span>}
            {row.outputRef && row.receipt && isImageModel(row.receipt.modelServed, imageModels) && (
              <SwarmImage swarmRef={row.outputRef} downloadUrl={downloadUrl} alt={`Delivered image for ${row.escrowId}`} lazy />
            )}
            {row.prompt !== undefined && <span className="meta">asked: {row.prompt === '' ? '(no text)' : row.prompt}</span>}
            {row.attachmentNames && (
              <span className="meta">attached: {row.attachmentNames.join(', ')}</span>
            )}
            {row.outputText !== undefined && (
              <details>
                <summary>The answer, from this browser&rsquo;s saved copy</summary>
                <pre className="output figure">{row.outputText}</pre>
              </details>
            )}
            {row.savedHere && (
              <ForgetButton
                holdsOutput={row.outputText !== undefined || row.outputRef !== undefined}
                onForget={() => onForget(row.escrowId)}
              />
            )}
          </li>
        ))}
      </ul>
      <p className="meta">
        Hash the blob at that reference and you get the output hash above, which is the hash the escrow committed to.
        The hash alone cannot find the blob — that is what the reference is for, and past the receipt&rsquo;s{' '}
        TTL it survives only here.
      </p>
    </details>
  )
}

function SavingsBox({ rows, pricing }: { rows: OrderRow[]; pricing: Pricing | null }) {
  const clock = useMemo(() => browserClock(), [])
  const now = new Date()
  const dayStart = creditDayStart(clock, now)
  const { today, overall } = savingsWindows(rows, pricing, dayStart.getTime())
  const since = clock.resetAt === 'daily-utc-midnight' ? 'since 00:00 UTC' : `since ${utcTime(dayStart.getTime())} UTC`
  const note = (t: OrderTotals) =>
    t.savedUsd === null
      ? 'pricing not configured'
      : t.delivered === 0
        ? 'no delivered orders'
        : `${formatCount(t.savingsCounted)} of ${formatCount(t.delivered)} delivered ${t.delivered === 1 ? 'order' : 'orders'}`
  return (
    <section className="history-savings" aria-labelledby="history-savings-title">
      <h2 id="history-savings-title">Saved vs 0G list price <span>estimate</span></h2>
      <dl>
        <div>
          <dt>Today <span>{since}</span></dt>
          <dd className="figure money">{today.savedUsd === null ? '—' : formatUsd(today.savedUsd)}</dd>
          <dd className="unit">{note(today)}</dd>
        </div>
        <div>
          <dt>Overall</dt>
          <dd className="figure money">{overall.savedUsd === null ? '—' : formatUsd(overall.savedUsd)}</dd>
          <dd className="unit">{note(overall)}</dd>
        </div>
      </dl>
    </section>
  )
}

function ProfitBox({ rows }: { rows: SaleRow[] }) {
  const clock = useMemo(() => browserClock(), [])
  const dayStart = creditDayStart(clock, new Date())
  const { today, overall } = profitWindows(rows, dayStart.getTime())
  const since = clock.resetAt === 'daily-utc-midnight' ? 'since 00:00 UTC' : `since ${utcTime(dayStart.getTime())} UTC`
  const note = (t: ProfitTotals) =>
    t.jobs === 0
      ? 'no jobs'
      : `wei from ${formatCount(t.jobs)} ${t.jobs === 1 ? 'job' : 'jobs'}${t.unknownAmounts > 0 ? ` · ${formatCount(t.unknownAmounts)} unknown` : ''}`
  return (
    <section className="history-savings" aria-labelledby="history-profit-title">
      <h2 id="history-profit-title">Profit</h2>
      <dl>
        <div>
          <dt>Today <span>{since}</span></dt>
          <dd className="figure money">{formatWei(today.earnedWei)}</dd>
          <dd className="unit">{note(today)}</dd>
        </div>
        <div>
          <dt>Overall</dt>
          <dd className="figure money">{formatWei(overall.earnedWei)}</dd>
          <dd className="unit">{note(overall)}</dd>
        </div>
      </dl>
    </section>
  )
}

function Sales({ rows, ttlSec }: { rows: SaleRow[]; ttlSec: number }) {
  const totals = saleTotals(rows)
  if (rows.length === 0) return <><ProfitBox rows={rows} /><Empty what="sales" /></>
  return (
    <>
      <ProfitBox rows={rows} />
      <dl className="figures history-summary">
        <div>
          <dt>Jobs sold</dt>
          <dd className="figure">{formatCount(totals.sales)}</dd>
          <dd className="unit">{formatCount(totals.tokensOut)} output tokens</dd>
        </div>
        <div>
          <dt>Collected</dt>
          <dd className="figure money">{formatWei(totals.collectedWei)}</dd>
          <dd className="unit">wei</dd>
        </div>
        <div>
          <dt>Awaiting</dt>
          <dd className="figure money">{formatWei(totals.awaitingWei)}</dd>
          <dd className="unit">{totals.unknownAmounts > 0 ? `wei · ${formatCount(totals.unknownAmounts)} unknown` : 'wei, ready to collect'}</dd>
        </div>
      </dl>

      <section className="stack">
        <h2 id="history-sales">Sell history</h2>
        <ScrollableTable labelledBy="history-sales">
          <table className="ledger" aria-labelledby="history-sales">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Job</th>
                <th scope="col">Model</th>
                <th scope="col" className="num">Tokens out</th>
                <th scope="col" className="num">Earned (wei)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.escrowId}>
                  <td className="figure">{utcDate(row.at)}</td>
                  <th scope="row" className="figure" title={row.escrowId}>{shortId(row.escrowId)}</th>
                  <td>{row.receipt?.modelServed ?? '—'}</td>
                  <td className="num figure">{row.receipt ? formatCount(row.receipt.tokensOut) : '—'}</td>
                  <td className="num figure money">{row.earnedWei === null ? '—' : formatWei(row.earnedWei)}</td>
                  <td><span className="history-status" data-status={row.status}>{SALE_STATUS[row.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollableTable>
        <p className="meta">
          Model and tokens are only kept for {days(ttlSec)}, so older sales show &ldquo;—&rdquo;.
        </p>
      </section>
    </>
  )
}

function Empty({ what }: { what: View }) {
  return (
    <div className="empty panel">
      <h2>No {what} yet</h2>
      <p>
        {what === 'orders'
          ? 'This wallet has not posted any jobs.'
          : 'This wallet has not completed any jobs.'}
      </p>
      <p>
        <Link href={what === 'orders' ? '/buy' : '/earn'}>{what === 'orders' ? 'Post a job' : 'Start earning'} <span aria-hidden="true">↗</span></Link>
      </p>
    </div>
  )
}

function days(ttlSec: number): string {
  const d = Math.round(ttlSec / 86_400)
  return d === 1 ? '1 day' : `${d} days`
}

function shortId(id: string): string {
  const bare = id.startsWith('0x') ? id.slice(2) : id
  return bare.length <= 10 ? bare : `${bare.slice(0, 6)}…${bare.slice(-4)}`
}

function utcDate(ms: number): string {
  if (ms === 0) return '—'
  const at = new Date(ms)
  const month = at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${month} ${at.getUTCDate()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

function utcTime(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
}
