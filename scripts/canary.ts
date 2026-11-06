import { keccak256, type Hex } from 'viem'
import type { Claim, Deal, Receipt, Verification } from '@dusk/core'

/**
 * Canary jobs: a real, funded job posted to the market so a configured verifier can
 * check the seller that serves it. Two things are measured, never what the answer says:
 *
 * - **output**: `illegal` if the receipt contradicts the chain or the output is not what
 *   was committed; `bad` (`empty-answer`) for an empty answer, or (`no-delivery`) when a
 *   seller claimed the canary and never delivered; `pass` (`delivered`) otherwise.
 * - **latency**: claim to delivered receipt, from the blocks Arkiv stamped on both — not
 *   the worker's own receipt figure, which it writes itself.
 *
 * `/reputation` turns these into points (`apps/web/src/lib/reputation.ts`). Verdicts are
 * signed by DUSK_VERIFIER_PRIVATE_KEY when set — the address in `reputation.verifiers` —
 * and by the buyer otherwise. The job itself is posted by the buyer, which needs a Dusk
 * name to post. `pnpm verifier` starts the loop automatically (DUSK_CANARY_EVERY).
 */

export type Canary = { prompt: string }

export const CANARIES: readonly Canary[] = [
  { prompt: 'What is 2+2? Reply with the number only.' },
  { prompt: 'What is the capital of France? One word.' },
  { prompt: 'What is 3 times 5? Reply with the number only.' },
  { prompt: "Spell the word 'cat' backwards." },
]

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function judge(args: { text: string; bytesHash: Hex; receipt: Receipt; deal: Deal }): Pick<Verification, 'result' | 'check'> {
  const { receipt, deal } = args
  if (!same(receipt.worker, deal.worker) || !same(receipt.outputHash, deal.outputHash)) {
    return { result: 'illegal', check: 'receipt-contradicts-chain' }
  }
  if (!same(args.bytesHash, deal.outputHash)) return { result: 'illegal', check: 'output-hash-mismatch' }
  if (args.text.trim() === '') return { result: 'bad', check: 'empty-answer' }
  return { result: 'pass', check: 'delivered' }
}

/** Claim to receipt in ms, from the engine-stamped blocks; undefined when it cannot be known. */
export function canaryLatencyMs(claimBlock: bigint | undefined, receiptBlock: bigint | undefined, blockSec = 2): number | undefined {
  if (claimBlock === undefined || receiptBlock === undefined || receiptBlock < claimBlock) return undefined
  return Number(receiptBlock - claimBlock) * blockSec * 1000
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function parseDuration(raw: string, name: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(raw)
  if (!m) throw new Error(`${name} takes a duration like 5m, 2h or 90s`)
  const ms = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h']
  if (ms < 60_000) throw new Error(`${name} must be at least 1m: each canary spends a worker's real credits`)
  return ms
}

export function everyMs(argv: readonly string[]): number | null {
  const i = argv.indexOf('--every')
  if (i === -1) return null
  return parseDuration(argv[i + 1] ?? '', '--every')
}

/** The automatic loop's interval: DUSK_CANARY_EVERY, default 5m; `off` disables it. */
export function canaryEveryMs(env: Record<string, string | undefined>): number | null {
  const raw = env['DUSK_CANARY_EVERY']?.trim() || '5m'
  if (raw === 'off') return null
  return parseDuration(raw, 'DUSK_CANARY_EVERY')
}

type Log = (line: string) => void

export async function runCanaryOnce(log: Log = console.log): Promise<void> {
  // post-job first: importing it overlays config.json onto process.env, which everything
  // below reads. Kept lazy so the tests importing `judge` never load real credentials.
  const { buildBuyerDeps, grantUntilDelivered, postJob, requireModel } = await import('./post-job')
  const { loadConfig, ARKIV_BLOCK_TIME_SEC, winningClaim } = await import('@dusk/core')
  const { attrEq, createArkivStore } = await import('@dusk/arkiv')

  const config = loadConfig(process.env)
  const deps = buildBuyerDeps()
  const escrow = deps.escrow
  if (!escrow) throw new Error('canary needs DUSK_ESCROW_ADDRESS: an unfunded job is never served')

  const verifierKey = process.env.DUSK_VERIFIER_PRIVATE_KEY?.trim()
  const writer = verifierKey
    ? createArkivStore({
        rpc: config.arkiv.rpc,
        chainId: config.arkiv.chainId,
        privateKey: verifierKey as Hex,
        ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
      })
    : deps.arkiv

  const canary = CANARIES[Math.floor(Math.random() * CANARIES.length)]!
  const job = await postJob(deps, {
    prompt: canary.prompt,
    model: requireModel(),
    maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
    maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '16'),
    deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '600000'),
  })
  log(`[canary] posted ${job.id.slice(0, 12)}… (escrow ${job.escrowId.slice(0, 12)}…) — verdicts signed by ${writer.address}`)

  const granting = grantUntilDelivered(deps, job).catch((e) => {
    log(`[canary] grant failed: ${e instanceof Error ? e.message : e}`)
    return null
  })

  let receipt: Receipt | undefined
  while (!receipt && Date.now() < job.expiresAt) {
    const found = await deps.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', job.id)).catch(() => [])
    receipt = found.find((r) => r.jobId === job.id)
    if (!receipt) await sleep(5_000)
  }
  await granting
  const claims = await deps.arkiv.query<Claim>('claim', attrEq('claim', 'jobId', job.id)).catch(() => [] as Claim[])

  const write = async (v: Omit<Verification, 'id' | 'owner'>) => {
    const id = await writer.put<Omit<Verification, 'id' | 'owner'>>('verification', v, { ttlSeconds: config.ttl.receipt })
    log(`[canary] ${v.worker} → ${v.result} (${v.check})${v.latencyMs !== undefined ? `, ${(v.latencyMs / 1000).toFixed(0)}s` : ''} — entity ${id.slice(0, 12)}…`)
  }

  if (!receipt) {
    // Claimed and never delivered: the same failure as an empty answer, and attributable,
    // because a claim's owner is stamped by the engine. Nobody claiming it is no one's fault.
    const winner = winningClaim(claims)
    if (winner?.owner) {
      await write({ jobId: job.id, escrowId: job.escrowId as Hex, worker: winner.owner, result: 'bad', check: 'no-delivery' })
    } else {
      log('[canary] nobody claimed it before the deadline — no verdict; refund with pnpm reclaim --mine')
    }
    return
  }

  let deal: Deal = await escrow.deal(job.escrowId)
  for (let i = 0; i < 12 && deal.state === 'funded'; i++) {
    await sleep(5_000)
    deal = await escrow.deal(job.escrowId)
  }
  if (deal.state !== 'committed' && deal.state !== 'settled') {
    log(`[canary] receipt found but the deal is "${deal.state}" — nothing committed to judge`)
    return
  }

  const bytes = await deps.swarm.download(receipt.outputRef)
  const text = new TextDecoder().decode(bytes)
  const verdict = judge({ text, bytesHash: keccak256(bytes), receipt, deal })
  const claim = claims.find((c) => c.owner !== undefined && same(c.owner, deal.worker))
  const latencyMs = canaryLatencyMs(claim?.createdAtBlock, receipt.createdAtBlock, ARKIV_BLOCK_TIME_SEC)
  await write({
    jobId: job.id,
    escrowId: job.escrowId as Hex,
    worker: deal.worker,
    ...verdict,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
  })
}

/** Runs forever: one canary, then waits out the rest of the interval. Never throws. */
export async function runCanaryLoop(everyMsValue: number, log: Log = console.log): Promise<never> {
  log(`[canary] automatic: one canary every ${everyMsValue / 60_000} min`)
  for (;;) {
    const started = Date.now()
    try {
      await runCanaryOnce(log)
    } catch (e) {
      log(`[canary] run failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
    await sleep(Math.max(0, started + everyMsValue - Date.now()))
  }
}

if (process.argv[1]?.endsWith('canary.ts')) {
  const every = everyMs(process.argv)
  if (every === null) await runCanaryOnce()
  else await runCanaryLoop(every)
}
