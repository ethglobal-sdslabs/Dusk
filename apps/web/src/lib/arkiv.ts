'use client'

import { ArkivQuotaError, attrEq, createArkivReader, humanWait, type ArkivReader } from '@dusk/arkiv'
import {
  ARKIV_BLOCK_TIME_SEC,
  type Claim,
  type Job,
  type Kind,
  type Receipt,
  type WorkerAd,
} from '@dusk/core'
import type { Expression } from '@arkiv-network/sdk/query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { browserArkivAccessKey, browserReadConfig } from './config'

export type MarketSnapshot = {
  workers: WorkerAd[]
  jobs: Job[]
  claims: Claim[]
  receipts: Receipt[]
  readAt: number
}

export const EMPTY_SNAPSHOT: MarketSnapshot = { workers: [], jobs: [], claims: [], receipts: [], readAt: 0 }

export type MarketQuery = { kind: Kind; filter?: Expression }

export function marketQueries(): Record<'workers' | 'jobs' | 'claims' | 'receipts', MarketQuery> {
  return {
    workers: { kind: 'worker' },
    jobs: { kind: 'job', filter: attrEq('job', 'status', 'open') },
    claims: { kind: 'claim' },
    receipts: { kind: 'receipt' },
  }
}

export async function readMarket(reader: ArkivReader, nowMs: number): Promise<MarketSnapshot> {
  const q = marketQueries()
  const [workers, jobs, claims, receipts] = await Promise.all([
    reader.query<WorkerAd>(q.workers.kind, q.workers.filter),
    reader.query<Job>(q.jobs.kind, q.jobs.filter),
    reader.query<Claim>(q.claims.kind, q.claims.filter),
    reader.query<Receipt>(q.receipts.kind, q.receipts.filter),
  ])
  return { workers, jobs, claims, receipts, readAt: nowMs }
}

export const MARKET_POLL_MS = ARKIV_BLOCK_TIME_SEC * 1000

export type Burn = { id: string; jobId: string; firstSeenMs: number }

export function trackBurns(args: {
  previous: readonly Burn[]
  seen: ReadonlySet<string> | null
  receipts: readonly Receipt[]
  nowMs: number
  burnMs: number
}): { burns: Burn[]; seen: Set<string> } {
  const current = new Set(args.receipts.map((r) => r.id))
  const alive = args.previous.filter((burn) => args.nowMs - burn.firstSeenMs <= args.burnMs)
  if (args.seen === null) return { burns: alive, seen: current }

  const known = new Set(alive.map((b) => b.id))
  const fresh = args.receipts
    .filter((r) => !args.seen!.has(r.id) && !known.has(r.id))
    .map((r) => ({ id: r.id, jobId: r.jobId, firstSeenMs: args.nowMs }))

  return { burns: [...alive, ...fresh], seen: current }
}

export type LiveEntities = {
  workers: WorkerAd[]
  jobs: Job[]
  claims: Claim[]
  receipts: Receipt[]
  burns: Burn[]
  readAt: number
  error: string | null
  pollMs: number
}


export function useLiveEntities(): LiveEntities {
  const config = useMemo(() => browserReadConfig(), [])
  const reader = useMemo(() => {
    const accessKey = browserArkivAccessKey()
    return createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, ...(accessKey ? { accessKey } : {}) })
  }, [config])
  const pollMs = MARKET_POLL_MS

  const [state, setState] = useState<{ snapshot: MarketSnapshot; burns: Burn[]; error: string | null }>({
    snapshot: EMPTY_SNAPSHOT,
    burns: [],
    error: null,
  })

  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    let nextDelay = pollMs

    const read = async (): Promise<void> => {
      try {
        const snapshot = await readMarket(reader, Date.now())
        if (cancelled) return
        nextDelay = pollMs
        setState((prev) => {
          const tracked = trackBurns({
            previous: prev.burns,
            seen: seen.current,
            receipts: snapshot.receipts,
            nowMs: snapshot.readAt,
            burnMs: BURN_MS,
          })
          seen.current = tracked.seen
          return { snapshot, burns: tracked.burns, error: null }
        })
      } catch (error) {
        if (cancelled) return
        nextDelay = retryDelayMs(error, pollMs)
        setState((prev) => ({ ...prev, error: readErrorOf(error, config.arkiv.rpc) }))
      }
    }

    const schedule = (): void => {
      timer = window.setTimeout(tick, nextDelay)
    }

    const tick = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        schedule()
        return
      }
      await read()
      if (!cancelled) schedule()
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
  }, [reader, pollMs, config.arkiv.rpc])

  return {
    workers: state.snapshot.workers,
    jobs: state.snapshot.jobs,
    claims: state.snapshot.claims,
    receipts: state.snapshot.receipts,
    burns: state.burns,
    readAt: state.snapshot.readAt,
    error: state.error,
    pollMs,
  }
}

export const BURN_MS = 2600

export const QUOTA_BACKOFF_MAX_MS = 60_000

export function retryDelayMs(error: unknown, pollMs: number): number {
  if (!(error instanceof ArkivQuotaError)) return pollMs
  const asked = error.retryAfterSec === undefined ? QUOTA_BACKOFF_MAX_MS : error.retryAfterSec * 1000
  return Math.min(QUOTA_BACKOFF_MAX_MS, Math.max(pollMs, asked))
}

export function readErrorOf(error: unknown, rpc: string): string {
  if (error instanceof ArkivQuotaError) {
    return (
      `Arkiv is rate-limiting this page: its read budget is spent` +
      (error.retryAfterSec === undefined ? '. ' : `, and resets in about ${humanWait(error.retryAfterSec)}. `) +
      `Nothing below is current until it does.`
    )
  }
  const host = (() => {
    try {
      return new URL(rpc).host
    } catch {
      return rpc
    }
  })()
  return `The order book at ${host} did not answer. Previously loaded market data may be out of date. The market will keep retrying.`
}
