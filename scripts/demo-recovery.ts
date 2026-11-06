import 'dotenv/config'
import '@dusk/core/env'
import { formatEther } from 'viem'
import { escrowDeadlineSec, type Claim } from '@dusk/core'
import { claimJob } from '../worker/src/loop'
import { buildDeps } from '../worker/src/main'
import { buildBuyerDeps, postJob, requireModel } from './post-job'

const started = Date.now()
const mark = (s: string): void =>
  console.log(`  [+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${s}`)

console.log('── dusk: worker death and recovery ──')

if (!process.env.DUSK_TRUSTED_MODELS?.trim()) {
  console.error(
    '\n✗ set DUSK_TRUSTED_MODELS before running this.\n\n' +
      '  This script builds worker deps twice, and `buildDeps()` without a trusted list\n' +
      '  calls `verifiedModels`, which bills one real completion per model the Router\n' +
      '  advertises. That would make this run cost credits — which is the one thing its\n' +
      '  own docstring promises it does not. Refusing is cheaper than apologising.\n\n' +
      '  DUSK_TRUSTED_MODELS=0gm-1.0-35b-a3b pnpm demo:recovery\n',
  )
  process.exit(1)
}

const buyer = buildBuyerDeps()
const job = await postJob(buyer, {
  prompt: 'hi',
  model: requireModel(),
  maxPricePer1kOut: 1_000_000n,
  maxTokens: 8,
  deadlineMs: 600_000,
})
mark(`buyer posted job ${job.id.slice(0, 18)}…`)

const a = await buildDeps()
const claim = await claimJob(a, job)
if (!claim) {
  console.log('✗ worker A could not claim the job')
  process.exit(1)
}
mark(`worker A claimed it (lease ${a.config.ttl.claim}s, claim ${claim.id.slice(0, 18)}…)`)

const live = (await a.arkiv.query<Claim>('claim')).filter((c) => c.jobId === job.id)
mark(`job now looks busy: ${live.length} live claim(s)`)

mark('worker A DIES here — no renewal, no cleanup, no notification to anyone')

const b = await buildDeps()
if (b.arkiv.address.toLowerCase() === a.arkiv.address.toLowerCase()) {
  console.log('           ! worker A and worker B are the same account')
  console.log(`             (${b.arkiv.address}, one workerId) — both leases are signed by`)
  console.log('             DUSK_WORKER_PRIVATE_KEY, so what this proves is a lease lapsing')
  console.log('             and the job returning to the market, not two rival participants')
}
const waitMs = (a.config.ttl.claim + 6) * 1000
mark(`worker B polling until the lease lapses (up to ${waitMs / 1000}s)…`)

let recovered = false
const deadline = Date.now() + waitMs
while (Date.now() < deadline) {
  const claims = (await b.arkiv.query<Claim>('claim')).filter((c) => c.jobId === job.id)
  if (claims.length === 0) {
    mark('the dead claim has expired — job is available again')
    const retaken = await claimJob(b, job)
    if (retaken) {
      mark(`worker B claimed it (${retaken.id.slice(0, 18)}…)`)
      recovered = true
    }
    break
  }
  await new Promise((r) => setTimeout(r, 5_000))
}

console.log('')
if (!recovered) {
  console.log(`✗ the claim did not lapse within ${waitMs / 1000}s — recovery is not working`)
  process.exit(1)
}

console.log('── what just happened ──')
console.log('  · no server detected the failure, because there is no server')
console.log('  · no timeout was configured anywhere in our code')
console.log("  · the claim's TTL was the whole mechanism: Arkiv expired it on schedule")
console.log('  · the job returned to the market without anyone reconciling anything')
console.log('')
console.log('✓ recovery proven — a dead worker costs the market one lease interval.')

for (const c of (await b.arkiv.query<Claim>('claim')).filter((x) => x.jobId === job.id)) {
  await b.arkiv.del(c.id).catch(() => {})
}
await b.arkiv.del(job.id).catch(() => {})

if (job.fundTx) {
  const refundableAtSec = escrowDeadlineSec(job.expiresAt)
  console.log('')
  console.log('── this run left real money on Galileo ──')
  console.log(`  escrow id      : ${job.escrowId}`)
  console.log(`  fund tx        : ${job.fundTx}`)
  console.log(`  amount escrowed: ${job.amountWei} wei (${formatEther(job.amountWei)} 0G)`)
  console.log(
    `  refundable from: ${new Date(refundableAtSec * 1000).toISOString()} ` +
      `(chain-second ${refundableAtSec}, exclusive)`,
  )
  console.log(
    '  the deal is still Funded and nothing will reclaim it automatically — call ' +
      `refund(${job.escrowId}) from DUSK_BUYER_PRIVATE_KEY after that time`,
  )
}
