import 'dotenv/config'
import '@dusk/core/env'
import { fundingPrice, planJob, type Job, type Receipt, type WorkerAd } from '@dusk/core'
import type { PostedJob } from '@dusk/buyer'
import { buildDeps } from '../worker/src/main'
import { heartbeat, settleDue, tick } from '../worker/src/loop'
import { buildBuyerDeps, grantOnClaim, postJob, requireModel } from './post-job'
import { joinPieces } from '../apps/web/src/lib/pieces'

if (!process.env.DUSK_TRUSTED_MODELS) {
  console.log('✗ set DUSK_TRUSTED_MODELS=0gm-1.0-35b-a3b — without it buildDeps bills extra completions')
  process.exit(1)
}

const NO_MONEY = process.argv.includes('--no-money')
if (NO_MONEY) {
  process.env.DUSK_ESCROW_ADDRESS = ''
  console.log('── no-money mode: no escrow, nothing deposited ──')
}

process.env.DUSK_FALLBACK_DELAY_SEC = '20'
process.env.DUSK_RESERVE_TOKENS = '200'
process.env.DUSK_RESERVE_COST_WEI = '200000'

const t0 = Date.now()
const mark = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`)
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail })
  mark(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const buyer = buildBuyerDeps()
const worker = await buildDeps()
// Test harness only: the `final` branch requires a verified *.dusk.eth name to post or
// claim, and these wallets have none. In no-money mode the name check is skipped HERE so
// the split itself can be exercised; product code is untouched and still enforces it.
if (NO_MONEY) {
  delete buyer.admit
  delete worker.admit
  console.log('── TEST ONLY: ENS name check skipped for this run (product code still requires it) ──')
}
const model = requireModel()
const CAP = 2_000_000n
mark(`buyer ${buyer.address}`)
mark(`worker ${worker.arkiv.address} as FALLBACK, price ${worker.pricePer1kOut} wei/1k (from its reserve)`)
check('fallback price is the reserve cost', worker.pricePer1kOut === 1_000_000n, `${worker.pricePer1kOut}`)

await heartbeat(worker)
const ads = await buyer.arkiv.query<WorkerAd>('worker')
const sellers = ads.filter((a) => a.models.includes(model))
mark(`live sellers of ${model}: ${sellers.map((a) => a.payout).join(', ') || 'none'}`)
const price = fundingPrice(CAP, model, ads, worker.payout)
const onlyUs = sellers.every((a) => a.payout?.toLowerCase() === worker.payout.toLowerCase())
check(
  onlyUs ? 'buyer funds at our cost — we are the only seller' : 'buyer funds at its cap — another seller is live',
  onlyUs ? price === 1_000_000n : price === CAP,
  `cap ${CAP}, funding at ${price}`,
)
if (NO_MONEY) check('no escrow in this run', !buyer.escrow && !worker.escrow)

async function postPlanned(prompt: string): Promise<Job[]> {
  const plan = planJob(prompt, 8, 64)
  if (plan.kind !== 'parallel' && plan.kind !== 'serial') throw new Error(`expected a split, got ${plan.kind}`)
  const parentId = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as const
  const jobs: PostedJob[] = []
  for (const [index, p] of plan.pieces.entries()) {
    const job = await postJob(buyer, {
      prompt: p.prompt,
      model,
      maxPricePer1kOut: price,
      maxTokens: p.maxTokens,
      deadlineMs: 600_000,
      piece: { parentId, index, count: plan.pieces.length },
      ...(plan.kind === 'serial' && index > 0 ? { after: jobs[index - 1]!.id } : {}),
    })
    jobs.push(job)
    mark(`posted ${plan.kind} piece ${index + 1}/${plan.pieces.length} "${p.prompt}" → ${job.id.slice(0, 12)}… escrow ${job.escrowId.slice(0, 12)}… ${job.amountWei} wei`)
  }
  return jobs
}

const parallel = await postPlanned('1. hi\n2. hi')
const serial = await postPlanned('1. hi\n2. then hi')
const all = [...parallel, ...serial]
check('serial piece 2 names piece 1', serial[1]?.after === serial[0]?.id)

const grants = NO_MONEY ? [] : all.map((j) => grantOnClaim(buyer, j).catch((e) => (mark(`grant error: ${String(e)}`), null)))
const deliveredJobs = async () => {
  const receipts = await buyer.arkiv.query<Receipt>('receipt')
  return new Map(receipts.filter((r) => all.some((j) => j.id === r.jobId)).map((r) => [r.jobId, r]))
}

const deadline = Date.now() + 8 * 60_000
let receipts = await deliveredJobs()
let serialSecondDeliveredAfterFirst = true
while (receipts.size < all.length && Date.now() < deadline) {
  const r = await tick(worker).catch((e) => ({ claimed: 0, delivered: 0, settled: 0, error: String(e) }))
  if (r.delivered) mark(`worker delivered a piece (${receipts.size + 1}/${all.length})`)
  if (r.error) mark(`worker: ${r.error}`)
  receipts = await deliveredJobs()
  if (receipts.has(serial[1]!.id) && !receipts.has(serial[0]!.id)) serialSecondDeliveredAfterFirst = false
  if (!r.delivered) await new Promise((res) => setTimeout(res, 3_000))
}
await Promise.all(grants)

check('all 4 pieces delivered', receipts.size === all.length, `${receipts.size}/${all.length}`)
check('in-order step 2 never ran before step 1', serialSecondDeliveredAfterFirst)
// Another live seller may fairly take funded pieces; report who served each.
const servers = [...receipts.values()].map((r) => r.worker)
mark(`served by: ${[...new Set(servers)].join(', ')}`)
if (NO_MONEY) check('every unfunded piece served by our worker', servers.every((w) => w.toLowerCase() === worker.payout.toLowerCase()))

const rows = await Promise.all(
  all.map(async (j) => {
    const r = receipts.get(j.id)
    const outputText = r ? new TextDecoder().decode(await buyer.swarm.download(r.outputRef)) : undefined
    return { ...j, ...(outputText !== undefined ? { outputText } : {}) }
  }),
)
const joined = joinPieces(rows)
for (const j of joined) {
  console.log(`\n── joined ${j.parentId.slice(0, 12)}… (${j.complete ? 'complete' : j.partial ? 'PARTIAL' : 'incomplete'}) ──`)
  console.log(j.text || '(nothing)')
}
check('both split jobs join complete', joined.length === 2 && joined.every((j) => j.complete))

if (!NO_MONEY) {
  worker.settleState = { nextAtMs: 0 }
  const settled = await settleDue(worker).catch(() => 0)
  mark(`settled ${settled} deal(s)`)
}

if (worker.adState) await worker.arkiv.del(worker.adState.id).catch(() => {})

const ok = results.every((r) => r.ok)
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
console.log(ok ? 'LIVE RUN: YES' : 'LIVE RUN: NO')
process.exit(ok ? 0 : 1)
