import { keccak256, type Hex } from 'viem'
import type { Deal, Receipt, Verification } from '@dusk/core'

export type Canary = { prompt: string; expect: RegExp }

export const CANARIES: readonly Canary[] = [
  { prompt: 'What is 2+2? Reply with the number only.', expect: /\b4\b|\bfour\b/i },
  { prompt: 'What is the capital of France? One word.', expect: /\bparis\b/i },
  { prompt: 'What is 3 times 5? Reply with the number only.', expect: /\b15\b|\bfifteen\b/i },
  { prompt: "Spell the word 'cat' backwards.", expect: /\btac\b/i },
]

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function judge(args: {
  canary: Canary
  text: string
  bytesHash: Hex
  receipt: Receipt
  deal: Deal
}): Pick<Verification, 'result' | 'check'> {
  const { receipt, deal } = args
  if (!same(receipt.worker, deal.worker) || !same(receipt.outputHash, deal.outputHash)) {
    return { result: 'illegal', check: 'receipt-contradicts-chain' }
  }
  if (!same(args.bytesHash, deal.outputHash)) return { result: 'illegal', check: 'output-hash-mismatch' }
  if (args.text.trim() === '') return { result: 'bad', check: 'empty-answer' }
  if (!args.canary.expect.test(args.text)) return { result: 'bad', check: 'wrong-answer' }
  return { result: 'pass', check: 'correct' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function everyMs(argv: readonly string[]): number | null {
  const i = argv.indexOf('--every')
  if (i === -1) return null
  const m = /^(\d+)(s|m|h)$/.exec(argv[i + 1] ?? '')
  if (!m) throw new Error('--every takes a duration like 30m, 2h or 90s')
  const ms = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h']
  if (ms < 60_000) throw new Error('--every must be at least 1m: each canary spends a worker\'s real credits')
  return ms
}

async function runOnce(): Promise<void> {
  const { loadConfig } = await import('@dusk/core')
  const { attrEq } = await import('@dusk/arkiv')
  const { buildBuyerDeps, grantUntilDelivered, postJob, requireModel } = await import('./post-job')

  const config = loadConfig(process.env)
  const deps = buildBuyerDeps()
  const escrow = deps.escrow
  if (!escrow) throw new Error('canary needs DUSK_ESCROW_ADDRESS: an unfunded job is never served')

  const canary = CANARIES[Math.floor(Math.random() * CANARIES.length)]!
  const job = await postJob(deps, {
    prompt: canary.prompt,
    model: requireModel(),
    maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
    maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '16'),
    deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '600000'),
  })
  console.log('── canary posted ──')
  console.log(`  verifier : ${deps.address}  (must be in NEXT_PUBLIC_DUSK_VERIFIERS to count)`)
  console.log(`  job id   : ${job.id}`)
  console.log(`  escrow id: ${job.escrowId}`)

  const granting = grantUntilDelivered(deps, job).catch((e) => {
    console.error(`  grant failed: ${e instanceof Error ? e.message : e}`)
    return null
  })

  let receipt: Receipt | undefined
  while (!receipt && Date.now() < job.expiresAt) {
    const found = await deps.arkiv.query<Receipt>('receipt', attrEq('receipt', 'jobId', job.id)).catch(() => [])
    receipt = found.find((r) => r.jobId === job.id)
    if (!receipt) await sleep(5_000)
  }
  await granting
  if (!receipt) {
    console.log('  nobody delivered before the deadline — no verdict; refund with pnpm reclaim --mine')
    return
  }

  let deal: Deal = await escrow.deal(job.escrowId)
  for (let i = 0; i < 12 && deal.state === 'funded'; i++) {
    await sleep(5_000)
    deal = await escrow.deal(job.escrowId)
  }
  if (deal.state !== 'committed' && deal.state !== 'settled') {
    console.log(`  receipt found but the deal is "${deal.state}" — nothing committed to judge`)
    return
  }

  const bytes = await deps.swarm.download(receipt.outputRef)
  const text = new TextDecoder().decode(bytes)
  const verdict = judge({ canary, text, bytesHash: keccak256(bytes), receipt, deal })

  const id = await deps.arkiv.put<Omit<Verification, 'id' | 'owner'>>(
    'verification',
    { jobId: job.id, escrowId: job.escrowId as Hex, worker: deal.worker, ...verdict },
    { ttlSeconds: config.ttl.receipt },
  )
  console.log('── verdict ──')
  console.log(`  worker   : ${deal.worker}`)
  console.log(`  answer   : ${JSON.stringify(text.slice(0, 80))}`)
  console.log(`  result   : ${verdict.result} (${verdict.check})`)
  console.log(`  entity   : ${id}`)
}

if (process.argv[1]?.endsWith('canary.ts')) {
  const every = everyMs(process.argv)
  if (every === null) {
    await runOnce()
  } else {
    console.log(`── canary loop: one every ${every / 60_000} min. ctrl-c to stop. ──`)
    for (;;) {
      const started = Date.now()
      console.log(`\n[${new Date(started).toISOString()}] canary run`)
      try {
        await runOnce()
      } catch (e) {
        console.error(`  run failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      }
      await sleep(Math.max(0, started + every - Date.now()))
    }
  }
}
