'use client'

import { LoadingIndicator } from '../../components/LoadingIndicator'
import { jobTrustMode } from '../../lib/model-groups'
import { WalletName } from '../../components/WalletName'

import Link from 'next/link'

import { newEscrowId, postJob, postPrivateJob, retireDelivered, StuckDealError, writeGrant, type PostedJob } from '@dusk/buyer'
import { isSealablePubkey } from '@dusk/crypto'
import { EnsIdentity } from '../../components/EnsIdentity'
import { WorkspaceHeader } from '../../components/WorkspaceHeader'
import { WorkspaceHeading } from '../../components/WorkspaceHeading'
import { JobSummary } from '../../components/JobSummary'
import { SwarmImage } from '../../components/SwarmImage'
import {
  deliveryPatch,
  inFlightRows,
  loadLedger,
  patchRow,
  rowFromPosted,
  saveRow,
} from '../../lib/history'
import {
  ChatInputError,
  checkChatInput,
  encodeChatInput,
  fundingPrice,
  imageJobInput,
  isImageModel,
  jobPriceWei,
  jobTokens,
  nextCreditReset,
  planJob,
  type ChatAttachment,
  type Claim,
  type ModelInfo,
  type Receipt,
  type SwarmRef,
  type WorkerAd,
} from '@dusk/core'
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { keccak256, toHex, type Hex } from 'viem'
import { MARKET_POLL_MS, readErrorOf, retryDelayMs } from '../../lib/arkiv'
import {
  buildBrowserBuyer,
  buyReader,
  grantTargets,
  liveGrantedWorkers,
  readJob,
  readJobs,
  type JobSnapshot,
} from '../../lib/buy'
import {
  defaultJobForm,
  MAX_TOKENS_CEILING,
  maxDeadlineMinutes,
  parseJobForm,
  type FormErrors,
  type RawJobForm,
} from '../../lib/buy-form'
import {
  creditsSpentView,
  jobRemainingMs,
  jobStage,
  latencyLabel,
  leaseRemainingMs,
  liveLease,
  shortHash,
} from '../../lib/buy-receipt'
import { browserFallbackAddress, browserModels, browserReadConfig } from '../../lib/config'
import { formatCountdown } from '../../lib/countdown'
import { formatWei } from '../../lib/market'
import { historySources, readReputation } from '../../lib/past-read'
import { useWallet } from '../../lib/wallet'
import { useRequiredIdentity } from '../../lib/use-required-identity'
import { readAttachment } from '../../lib/attach'
import { listPrice, shareOfList, type ListPrice } from '../../lib/list-price'
import { ModelSelect } from '../../components/ModelSelect'
import { ListPriceNote } from '../../components/ListPriceNote'
import { fetchCatalog, imageInputModels, textOutputModels } from '@dusk/og'


const VISIBILITY_LINE = 'Public prompts are visible to everyone.'

const PRIVATE_RESIDUAL = 'The worker who runs the job, and the model provider 0G routes it to, can still read the prompt.'

const PUBLIC_ATTACH_LINE = 'Attachments on a public job are readable by anyone, permanently. Choose Private to keep them to the worker.'

const EMPTY_SNAPSHOT: JobSnapshot = { job: undefined, claims: [], receipt: undefined, readAt: 0 }

type Collected = { text: string; via: 'public' | 'private'; imageRef?: SwarmRef }

type Sent = { text: string; attachments: Array<{ name: string; kind: ChatAttachment['kind']; src?: string }> }

export default function BuyPage() {
  const config = useMemo(() => browserReadConfig(), [])
  const pollMs = MARKET_POLL_MS

  const [now, setNow] = useState(() => Date.now())
  const [postedJobs, setPostedJobs] = useState<PostedJob[]>([])
  const [collected, setCollected] = useState<Map<string, Collected>>(new Map())
  const [sent, setSent] = useState<Map<string, Sent>>(new Map())
  const watching = postedJobs.some((j) => !collected.has(j.id))
  useEffect(() => {
    if (!watching) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [watching])

  const wallet = useWallet()
  const requiredIdentity = useRequiredIdentity(wallet.signer)
  const signingKey = wallet.signer
  const willFund = config.escrow.address !== undefined && signingKey != null


  const modelChoices = useMemo(() => browserModels(), [])
  const [form, setForm] = useState<RawJobForm>(() => ({
    ...defaultJobForm(config.clock, Date.now(), modelChoices[0]),
    prompt: '',
  }))
  const [errors, setErrors] = useState<FormErrors>({})
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const postingRef = useRef(false)
  const field = <K extends keyof RawJobForm>(key: K, value: RawJobForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const isImageJob = isImageModel(form.model.trim(), config.og.imageModels)

  const [offers, setOffers] = useState<WorkerAd[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void buyReader(config)
      .query<WorkerAd>('worker')
      .then((ads) => {
        if (!cancelled) setOffers(ads)
      })
      .catch(() => {
        if (!cancelled) setOffers([])
      })
    return () => {
      cancelled = true
    }
  }, [config])

  const [catalog, setCatalog] = useState<ModelInfo[] | null | undefined>(null)
  useEffect(() => {
    const ctl = new AbortController()
    fetchCatalog(config.og.baseUrl, ctl.signal)
      .then((models) => setCatalog(models.length > 0 ? models : undefined))
      .catch(() => {
        if (!ctl.signal.aborted) setCatalog(undefined)
      })
    return () => ctl.abort()
  }, [config.og.baseUrl])
  const visionModels = useMemo(() => (catalog ? imageInputModels(catalog) : undefined), [catalog])
  const catalogModels = useMemo(
    () => (catalog ? [...textOutputModels(catalog), ...config.og.imageModels] : []),
    [catalog, config.og.imageModels],
  )

  const servedModels = useMemo(() => {
    const seen = new Set<string>()
    for (const ad of offers ?? []) for (const m of ad.models) seen.add(m)
    return [...seen].sort()
  }, [offers])

  const [snapshots, setSnapshots] = useState<Map<string, JobSnapshot>>(new Map())
  const [readError, setReadError] = useState<string | null>(null)
  const [grantIds, setGrantIds] = useState<Map<string, string[]>>(new Map())
  const [grantNote, setGrantNote] = useState<Map<string, string>>(new Map())
  const granted = useRef<Map<string, Map<string, number>>>(new Map())
  const sealing = useRef(false)
  const banned = useRef<Set<string>>(new Set())
  useEffect(() => {
    const sources = historySources()
    if (!sources) return
    let live = true
    const load = () =>
      readReputation(sources)
        .then((records) => {
          if (live) banned.current = new Set(records.filter((r) => r.banned).map((r) => r.worker.toLowerCase()))
        })
        .catch(() => {})
    void load()
    const id = window.setInterval(() => void load(), 5 * 60_000)
    return () => {
      live = false
      window.clearInterval(id)
    }
  }, [])
  const saved = useRef<Set<string>>(new Set())

  const buyer = useMemo(
    () => (signingKey ? buildBrowserBuyer({ config, signer: signingKey, ...(wallet.unseal ? { unsealOutput: wallet.unseal } : {}) }) : null),
    [config, signingKey, wallet.unseal],
  )

  const buyerAddress = buyer?.address
  const currentBuyer = useRef(buyerAddress)
  currentBuyer.current = buyerAddress
  const canPostPrivate = !!buyer?.unsealOutput && isSealablePubkey(buyer.buyerPubkey)
  useEffect(() => {
    setPostedJobs([]); setSnapshots(new Map()); setCollected(new Map()); setGrantIds(new Map()); setGrantNote(new Map())
    granted.current = new Map(); saved.current = new Set(); resumed.current = new Set(); setSent(new Map()); setCollectError(new Map()); setAttachments([]); setAttachError(null)
  }, [buyerAddress])


  const noteFor = useCallback((jobId: string, note: string | null): void => {
    setGrantNote((prev) => {
      const next = new Map(prev)
      if (note === null) next.delete(jobId)
      else next.set(jobId, note)
      return next
    })
  }, [])

  const resumed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!buyer) return
    const rows = inFlightRows(loadLedger(buyer.address), Date.now()).filter((r) => !resumed.current.has(r.jobId))
    if (rows.length === 0) return
    for (const r of rows) resumed.current.add(r.jobId)
    let cancelled = false
    const reader = buyReader(config)
    void (async () => {
      for (const row of rows) {
        try {
          const snap = await readJob(reader, { id: row.jobId, escrowId: row.escrowId }, Date.now())
          if (cancelled) return
          if (!snap.job) continue
          let encryptedRef: SwarmRef | undefined
          let note: string | null = null
          if (row.visibility === 'private') {
            const sameInput = row.inputHash !== undefined && keccak256(toHex(row.prompt)) === row.inputHash
            if (sameInput) {
              encryptedRef = await buyer.swarm.upload(new TextEncoder().encode(row.prompt), { encrypt: true })
            } else {
              note =
                'Reloaded: the attachments on this private job are not kept in this browser, so it cannot be sent to a new worker. If nobody delivers, refund it from History after the deadline.'
            }
          }
          if (cancelled) return
          const job: PostedJob = {
            ...snap.job,
            id: row.jobId,
            amountWei: row.amountWei,
            ...(row.fundTx ? { fundTx: row.fundTx } : {}),
            ...(encryptedRef ? { encryptedRef } : {}),
          }
          setPostedJobs((prev) => (prev.some((j) => j.id === job.id) ? prev : [...prev, job]))
          setSent((prev) =>
            new Map(prev).set(job.id, {
              text: row.prompt,
              attachments: (row.attachmentNames ?? []).map((name) => ({ name, kind: 'text' as const })),
            }),
          )
          setSnapshots((prev) => new Map(prev).set(job.id, snap))
          if (note) noteFor(job.id, note)
        } catch {
          resumed.current.delete(row.jobId)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [buyer, config, noteFor])

  const watchedJobs = useMemo(
    () => postedJobs.filter((j) => !collected.has(j.id) && j.expiresAt > Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postedJobs, collected, now],
  )
  const watchedKey = watchedJobs.map((j) => j.id).join(',')

  useEffect(() => {
    if (watchedJobs.length === 0 || !buyer) return
    let cancelled = false
    let timer: number | undefined
    let nextDelay = pollMs
    const reader = buyReader(config)

    const maybeGrant = async (posted: PostedJob, claim: Claim): Promise<void> => {
      const isPrivate = posted.visibility === 'private'
      if (cancelled || sealing.current || currentBuyer.current !== buyer.address) return
      if (isPrivate && !posted.encryptedRef) return
      const forJob = granted.current.get(posted.id) ?? new Map<string, number>()
      granted.current.set(posted.id, forJob)
      if (isPrivate && !claim.workerPubkey) return
      sealing.current = true
      try {
        const id = await writeGrant(buyer, posted, claim, posted.encryptedRef)
        if (id !== null) forJob.set(claim.workerId, Date.now())
        if (id === null) {
          if (!cancelled) {
            noteFor(
              posted.id,
              isPrivate
                ? 'Could not send the prompt to that worker. Waiting for the next one.'
                : 'Could not authorise that worker. Waiting for the next one.',
            )
          }
          return
        }
        if (!cancelled) {
          setGrantIds((prev) => {
            const next = new Map(prev)
            next.set(posted.id, [...(next.get(posted.id) ?? []), id])
            return next
          })
          noteFor(posted.id, null)
        }
      } catch (e) {
        if (!cancelled) {
          noteFor(
            posted.id,
            `Could not authorise the worker (${e instanceof Error ? e.message : 'unknown'}). Retrying.`,
          )
          forJob.delete(claim.workerId)
        }
      } finally {
        sealing.current = false
      }
    }

    const read = async (): Promise<void> => {
      try {
        const next = await readJobs(reader, watchedJobs, Date.now())
        if (cancelled) return
        nextDelay = pollMs
        setSnapshots((prev) => {
          const merged = new Map(prev)
          for (const [id, snap] of next) merged.set(id, snap)
          return merged
        })
        for (const [id, snap] of next) {
          if (!snap.receipt) continue
          const posted = watchedJobs.find((j) => j.id === id)
          if (!posted || saved.current.has(posted.escrowId)) continue
          saved.current.add(posted.escrowId)
          patchRow(buyer.address, posted.escrowId, deliveryPatch(snap.receipt))
        }
        setReadError(next.size === 0 ? 'Could not reach Arkiv. Retrying.' : null)
        const targets = grantTargets({
          jobs: watchedJobs,
          snapshots: next,
          granted: new Map(
            [...granted.current].map(([jobId, byWorker]) => [
              jobId,
              liveGrantedWorkers(byWorker, Date.now(), config.ttl.grant * 1000),
            ]),
          ),
          banned: banned.current,
        })
        for (const target of targets) {
          const posted = watchedJobs.find((j) => j.id === target.job.id)
          if (posted) await maybeGrant(posted, target.claim)
        }
      } catch (error) {
        if (cancelled) return
        nextDelay = retryDelayMs(error, pollMs)
        setReadError(readErrorOf(error, config.arkiv.rpc))
      }
    }

    const tick = async (): Promise<void> => {
      if (document.visibilityState !== 'hidden') await read()
      if (!cancelled) timer = window.setTimeout(tick, nextDelay)
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || nextDelay !== pollMs) return
      if (timer !== undefined) window.clearTimeout(timer)
      void tick()
    }

    void tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey, buyer, config, pollMs])

  const fileInput = useRef<HTMLInputElement>(null)
  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return
      setAttachError(null)
      setReading(true)
      const next: ChatAttachment[] = []
      let problem: string | null = null
      for (const file of files) {
        try {
          next.push(await readAttachment(file, { maxImagePx: config.input.maxImagePx }))
        } catch (e) {
          problem = e instanceof Error ? e.message : String(e)
        }
      }
      setAttachments((prev) => {
        const all = [...prev, ...next]
        if (all.length > config.input.maxAttachments) {
          setAttachError(`At most ${config.input.maxAttachments} attachments per message.`)
          return all.slice(0, config.input.maxAttachments)
        }
        return all
      })
      if (problem) setAttachError(problem)
      setReading(false)
    },
    [config.input.maxAttachments, config.input.maxImagePx],
  )

  const inputProblem = useMemo(() => {
    if (attachments.length === 0 || isImageJob) return null
    try {
      checkChatInput(
        { text: form.prompt.trim(), attachments },
        { model: form.model.trim(), visionModels, ...config.input },
      )
      return null
    } catch (e) {
      return e instanceof ChatInputError ? e.message.replace(/^This job's input is not usable: /, '').replace(/\. Nothing was run\.$/, '.') : String(e)
    }
  }, [attachments, form.prompt, form.model, isImageJob, visionModels, config.input])

  const inputBytes = useMemo(
    () =>
      attachments.length === 0 ? 0 : new TextEncoder().encode(encodeChatInput({ text: form.prompt, attachments })).length,
    [attachments, form.prompt],
  )

  const onPost = useCallback(async () => {
    if (!buyer || postingRef.current) return
    if (!requiredIdentity.ready) { setPostError(requiredIdentity.message); return }
    const parsed = parseJobForm(form, {
      clock: config.clock,
      now: Date.now(),
      imageModels: config.og.imageModels,
      hasAttachments: attachments.length > 0,
    })
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    if (inputProblem) return
    setErrors({})
    setPostError(null)
    const isImage = isImageModel(parsed.spec.model, config.og.imageModels)
    const base = {
      ...parsed.spec,
      maxPricePer1kOut: fundingPrice(parsed.spec.maxPricePer1kOut, parsed.spec.model, offers ?? [], FALLBACK_ADDRESS),
    }
    const plan = isImage || attachments.length > 0 ? ({ kind: 'single' } as const) : planJob(base.prompt, base.maxTokens, MAX_TOKENS_CEILING)
    if (plan.kind === 'too-big') {
      setPostError(
        `No single worker can return more than ${plan.limit} tokens, and this prompt has no ` +
          'numbered tasks or sections to split on. Lower the token limit or list the tasks.',
      )
      return
    }
    const serial = plan.kind === 'serial' && base.visibility !== 'private'
    const split = plan.kind === 'parallel' || serial
    const parentId = split ? newEscrowId() : undefined
    const specs: (typeof base & { piece?: { parentId: Hex; index: number; count: number }; after?: string })[] =
      split && (plan.kind === 'parallel' || plan.kind === 'serial')
        ? plan.pieces.map((p, index) => ({
            ...base,
            prompt: p.prompt,
            maxTokens: p.maxTokens,
            piece: { parentId: parentId!, index, count: plan.pieces.length },
          }))
        : [base]
    postingRef.current = true
    setPosting(true)
    let current = specs[0]!
    const inputOf = (spec: typeof current): string =>
      isImage
        ? imageJobInput(spec.prompt, config.og.imageSize)
        : encodeChatInput({ text: spec.prompt, attachments })
    try {
      const post = base.visibility === 'private' ? postPrivateJob : postJob
      let previous: PostedJob | undefined
      for (const [i, spec] of specs.entries()) {
        current = serial && previous ? { ...spec, after: previous.id } : spec
        const job = await post(buyer, { ...current, prompt: inputOf(current), trustMode: jobTrustMode(current.model, catalog, isImage) })
        previous = job
        saveRow(
          buyer.address,
          rowFromPosted(job, current.prompt, Date.now(), attachments.map((a) => a.name)),
          undefined,
        )
        if (currentBuyer.current !== buyer.address) return
        // Captured now, not read inside the updater: React runs the updater later, by
        // which time `current` has moved on to the last piece, and every piece's card
        // showed the last piece's text.
        const text = current.prompt
        setSent((prev) =>
          new Map(prev).set(job.id, {
            text,
            attachments: attachments.map((a) => ({
              name: a.name,
              kind: a.kind,
              ...(a.kind === 'image' ? { src: `data:${a.mime};base64,${a.data}` } : {}),
            })),
          }),
        )
        setPostedJobs((prev) => [
          job,
          ...(i > 0
            ? prev
            : prev.filter((j) => !collected.has(j.id) && !snapshots.get(j.id)?.receipt && j.expiresAt > Date.now())),
        ])
      }
      field('prompt', '')
      setAttachments([])
      setAttachError(null)

    } catch (e) {
      if (e instanceof StuckDealError) {
        saveRow(
          buyer.address,
          {
            escrowId: e.escrowId,
            jobId: '',
            ...(e.fundTx ? { fundTx: e.fundTx } : {}),
            amountWei: jobPriceWei(
              current.maxPricePer1kOut,
              jobTokens({ maxTokens: current.maxTokens, inputChars: inputOf(current).length }),
            ),
            model: current.model,
            maxTokens: current.maxTokens,
            visibility: current.visibility ?? 'public',
            prompt: current.prompt,
            ...(attachments.length > 0 ? { attachmentNames: attachments.map((a) => a.name) } : {}),
            expiresAt: Date.now() + current.deadlineMs,
            postedAt: Date.now(),
          },
          undefined,
        )
      }
      if (currentBuyer.current === buyer.address) setPostError(
        e instanceof StuckDealError
          ? `${e.message}`
          : e instanceof Error
            ? e.message
            : 'The job could not be posted.',
      )

    } finally {
      postingRef.current = false
      setPosting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyer, form, attachments, inputProblem, collected, snapshots, config.clock, config.og.imageModels, config.og.imageSize, requiredIdentity, offers, catalog])


  const [collectError, setCollectError] = useState<Map<string, string>>(new Map())
  const onCollect = useCallback(
    async (posted: PostedJob) => {
    const receipt = snapshots.get(posted.id)?.receipt
    if (!buyer || !receipt || currentBuyer.current !== buyer.address) return
    setCollectError((prev) => {
      const next = new Map(prev)
      next.delete(posted.id)
      return next
    })
    try {
      const isPrivate = (receipt.visibility ?? 'public') === 'private'
      let ref = receipt.outputRef
      if (isPrivate) {
        if (!buyer.unsealOutput) throw new Error('this tab holds no key to open a sealed output with')
        ref = buyer.unsealOutput(receipt.outputRef as Hex)
      }
      if (isImageModel(posted.model, config.og.imageModels)) {
        setCollected((prev) => new Map(prev).set(posted.id, { text: '', via: 'public', imageRef: ref }))
        void buyer.swarm
          .download(ref)
          .then((bytes) => retireDelivered(buyer, posted, receipt, bytes))
          .catch(() => {})
        return
      }
      const bytes = await buyer.swarm.download(ref)
      if (currentBuyer.current !== buyer.address) return
      void retireDelivered(buyer, posted, receipt, bytes)
      const text = new TextDecoder().decode(bytes)
      setCollected((prev) =>
        new Map(prev).set(posted.id, { text, via: isPrivate ? 'private' : 'public' }),
      )
      patchRow(buyer.address, posted.escrowId, { outputText: text })
    } catch (e) {
      setCollectError((prev) =>
        new Map(prev).set(
          posted.id,
          `Could not fetch the answer (${e instanceof Error ? e.message : String(e)}). Try again.`,
        ),
      )
    }

    },
    [buyer, snapshots, config.og.imageModels],
  )

  const autoCollected = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const job of postedJobs) {
      if (!snapshots.get(job.id)?.receipt || collected.has(job.id) || autoCollected.current.has(job.id)) continue
      autoCollected.current.add(job.id)
      void onCollect(job)
    }
  }, [postedJobs, snapshots, collected, onCollect])

  const thread = useRef<HTMLDivElement>(null)
  const turnCount = postedJobs.length
  const collectedCount = collected.size
  useEffect(() => {
    const el = thread.current
    if (el && turnCount > 0) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turnCount, collectedCount])

  const resetAt = nextCreditReset(config.clock, new Date(now))
  const maxMinutes = maxDeadlineMinutes(config.clock, now)

  const canSend =
    buyer !== null && requiredIdentity.ready &&
    !posting &&
    !reading &&
    inputProblem === null &&
    (form.prompt.trim() !== '' || (attachments.length > 0 && !isImageJob))

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSend) void onPost()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files]
    if (files.length === 0 || isImageJob) return
    e.preventDefault()
    void addFiles(files)
  }
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    if (!isImageJob) void addFiles([...e.dataTransfer.files])
  }

  const turns = [...postedJobs].reverse()


  return (
    <main className="space-transaction workspace">
      <WorkspaceHeader current="buy" />
      <div className="ground">
        <div className="page stack">
          <WorkspaceHeading page="buy" title={<>Post an <em>inference</em> job</>} description="Send a prompt. A worker runs it and returns the result here." />
          <div className="chat-shell">

            <aside className="chat-sidebar panel stack" aria-label="Job settings">
              <Identity wallet={wallet} />
              <EnsIdentity signer={signingKey ?? undefined} />

              <Settings
                form={form}
                errors={errors}
                field={field}
                models={modelChoices}
                imageModels={config.og.imageModels}
                imageSize={config.og.imageSize}
                servedModels={servedModels}
                catalogModels={catalogModels}
                catalogRead={catalog !== null}
                catalog={catalog}
                list={catalog === null ? undefined : listPrice(catalog, form.model, isImageJob)}
                offers={offers}
                maxMinutes={maxMinutes}
                funded={willFund}
                canPostPrivate={canPostPrivate}
                hasEscrowContract={config.escrow.address !== undefined}
              />
            </aside>

            <section id="prompt" className="chat-main panel" aria-label="Chat">
              <div className="chat-thread" aria-live="polite" ref={thread}>
                {turns.length === 0 ? (
                  <div className="chat-empty">
                    <h2>Ask anything</h2>
                    <p className="meta">
                      Your result will appear here. Past orders are in{' '}
                      <Link href="/history">History</Link>.
                    </p>
                  </div>
                ) : (
                  turns.map((job) => {
                    const snapshot = snapshots.get(job.id) ?? EMPTY_SNAPSHOT
                    const stage = jobStage({
                      job,
                      claims: snapshot.claims,
                      receipt: snapshot.receipt,
                      now,
                      ttlClaimSec: config.ttl.claim,
                    })
                    return (
                      <Turn
                        key={job.id}
                        posted={job}
                        sent={sent.get(job.id)}
                        snapshot={snapshot}
                        stage={stage}
                        lease={liveLease(snapshot.claims, config.ttl.claim, now)}
                        now={now}
                        resetAt={resetAt}
                        ttlClaimSec={config.ttl.claim}
                        pollMs={pollMs}
                        grantIds={grantIds.get(job.id) ?? []}
                        grantNote={grantNote.get(job.id) ?? null}
                        readError={readError}

                        collected={collected.get(job.id) ?? null}
                        collectError={collectError.get(job.id) ?? null}
                        onCollect={() => void onCollect(job)}
                        isImage={isImageModel(job.model, config.og.imageModels)}
                        {...(config.swarm.downloadEndpoint ? { downloadUrl: config.swarm.downloadEndpoint } : {})}
                      />
                    )
                  })
                )}
              </div>

              <form
                className="chat-composer"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (canSend) void onPost()
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
              >
                {!requiredIdentity.ready && (requiredIdentity.checking ? <LoadingIndicator label={requiredIdentity.message} /> : <p className="meta chat-composer-note" role="status">{requiredIdentity.message}</p>)}
                {postError !== null && (
                  <p className="notice chat-composer-note" role="alert">
                    {postError}
                  </p>
                )}
                {attachments.length > 0 && (
                  <ul className="chat-attachments" aria-label="Attached">
                    {attachments.map((a, i) => (
                      <li key={`${a.name}-${i}`} className="chat-chip">
                        {a.kind === 'image' ? (
                          <img src={`data:${a.mime};base64,${a.data}`} alt="" />
                        ) : (
                          <span className="chat-chip-file" aria-hidden="true">TXT</span>
                        )}
                        <span className="chat-chip-name">{a.name}</span>
                        <button
                          type="button"
                          className="ghost chat-chip-remove"
                          aria-label={`Remove ${a.name}`}
                          onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {(attachError ?? inputProblem ?? errors.prompt) && (
                  <p className="field-error chat-composer-note" role="alert">
                    {attachError ?? inputProblem ?? errors.prompt}
                  </p>
                )}
                {attachments.length > 0 && form.visibility === 'public' && (
                  <p className="meta chat-composer-note">{PUBLIC_ATTACH_LINE}</p>
                )}
                <div className="chat-composer-row">
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    accept="image/png,image/jpeg,image/webp,text/*,.md,.csv,.json,.txt,.ts,.tsx,.js,.py,.sol,.yaml,.yml,.toml"
                    onChange={(e) => {
                      void addFiles([...(e.target.files ?? [])])
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    className="ghost chat-attach"
                    onClick={() => fileInput.current?.click()}
                    disabled={isImageJob || reading || attachments.length >= config.input.maxAttachments}
                    title={isImageJob ? 'An image model takes a written prompt only.' : 'Attach images or text files'}
                    aria-label="Attach images or text files"
                  >
                    {reading ? <LoadingIndicator label="Reading attachment" /> : <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>}
                  </button>
                  <label className="chat-input">
                    <span className="visually-hidden">Message</span>
                    <textarea
                      rows={1}
                      value={form.prompt}
                      onChange={(e) => field('prompt', e.target.value)}
                      onKeyDown={onComposerKey}
                      onPaste={onPaste}
                      placeholder={isImageJob ? 'Describe the image to generate…' : 'Message, or attach an image…'}
                      aria-invalid={errors.prompt !== undefined}
                    />
                  </label>
                  <button type="submit" className="chat-send" disabled={!canSend}>
                    {posting ? <LoadingIndicator label="Posting job" /> : 'Send'}
                  </button>
                </div>
                <p className="meta chat-composer-foot"><a href="#settings">Review price, privacy and deadline</a></p>
                {attachments.length > 0 && <p className="meta chat-composer-foot">
                  Input <span className="figure">{formatBytes(inputBytes)}</span> of{' '}
                  <span className="figure">{formatBytes(config.input.maxBytes)}</span>; images count as input tokens.
                </p>}
              </form>
            </section>

          </div>
        </div>
      </div>
    </main>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Identity(props: {
  wallet: ReturnType<typeof useWallet>
}) {
  const { wallet } = props
  return (
    <section className="panel stack" aria-labelledby="who">
      <h2 id="who" className="setup-section-title">Wallet</h2>
      <p className="wallet-row">
        {wallet.status === 'connected' && wallet.address ? (
          <>
            <WalletName address={wallet.address} className="figure" />

          </>
        ) : (
          <button type="button" onClick={() => void wallet.connect()}>
            {wallet.status === 'connecting' ? <LoadingIndicator label="Loading configured wallet" /> : 'Load configured wallet'}
          </button>
        )}
      </p>
      {wallet.status === 'error' && wallet.error !== null && (
        <p className="notice" role="alert">{wallet.error}</p>
      )}

    </section>
  )
}

const FALLBACK_ADDRESS = browserFallbackAddress()

function Settings(props: {
  form: RawJobForm
  errors: FormErrors
  field: <K extends keyof RawJobForm>(key: K, value: RawJobForm[K]) => void
  models: string[]
  imageModels: readonly string[]
  imageSize: string
  servedModels: string[]
  catalogModels: string[]
  catalogRead: boolean
  catalog: ModelInfo[] | null | undefined
  list: ListPrice | null | undefined
  offers: WorkerAd[] | null
  maxMinutes: number
  hasEscrowContract: boolean

  funded: boolean
  canPostPrivate: boolean
}) {
  const { form, errors, field } = props
  const isImage = isImageModel(form.model.trim(), props.imageModels)
  const cheapest = useMemo(() => {
    const prices = (props.offers ?? []).map((a) => a.pricePer1kOut)
    return prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a))
  }, [props.offers])

  return (
    <section className="chat-section stack" aria-labelledby="settings">
      <div className="job-settings-heading"><h2 id="settings" className="setup-section-title">Job settings</h2><a href="#prompt">Write your prompt <span aria-hidden="true">↓</span></a></div>

      <label className="field">
        <span>Model</span>
        <ModelSelect
          value={form.model}
          onChange={(v) => field('model', v)}
          catalog={props.catalog}
          extras={[...props.models, ...props.servedModels, ...props.imageModels]}
          served={props.servedModels}
          placeholder={props.models[0] ?? '0gm-1.0-35b-a3b'}
          aria-invalid={errors.model !== undefined}
          {...(errors.model ? { 'aria-describedby': 'model-error' } : {})}
        />
        <span className="meta">
          {props.offers === null
            ? <LoadingIndicator label="Checking offers" />
            : props.servedModels.includes(form.model.trim())
              ? 'Available now.'
              : 'No active offers; your job will wait.'}
        </span>
        {props.catalogRead && props.catalogModels.length > 0 && form.model.trim() !== '' && !props.catalogModels.includes(form.model.trim()) && (
          <span className="meta warm">0G does not list this model. Check the spelling: a job on an unknown model is funded but nobody can run it.</span>
        )}
        {form.model.trim() !== '' && <ListPriceNote price={props.list} />}
        <FieldError id="model-error" message={errors.model} />
      </label>

      <label className="field">
        <span>{isImage ? 'Max price per image' : 'Max price per 1,000 tokens'}</span>
        <input
          inputMode="numeric"
          className="figure"
          value={form.maxPricePer1kOut}
          onChange={(e) => field('maxPricePer1kOut', e.target.value)}
          aria-invalid={errors.maxPricePer1kOut !== undefined}
          aria-describedby={errors.maxPricePer1kOut ? 'price-error' : undefined}
        />
        <span className="meta">
          Wei. {isImage ? null : 'Your prompt and the answer both count. '}{cheapest === null ? null : <>Cheapest: <span className="figure money">{formatWei(cheapest)}</span>.</>}
          {props.list && /^\d+$/.test(form.maxPricePer1kOut.trim()) && (
            <> Your ceiling is {shareOfList(BigInt(form.maxPricePer1kOut.trim()), props.list.wei) ?? '—'}.</>
          )}
        </span>
        <FieldError id="price-error" message={errors.maxPricePer1kOut} />
      </label>

      <fieldset className="field toggle prompt-visibility">
        <legend>Who can read the prompt</legend>
        <p className="visibility-description">{form.visibility === 'public' ? VISIBILITY_LINE : 'The prompt is sealed for the selected worker.'}</p>
        <div className="choices">
          <label>
            <input
              type="radio"
              name="visibility"
              checked={form.visibility === 'public'}
              onChange={() => field('visibility', 'public')}
            />
            <span>Public</span>
          </label>
          <label>
            <input
              type="radio"
              name="visibility"
              checked={form.visibility === 'private'}
              onChange={() => field('visibility', 'private')}
              disabled={isImage || !props.canPostPrivate}
            />
            <span>Private</span>
          </label>
        </div>
        {isImage ? (
          <p className="meta">Image jobs are public for now.</p>
        ) : !props.canPostPrivate ? (
          <p className="meta">Private jobs need a wallet that can decrypt outputs.</p>
        ) : (
          form.visibility === 'private' && <p className="notice">{PRIVATE_RESIDUAL}</p>
        )}
        <FieldError id="visibility-error" message={errors.visibility} />
      </fieldset>

      <details className="job-advanced" open={errors.maxTokens || errors.deadlineMinutes ? true : undefined}>
        <summary>Output &amp; deadline</summary>
      {isImage ? (
        <div className="field">
          <span>Output</span>
          <span className="figure">1 image · {props.imageSize}</span>
          <span className="meta">An image job always delivers one picture.</span>
        </div>
      ) : (
        <label className="field">
          <span>Max output tokens</span>
          <input
            inputMode="numeric"
            className="figure"
            value={form.maxTokens}
            onChange={(e) => field('maxTokens', e.target.value)}
            aria-invalid={errors.maxTokens !== undefined}
            aria-describedby={errors.maxTokens ? 'tokens-error' : undefined}
          />
          <FieldError id="tokens-error" message={errors.maxTokens} />
        </label>
      )}

      <label className="field">
        <span>Deadline, in minutes</span>
        <input
          inputMode="numeric"
          className="figure"
          value={form.deadlineMinutes}
          onChange={(e) => field('deadlineMinutes', e.target.value)}
          aria-invalid={errors.deadlineMinutes !== undefined}
          aria-describedby={errors.deadlineMinutes ? 'deadline-error' : undefined}
        />
        <span className="meta">
          Up to <span className="figure">{props.maxMinutes}</span> (credits reset at 00:00 UTC).
        </span>
        <FieldError id="deadline-error" message={errors.deadlineMinutes} />
      </label>

      </details>



      <JobSummary
        form={
          /^\d+$/.test(form.maxPricePer1kOut.trim())
            ? {
                ...form,
                maxPricePer1kOut: fundingPrice(
                  BigInt(form.maxPricePer1kOut.trim()),
                  form.model,
                  props.offers ?? [],
                  FALLBACK_ADDRESS,
                ).toString(),
              }
            : form
        }
        maxMinutes={props.maxMinutes}
        funded={props.funded}
        imageModels={props.imageModels}
      />

      {(!props.hasEscrowContract || props.funded) && (
        <p className="notice">
          {!props.hasEscrowContract
            ? 'Escrow is not configured. Jobs posted here are unfunded and will not be run by workers.'
            : 'Keep this tab open after sending. It approves the worker automatically.'}
        </p>
      )}

    </section>
  )
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null
  return (
    <span id={id} className="field-error" role="alert">
      {message}
    </span>
  )
}

const STAGE_HEADING: Record<'open' | 'claimed' | 'delivered' | 'lapsed', string> = {
  open: 'Waiting for a worker',
  claimed: 'A worker is running it',
  delivered: 'Delivered',
  lapsed: 'Nobody took it',
}

const STAGE_LINE: Record<'open' | 'claimed' | 'delivered' | 'lapsed', string> = {
  open: 'Your job is live. A worker will pick it up shortly.',
  claimed: 'A worker picked it up. If it stops, the job goes back on the market.',
  delivered: 'Fetching the answer…',
  lapsed: 'The deadline passed. Your escrowed amount can be refunded from History.',
}

function Turn(props: {
  posted: PostedJob
  sent: Sent | undefined
  snapshot: JobSnapshot
  stage: 'open' | 'claimed' | 'delivered' | 'lapsed'
  lease: Claim | undefined
  now: number
  resetAt: Date
  ttlClaimSec: number
  pollMs: number
  grantIds: string[]
  grantNote: string | null
  readError: string | null
  collected: Collected | null
  collectError: string | null
  onCollect: () => void
  isImage: boolean
  downloadUrl?: string
}) {
  const { posted, snapshot, stage, collected } = props
  const remaining = jobRemainingMs(posted, props.now)

  return (
    <article className="chat-turn">
      <div className="chat-bubble chat-user">
        {props.sent && props.sent.attachments.length > 0 && (
          <ul className="chat-sent-attachments">
            {props.sent.attachments.map((a, i) =>
              a.src ? (
                <li key={i}>
                  <img className="chat-thumb" src={a.src} alt={a.name} />
                </li>
              ) : (
                <li key={i} className="chat-chip">
                  <span className="chat-chip-file" aria-hidden="true">
                    {a.kind === 'image' ? 'IMG' : 'TXT'}
                  </span>
                  <span className="chat-chip-name">{a.name}</span>
                </li>
              ),
            )}
          </ul>
        )}
        {props.sent?.text ? <p className="chat-text">{props.sent.text}</p> : !props.sent && <p className="meta">Job {shortHash(posted.id)}</p>}
        <p className="chat-bubble-meta">
          {posted.model} · {posted.visibility} · <span className="figure money">{formatWei(posted.amountWei)}</span> wei
          {posted.fundTx ? '' : ' (unfunded)'}
        </p>
      </div>

      <div className="chat-bubble chat-reply" data-stage={stage}>
        {collected ? (
          collected.imageRef ? (
            <SwarmImage swarmRef={collected.imageRef} downloadUrl={props.downloadUrl} alt="The delivered image" />
          ) : (
            <pre className="output chat-answer">{collected.text}</pre>
          )
        ) : (
          <>
            <p className="chat-stage">
              {stage === 'delivered' ? <LoadingIndicator label="Fetching the answer" /> : <span className="chat-stage-dot" aria-hidden="true" />}
              {STAGE_HEADING[stage]}
            </p>
            <p className="meta">{STAGE_LINE[stage]}</p>
            {stage !== 'delivered' && stage !== 'lapsed' && (
              <p className="meta">
                <span className="figure">{formatCountdown(remaining)}</span> until deadline
                {props.lease && (
                  <>
                    {' '}· lease <span className="figure">{formatCountdown(leaseRemainingMs(props.lease, props.ttlClaimSec, props.now))}</span> left
                  </>
                )}
              </p>
            )}
          </>
        )}

        {props.grantNote !== null && (
          <p className="notice" role="alert">
            {props.grantNote}
          </p>
        )}
        {props.collectError !== null && (
          <p className="notice" role="alert">
            {props.collectError}{' '}
            <button type="button" className="ghost" onClick={props.onCollect}>
              Try again
            </button>
          </p>
        )}
        {props.readError !== null && !collected && (
          <p className="notice" role="status">
            {props.readError}
          </p>
        )}

        <details className="chat-details">
          <summary>Job details</summary>
          <JobDetails {...props} />
          {snapshot.receipt && <ReceiptDetails receipt={snapshot.receipt} isImage={props.isImage} />}
        </details>
      </div>
    </article>
  )
}

function JobDetails(props: {
  posted: PostedJob
  snapshot: JobSnapshot
  pollMs: number
  grantIds: string[]
}) {
  const { posted, snapshot } = props
  const answered = snapshot.readAt > 0
  return (
    <>
      <div className="scroller">
        <table className="ledger">
          <tbody>
            <tr>
              <th scope="row">Job</th>
              <td className="figure">{shortHash(posted.id)}</td>
            </tr>
            <tr>
              <th scope="row">Listed</th>
              <td>{!answered ? <LoadingIndicator label="Checking job" /> : snapshot.job ? 'yes' : snapshot.receipt ? 'no — delivered' : <span className="warm">no — expired</span>}</td>
            </tr>
            <tr>
              <th scope="row">Input</th>
              <td>
                {posted.visibility === 'public' ? (
                  <>
                    public · <span className="figure">{shortHash(posted.inputRef ?? '')}</span>
                  </>
                ) : (
                  'private'
                )}
              </td>
            </tr>
            <tr>
              <th scope="row">Input hash</th>
              <td className="figure">{shortHash(posted.inputHash)}</td>
            </tr>
            <tr>
              <th scope="row">Escrow deal</th>
              <td className="figure full-id">{posted.escrowId}</td>
            </tr>
            {posted.fundTx && (
              <tr>
                <th scope="row">Funding tx</th>
                <td className="figure full-id">{posted.fundTx}</td>
              </tr>
            )}
            {posted.visibility === 'private' && (
              <tr>
                <th scope="row">Sent to worker</th>
                <td>
                  {props.grantIds.length === 0 ? 'not yet' : <span className="figure">{props.grantIds.map(shortHash).join(', ')}</span>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="meta">
        Updates every <span className="figure">{(props.pollMs / 1000).toFixed(0)}</span>s.{' '}
        {answered ? `Last checked ${utcTime(snapshot.readAt)} UTC.` : ''}
      </p>
    </>
  )
}

function ReceiptDetails(props: { receipt: Receipt; isImage: boolean }) {
  const { receipt } = props
  const credits = creditsSpentView(receipt.creditsSpent)
  const isPrivate = (receipt.visibility ?? 'public') === 'private'
  return (
    <div className="scroller">
      <table className="ledger">
        <caption>Receipt</caption>
        <tbody>
          <tr>
            <th scope="row">Model served</th>
            <td>{receipt.modelServed}</td>
          </tr>
          <tr>
            <th scope="row">Credits spent</th>
            <td>
              {credits.kind === 'unstated' ? <span>not stated</span> : <span className="figure money">{credits.figure}</span>}
              <span className="meta"> — {credits.note}</span>
            </td>
          </tr>
          <tr>
            <th scope="row">{props.isImage ? 'Images' : 'Tokens'}</th>
            <td className="figure">{props.isImage ? receipt.tokensOut : `${receipt.tokensIn} in, ${receipt.tokensOut} out`}</td>
          </tr>
          <tr>
            <th scope="row">Output hash</th>
            <td className="figure">{shortHash(receipt.outputHash)}</td>
          </tr>
          <tr>
            <th scope="row">Latency</th>
            <td className="figure">{latencyLabel(receipt.latencyMs)}</td>
          </tr>
          <tr>
            <th scope="row">Worker paid</th>
            <td className="figure">{receipt.worker}</td>
          </tr>
          <tr>
            <th scope="row">Output</th>
            <td>
              <span className="figure">{shortHash(receipt.outputRef)}</span>
              <span className="meta"> — {isPrivate ? 'private' : 'public'}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

  )
}

function utcTime(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
}
