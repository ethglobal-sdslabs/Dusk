'use client'

import { LoadingIndicator } from '../../components/LoadingIndicator'
import { WalletName } from '../../components/WalletName'
import { creditsBucketOf, DEFAULT_IMAGE_MODELS, isImageModel, parseCreditBalance, type CreditsBucket, type ModelInfo, type WorkerAd } from '@dusk/core'
import { fetchCatalog } from '@dusk/og'
import { ModelSelect } from '../../components/ModelSelect'
import { ListPriceNote } from '../../components/ListPriceNote'
import { listPrice } from '../../lib/list-price'
import { clearSession, loadSession, saveSession, SESSION_KEY, sessionFrom, type EarnSession } from '../../lib/earn-session'
import { browserLocks, holdLeadership, WORKER_LOCK } from '../../lib/earn-lock'

import { EnsIdentity } from '../../components/EnsIdentity'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'
import { WorkspaceHeading } from '../../components/WorkspaceHeading'
import { WorkerStatus } from '../../components/WorkerStatus'
import Link from 'next/link'
import type { ArkivQuota } from '@dusk/arkiv'
import { createArkivReader } from '@dusk/arkiv'
import { forgetAd, tick, type TickResult } from '@dusk/worker/loop'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MARKET_POLL_MS, readErrorOf, retryDelayMs } from '../../lib/arkiv'
import { browserArkivAccessKey, browserConfig, browserModels } from '../../lib/config'
import { formatCountdown } from '../../lib/countdown'
import {
  creditsView,
  dealsToRead,
  earningsOf,
  EMPTY_EARN_SNAPSHOT,
  feedRows,
  mergeDeal,
  quotaView,
  rereadDue,
  readEarn,
  reputationView,
  tickNote,
  type DealRow,
  type EarnSnapshot,
  type FeedRow,
} from '../../lib/earn'
import { formatWei } from '../../lib/market'
import { fetchPrefill, type Prefill } from '../../lib/prefill'
import { useWallet } from '../../lib/wallet'
import { WalletKeyField } from '../../components/WalletKeyField'
import { useRequiredIdentity } from '../../lib/use-required-identity'
import {
  buildBrowserWorker,
  installKeyGuard,
  parseOgKey,
  redactKeyish,
  type BrowserWorker,
  type ParsedOgKey,
} from '../../lib/worker-browser'
import { shortHash } from '../../lib/buy-receipt'

const TICK_MS = 5_000

const PRIVATE_RESIDUAL = 'Private jobs hide the prompt from the public, not from you. Your claims are public.'

export default function EarnPage() {
  const [configError, setConfigError] = useState<string | null>(null)
  const config = useMemo(() => {
    try {
      return browserConfig()
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  const [inferRaw, setInferRaw] = useState('')
  const [manageRaw, setManageRaw] = useState('')
  const wallet = useWallet('worker')
  const requiredIdentity = useRequiredIdentity(wallet.signer)

  const [fromConfig, setFromConfig] = useState<Prefill | null>(null)
  useEffect(() => {
    let cancelled = false
    void fetchPrefill().then((from) => {
      if (cancelled) return
      if (from.ogComputeKey) setInferRaw((typed) => (typed === '' ? from.ogComputeKey! : typed))
      if (from.ogAccessKey) setManageRaw((typed) => (typed === '' ? from.ogAccessKey! : typed))
      setFromConfig(from)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const inferState: ParsedOgKey | null = useMemo(
    () => (inferRaw.trim() === '' ? null : parseOgKey(inferRaw, 'infer')),
    [inferRaw],
  )
  const manageState: ParsedOgKey | null = useMemo(
    () => (manageRaw.trim() === '' ? null : parseOgKey(manageRaw, 'manage')),
    [manageRaw],
  )

  const [priceRaw, setPriceRaw] = useState('1')
  const modelChoices = useMemo(() => browserModels(), [])
  const [modelsRaw, setModelsRaw] = useState(() => modelChoices[0] ?? '')

  const [ads, setAds] = useState<WorkerAd[] | null>(null)
  useEffect(() => {
    if (!config) return
    let cancelled = false
    const accessKey = browserArkivAccessKey()
    void createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, ...(accessKey ? { accessKey } : {}) })
      .query<WorkerAd>('worker')
      .then((rows) => !cancelled && setAds(rows))
      .catch(() => !cancelled && setAds([]))
    return () => {
      cancelled = true
    }
  }, [config])

  const [catalog, setCatalog] = useState<ModelInfo[] | null | undefined>(null)
  useEffect(() => {
    if (!config) return
    const ctl = new AbortController()
    fetchCatalog(config.og.baseUrl, ctl.signal)
      .then((m) => setCatalog(m.length > 0 ? m : undefined))
      .catch(() => {
        if (!ctl.signal.aborted) setCatalog(undefined)
      })
    return () => ctl.abort()
  }, [config])

  const advertisedModels = useMemo(() => {
    const seen = new Set<string>()
    for (const ad of ads ?? []) for (const m of ad.models) seen.add(m)
    return [...seen].sort()
  }, [ads])

  const [worker, setWorker] = useState<BrowserWorker | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const earning = worker !== null

  useEffect(() => {
    if (worker && worker.arkivAddress.toLowerCase() !== wallet.address?.toLowerCase()) {
      setWorker(null)
      setStartError('Worker stopped because the connected wallet changed. Reconnect its account to recover any existing earnings.')
    }
  }, [worker, wallet.address])

  const models = useMemo(
    () => modelsRaw.split(',').map((m) => m.trim()).filter(Boolean),
    [modelsRaw],
  )
  const servesImages = useMemo(
    () => models.length > 0 && models.every((m) => isImageModel(m, config?.og.imageModels ?? [...DEFAULT_IMAGE_MODELS])),
    [models, config],
  )
  const price = useMemo(() => {
    if (!/^\d+$/.test(priceRaw.trim())) return null
    return BigInt(priceRaw.trim())
  }, [priceRaw])

  const ready =
    config !== null &&
    inferState?.ok === true &&
    wallet.signer !== null &&
    requiredIdentity.ready &&
    models.length > 0 &&
    price !== null &&
    (manageRaw.trim() === '' || manageState?.ok === true)

  const [session, setSession] = useState<EarnSession | null | undefined>(undefined)
  type Creds = { inferKey: string; manageKey?: string; signer: NonNullable<ReturnType<typeof useWallet>['signer']>; unseal?: (sealed: `0x${string}`) => string }
  const [creds, setCreds] = useState<Creds | null>(null)
  const [standingBy, setStandingBy] = useState(false)
  const stopping = useRef(false)

  useEffect(() => {
    setSession(loadSession())
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SESSION_KEY) return
      if (e.newValue === null) {
        stopping.current = true
        setSession(null)
        setCreds(null)
        return
      }
      try {
        setSession(sessionFrom(JSON.parse(e.newValue) as unknown))
      } catch {
        setSession(null)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const keysReady =
    inferState?.ok === true && wallet.signer !== null && requiredIdentity.ready && (manageRaw.trim() === '' || manageState?.ok === true)

  const takeKeys = useCallback((): Creds | null => {
    if (!keysReady || !wallet.signer || !requiredIdentity.ready) return null
    const taken: Creds = {
      inferKey: inferRaw.trim(),
      ...(manageRaw.trim() ? { manageKey: manageRaw.trim() } : {}),
      signer: wallet.signer,
      ...(wallet.unseal ? { unseal: wallet.unseal } : {}),
    }
    setInferRaw(fromConfig?.ogComputeKey ?? '')
    setManageRaw(fromConfig?.ogAccessKey ?? '')
    return taken
  }, [keysReady, wallet.signer, wallet.unseal, requiredIdentity.ready, inferRaw, manageRaw, fromConfig])

  const onStart = useCallback(() => {
    if (!config || !ready || !wallet.signer) return
    setStartError(null)
    const taken = takeKeys()
    if (!taken) return
    const next: EarnSession = { models, pricePer1kOut: price!, worker: wallet.signer.address.toLowerCase(), startedAt: Date.now() }
    saveSession(next)
    setSession(next)
    setCreds(taken)
  }, [config, ready, wallet.signer, takeKeys, models, price])

  const onResume = useCallback(() => {
    setStartError(null)
    if (session?.worker !== wallet.signer?.address.toLowerCase()) {
      setStartError('Connect the wallet that started this session, or stop it to start a new one.')
      return
    }
    const taken = takeKeys()
    if (taken) setCreds(taken)
  }, [takeKeys, session, wallet.signer])

  const autoKeys = fromConfig !== null && Boolean(fromConfig.ogComputeKey && wallet.signer)
  useEffect(() => {
    if (session && !creds && autoKeys && keysReady && session.worker === wallet.signer?.address.toLowerCase()) {
      const taken = takeKeys()
      if (taken) setCreds(taken)
    }
  }, [session, creds, autoKeys, keysReady, takeKeys, wallet.signer])

  useEffect(() => {
    if (!config || !session || !creds || !wallet.signer || !requiredIdentity.ready || session.worker !== wallet.signer.address.toLowerCase() || creds.signer.address.toLowerCase() !== session.worker) return
    let built: BrowserWorker | null = null
    stopping.current = false
    setStandingBy(true)
    const lead = holdLeadership(browserLocks(), WORKER_LOCK, () => {
      try {
        built = buildBrowserWorker({
          config,
          inferKey: creds.inferKey,
          ...(creds.manageKey ? { manageKey: creds.manageKey } : {}),
          signer: creds.signer,
          ...(creds.unseal ? { unsealInput: creds.unseal } : {}),
          pricePer1kOut: session.pricePer1kOut,
          models: session.models,
        })
        setStandingBy(false)
        setWorker(built)
      } catch (e) {
        setStandingBy(false)
        setStartError(redactKeyish(e instanceof Error ? e.message : String(e)))
        clearSession()
        setSession(null)
        setCreds(null)
      }
    })
    return () => {
      lead.release()
      setStandingBy(false)
      setWorker(null)
      setNote(null)
      if (stopping.current && built?.adState) {
        const adId = built.adState.id
        forgetAd(built)
        void built.arkiv.del(adId).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, creds, session?.startedAt, wallet.signer, requiredIdentity.ready])


  const [ticks, setTicks] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [loopError, setLoopError] = useState<string | null>(null)
  const [bucket, setBucket] = useState<CreditsBucket | null>(null)

  useEffect(() => {
    if (!worker) return
    let cancelled = false
    let timer: number | undefined

    const once = async (): Promise<void> => {
      try {
        const result: TickResult = await tick(worker)
        if (cancelled) return
        setTicks((n) => n + 1)
        setLoopError(null)
        const said = tickNote(result)
        if (said !== null) setNote(said)
      } catch (e) {
        if (cancelled) return
        setLoopError(redactKeyish(e instanceof Error ? e.message : String(e)))
      }
      if (!cancelled) timer = window.setTimeout(() => void once(), TICK_MS)
    }

    void once()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [worker])

  useEffect(() => {
    if (!worker) return
    let cancelled = false
    const read = async (): Promise<void> => {
      try {
        const balance = await worker.og.balance()
        const remaining = parseCreditBalance(balance.creditBalance)
        if (remaining > worker.dayStartCredits) worker.dayStartCredits = remaining
        if (!cancelled) setBucket(creditsBucketOf(remaining, worker.dayStartCredits))
      } catch {
        if (!cancelled) setBucket(null)
      }
    }
    void read()
    const id = window.setInterval(() => void read(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [worker])

  const [snapshot, setSnapshot] = useState<EarnSnapshot>(EMPTY_EARN_SNAPSHOT)
  const [readError, setReadError] = useState<string | null>(null)
  const [quota, setQuota] = useState<ArkivQuota | null>(null)
  const [deals, setDeals] = useState<Map<string, DealRow>>(new Map())
  const pollMs = MARKET_POLL_MS

  useEffect(() => {
    if (!worker || !config) return
    let cancelled = false
    let timer: number | undefined
    let nextDelay = pollMs
    const accessKey = browserArkivAccessKey()
    const reader = createArkivReader({
      rpc: config.arkiv.rpc,
      chainId: config.arkiv.chainId,
      ...(accessKey ? { accessKey } : {}),
      onQuota: (q) => !cancelled && setQuota(q),
    })

    const read = async (): Promise<void> => {
      try {
        const next = await readEarn(reader, worker.workerId, worker.payout, Date.now())
        if (cancelled) return
        nextDelay = pollMs
        setSnapshot(next)
        setReadError(null)
      } catch (error) {
        if (cancelled) return
        nextDelay = retryDelayMs(error, pollMs)
        setReadError(readErrorOf(error, config.arkiv.rpc))
      }
    }

    const loop = async (): Promise<void> => {
      if (document.visibilityState !== 'hidden') await read()
      if (!cancelled) timer = window.setTimeout(() => void loop(), nextDelay)
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || nextDelay !== pollMs) return
      if (timer !== undefined) window.clearTimeout(timer)
      void loop()
    }

    void loop()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [worker, config, pollMs])

  const reading = useRef(false)
  const lastDealReadAt = useRef(0)
  const dealsFor = useRef<typeof worker>(null)
  dealsFor.current = worker
  useEffect(() => {
    const escrow = worker?.escrow
    if (!escrow) return
    const wanted = dealsToRead(snapshot.receipts, deals)
    if (wanted.length === 0 || reading.current) return
    if (!rereadDue(lastDealReadAt.current, Date.now(), pollMs)) return
    lastDealReadAt.current = Date.now()
    reading.current = true
    const owner = worker
    void (async () => {
      const settled = await Promise.all(wanted.map(async (escrowId): Promise<DealRow | null> => {
        try {
          const deal = await escrow.deal(escrowId)
          return { escrowId, amountWei: deal.amount, state: deal.state }
        } catch {
          return null
        }
      }))
      const found = settled.filter((row): row is DealRow => row !== null)
      reading.current = false
      if (dealsFor.current !== owner || found.length === 0) return
      setDeals((prev) => {
        const next = new Map(prev)
        for (const row of found) next.set(row.escrowId, mergeDeal(prev.get(row.escrowId), row))
        return next
      })
    })()
  }, [worker, snapshot.receipts, deals, pollMs])

  useEffect(() => {
    if (typeof window === 'undefined') return
    return installKeyGuard(window, (message) => setLoopError(message))
  }, [])

  const onStop = useCallback(() => {
    stopping.current = true
    clearSession()
    setSession(null)
    setCreds(null)
  }, [])

  const now = Date.now()
  const earnings = earningsOf(snapshot.receipts, deals, worker?.payout)
  const reputation = reputationView(snapshot.receipts, config?.ttl.receipt ?? 604_800)
  const credits = creditsView(bucket)
  const budget = quotaView(quota)
  const rows = feedRows({
    claims: snapshot.claims,
    receipts: snapshot.receipts,
    now,
    ttlClaimSec: config?.ttl.claim ?? 90,
  })

  if (config === null) {
    return (
      <main className="space-transaction workspace">
        <WorkspaceHeader current="earn" />
        <div className="ground">
          <div className="page stack">
            <WorkspaceHeading page="earn" title={<>Put your credits <em>to work</em></>} description="Run a worker and earn from the inference credits you have left." />
            <EnsIdentity signer={wallet.signer ?? undefined} onConnect={wallet.connect} connecting={wallet.status === 'connecting'} />
            <div className="earn-connection-layout">
              <section className="panel earn-connection">
                <span className="connection-state"><i aria-hidden="true" /> Setup needed</span>
                <h2>Connect this instance to 0G</h2>
                <p>Earning is not available yet. This instance needs a 0G endpoint before it can run a worker.</p>
                <div className="surface-actions"><Link href="/market">Explore the market</Link></div>
                <details className="setup-details">
                  <summary>Connection details</summary>
                  <p className="notice">{configError ?? 'The browser configuration is incomplete.'}</p>
                  <p>Update the configuration in <span className="figure">config.json</span> and rebuild to enable earning.</p>
                </details>
              </section>
              <aside className="earning-guide" aria-label="How earning works">
                <h2>Once connected</h2>
                <ol>
                  <li><span>1</span><div><h3>Add your identity</h3><p>Choose a Dusk name for the wallet configured on this machine.</p></div></li>
                  <li><span>2</span><div><h3>Choose what to serve</h3><p>Set a model and your price.</p></div></li>
                  <li><span>3</span><div><h3>Start your worker</h3><p>Claim jobs, run inference, and return results.</p></div></li>
                </ol>
              </aside>
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="space-transaction workspace">
      <WorkspaceHeader current="earn" />
      <div className="ground">
        <div className="page stack">
          <WorkspaceHeading page="earn" title={earning || standingBy ? <>Your worker is <em>running</em></> : <>Put your credits <em>to work</em></>} description={earning ? 'Your worker is accepting jobs.' : 'Choose what to serve and set your price.'} />



          {!earning && session !== null ? (
            <>
            <EnsIdentity signer={wallet.signer ?? undefined} />
            <SavedSession
              session={session}
              standingBy={standingBy}
              resuming={requiredIdentity.ready && session?.worker === wallet.signer?.address.toLowerCase() && (creds !== null || (autoKeys && keysReady))}
              onStop={onStop}
              startError={startError}
              resume={
                fromConfig === null ? null : (
                  <>
                    <Identity
                      inferRaw={inferRaw}
                      onInfer={setInferRaw}
                      manageRaw={manageRaw}
                      onManage={setManageRaw}
                      inferState={inferState}
                      manageState={manageState}
                      wallet={wallet}
                      hasEscrowContract={config.escrow.address !== undefined}
                      fromConfig={fromConfig}
                    />
                    <p>
                      <button type="button" onClick={onResume} disabled={!keysReady}>
                        Resume earning
                      </button>
                    </p>
                  </>
                )
              }
            />
            </>
          ) : !earning ? (
            <>
              <Offer
                priceRaw={priceRaw}
                onPrice={setPriceRaw}
                modelsRaw={modelsRaw}
                onModels={setModelsRaw}
                models={modelChoices}
                advertisedModels={advertisedModels}
                ads={ads}
                priceValid={price !== null}
                perImage={servesImages}
                catalog={catalog}
                chosen={models}
                price={price}
                imageModels={config?.og.imageModels ?? [...DEFAULT_IMAGE_MODELS]}
              />

              <div className="earn-setup-grid">
                <EnsIdentity signer={wallet.signer ?? undefined} />
                <Identity
                  inferRaw={inferRaw}
                  onInfer={setInferRaw}
                  manageRaw={manageRaw}
                  onManage={setManageRaw}
                  inferState={inferState}
                  manageState={manageState}
                  wallet={wallet}
                  hasEscrowContract={config.escrow.address !== undefined}
                  fromConfig={fromConfig}
                />
              </div>

              <p>
                <button type="button" onClick={onStart} disabled={!ready}>
                  Start earning
                </button>
              </p>
              {!ready && fromConfig !== null && inferState?.ok === true && wallet.signer && (
                <p className="meta">
                  {!requiredIdentity.ready
                    ? requiredIdentity.message
                    : price === null
                      ? 'Enter a whole number price (0 or more).'
                      : manageState?.ok === false
                        ? wallet.local === false ? 'Check the 0G management key.' : 'Check og.accessKey in config.json.'
                        : 'Choose a model.'}
                </p>
              )}
              {startError !== null && (
                <p className="notice" role="alert">
                  {startError}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="meta">Earnings go to <WalletName address={worker!.payout} className="figure" />. Keep an earning tab open to serve jobs.</p>
              <details className="earn-identity">
                <summary>Manage Dusk name</summary>
                <EnsIdentity signer={wallet.signer ?? undefined} />
              </details>

              <dl className="figures">
                <div>
                  <dt>Credits left tonight</dt>
                  <dd className="figure money">{credits.figure}</dd>
                  <dd className="unit">expire at 00:00 UTC</dd>
                </div>
                <div>
                  <dt>Collected</dt>
                  <dd className="figure money">{formatWei(earnings.collectedWei)}</dd>
                  <dd className="unit">
                    {earnings.collectedDeals === 0
                      ? 'wei'
                      : `wei from ${earnings.collectedDeals} ${earnings.collectedDeals === 1 ? 'job' : 'jobs'}`}
                  </dd>
                </div>
                <div>
                  <dt>Awaiting</dt>
                  <dd className="figure money">{formatWei(earnings.awaitingWei)}</dd>
                  <dd className="unit">
                    {earnings.awaitingWei > 0n ? 'wei, collecting automatically' : 'wei'}
                  </dd>
                </div>
                <div>
                  <dt>Jobs earned</dt>
                  <dd className="figure">{reputation.delivered}</dd>
                  <dd className="unit">in the last {reputation.days === 1 ? 'day' : `${reputation.days} days`}</dd>
                </div>
              </dl>

              {(earnings.unknown > 0 || earnings.collectedUnknown > 0) && (
                <p className="meta">Some amounts are still loading, so totals may be low.</p>
              )}
              {!worker!.paid && (
                <p className="notice">
                  This worker is <strong>unpaid</strong>: no escrow is configured. It will still spend your credits.
                </p>
              )}

              <WorkerStatus
                ticks={ticks}
                intervalSeconds={TICK_MS / 1000}
                note={note}
                loopError={loopError}
                readError={readError}
                budget={budget}
              />

              <Feed rows={rows} ttlClaimSec={config.ttl.claim} now={now} answered={snapshot.readAt > 0} />

              <p>
                <button type="button" className="ghost danger" onClick={onStop}>
                  Stop earning
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  )
}

function Identity(props: {
  inferRaw: string
  onInfer: (v: string) => void
  manageRaw: string
  onManage: (v: string) => void
  inferState: ParsedOgKey | null
  manageState: ParsedOgKey | null
  wallet: ReturnType<typeof useWallet>
  hasEscrowContract: boolean
  fromConfig: Prefill | null
}) {
  const pasting = props.wallet.local === false

  return (
    <section className="panel stack" aria-labelledby="who">
      <h2 id="who">Account</h2>

      <p className="wallet-row">
        {props.wallet.status === 'connected' && props.wallet.address ? (
          <>
            <WalletName address={props.wallet.address} className="figure" />
            {pasting && (
              <button type="button" className="ghost" onClick={props.wallet.disconnect}>Forget key</button>
            )}
          </>
        ) : pasting ? null : (
          <button type="button" onClick={() => void props.wallet.connect()}>
            {props.wallet.status === 'connecting' ? <LoadingIndicator label="Loading configured wallet" /> : 'Load configured wallet'}
          </button>
        )}
      </p>
      {pasting && props.wallet.status !== 'connected' && (
        <WalletKeyField wallet={props.wallet} label="Wallet private key (signs Arkiv and Galileo, pays testnet gas)" />
      )}
      {props.wallet.status === 'error' && props.wallet.error !== null && (
        <p className="notice" role="alert">{props.wallet.error}</p>
      )}

      {pasting ? (
        <>
          <label className="field">
            <span>0G inference key (sk-)</span>
            <input
              type="password"
              className="figure"
              value={props.inferRaw}
              onChange={(e) => props.onInfer(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={props.inferState?.ok === false}
            />
            <span className="meta">Spends your credits. It stays in this tab and is never sent to Dusk.</span>
          </label>
          <label className="field">
            <span>0G management key (mk-), optional</span>
            <input
              type="password"
              className="figure"
              value={props.manageRaw}
              onChange={(e) => props.onManage(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={props.manageState?.ok === false}
            />
            <span className="meta">Only reads your balance. Leave it empty and the credit level stays unknown.</span>
          </label>
          <OgKeyState state={props.manageRaw.trim() === '' ? null : props.manageState} />
        </>
      ) : (
        props.fromConfig !== null && !props.fromConfig.ogComputeKey && <p className="notice">Add og.computeKey to config.json to run inference.</p>
      )}
      {props.inferState?.ok === false && <p className="notice" role="alert">{props.inferState.error}</p>}
      {props.inferState?.ok === true && <p className="configured-account">Inference account ready</p>}


    </section>
  )
}

function OgKeyState({ state }: { state: ParsedOgKey | null }) {
  if (state === null) return null
  if (!state.ok) {
    return (
      <p className="notice" role="alert">
        {state.error}
      </p>
    )
  }
  return <p className="meta">Looks valid.</p>
}

function Offer(props: {
  priceRaw: string
  onPrice: (v: string) => void
  modelsRaw: string
  onModels: (v: string) => void
  models: string[]
  advertisedModels: string[]
  ads: WorkerAd[] | null
  priceValid: boolean
  perImage: boolean
  catalog: ModelInfo[] | null | undefined
  chosen: string[]
  price: bigint | null
  imageModels: readonly string[]
}) {
  return (
    <section className="stack" aria-labelledby="offer">
      <h2 id="offer">Your offer</h2>

      <div className="grid-fields">
        <label className="field">
          <span>{props.perImage ? 'Your price per image' : 'Your price per 1,000 tokens'}</span>
          <input
            inputMode="numeric"
            className="figure"
            value={props.priceRaw}
            onChange={(e) => props.onPrice(e.target.value)}
            aria-invalid={!props.priceValid}
          />
          <span className="meta">Wei. Zero is allowed.</span>
          {!props.priceValid && (
            <span className="field-error" role="alert">
              Enter a whole number (0 or more).
            </span>
          )}
        </label>

        <label className="field">
          <span>Model you will serve</span>
          <ModelSelect
            value={props.modelsRaw}
            onChange={props.onModels}
            catalog={props.catalog}
            extras={[...props.models, ...props.advertisedModels, ...props.imageModels]}
            served={props.advertisedModels}
            placeholder={props.models[0] ?? '0gm-1.0-35b-a3b'}
            aria-describedby="models-help"
          />
          <span className="meta" id="models-help">
            {props.ads === null
              ? <LoadingIndicator label="Checking available offers" />
              : props.advertisedModels.includes(props.modelsRaw)
                ? 'Others are serving this too.'
                : 'Nobody else is serving this right now.'}
          </span>
          {props.catalog !== undefined &&
            props.chosen.map((m) => (
              <ListPriceNote
                key={m}
                {...(props.chosen.length > 1 ? { model: m } : {})}
                price={props.catalog === null ? undefined : listPrice(props.catalog, m, isImageModel(m, props.imageModels))}
                typed={props.price}
              />
            ))}
        </label>
      </div>
    </section>
  )
}

function Feed(props: { rows: FeedRow[]; ttlClaimSec: number; now: number; answered: boolean }) {
  if (props.rows.length === 0) {
    return (
      <section className="stack empty" aria-labelledby="feed">
        <h2 id="feed">Nothing claimed yet</h2>
        <p>
          {props.answered
            ? 'Your worker is listed. Matching jobs are picked up within seconds. To test it, post one from /buy.'
            : <LoadingIndicator label="Loading worker jobs" />}
        </p>
      </section>
    )
  }

  return (
    <section className="stack" aria-labelledby="feed">
      <h2 id="feed">Your jobs</h2>
      <div className="scroller">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col" className="num">
                Out
              </th>
              <th scope="col">Credits spent</th>
              <th scope="col">Lease left</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.jobId}>
                <td className="figure">{shortHash(row.jobId)}</td>
                <td>
                  {row.state === 'earned' ? (
                    'Earned'
                  ) : (
                    <span className="warm">Working on it</span>
                  )}
                </td>
                <td className="figure num">{row.receipt ? row.receipt.tokensOut : '—'}</td>
                <td>
                  {row.credits === undefined ? (
                    '—'
                  ) : (
                    <>
                      {row.credits.kind === 'unstated' ? (
                        <span>not stated</span>
                      ) : (
                        <span className="figure money">{row.credits.figure}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="figure">
                  {row.claim
                    ? formatCountdown(row.claim.claimedAt + props.ttlClaimSec * 1000 - props.now)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="meta">Credits spent is an estimate reported by your worker.</p>

      <p className="meta">{PRIVATE_RESIDUAL}</p>
    </section>
  )
}

function SavedSession(props: {
  session: EarnSession | undefined
  standingBy: boolean
  resuming: boolean
  resume: React.ReactNode
  onStop: () => void
  startError: string | null
}) {
  const { session } = props
  if (session === undefined) return <LoadingIndicator label="Checking for a running worker" />
  const what = (
    <p>
      Serving <span className="figure">{session.models.join(', ')}</span> at{' '}
      <span className="figure money">{formatWei(session.pricePer1kOut)}</span> wei, as{' '}
      <WalletName address={session.worker} className="figure" />, since {new Date(session.startedAt).toLocaleTimeString()}.
    </p>
  )
  return (
    <section className="panel stack" aria-labelledby="session">
      <h2 id="session">
        {props.standingBy ? 'Running in another tab' : props.resuming ? <>Resuming your worker <LoadingIndicator label="Resuming worker" /></> : 'Resume your worker'}
      </h2>
      {what}
      {props.standingBy ? (
        <p className="meta">
          Only one tab runs the worker at a time. This one takes over by itself if that tab is closed.
        </p>
      ) : (
        !props.resuming && (
          <>
            <p className="meta">
              Reconnect this session’s wallet and provide your 0G API key to resume. The wallet must have a verified
              Dusk name. If another tab is already running this worker, this one will stand by instead.
            </p>
            {props.resume}
          </>
        )
      )}
      {props.startError !== null && (
        <p className="notice" role="alert">
          {props.startError}
        </p>
      )}
      <p>
        <button type="button" className="ghost danger" onClick={props.onStop}>
          Stop earning
        </button>
      </p>
    </section>
  )
}
