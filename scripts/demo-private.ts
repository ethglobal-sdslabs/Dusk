import 'dotenv/config'
import '@dusk/core/env'
import type { Claim, Grant, Job, Receipt } from '@dusk/core'
import { buildDeps } from '../worker/src/main'
import { claimJob, runJob } from '../worker/src/loop'
import { buildBuyerDeps, grantUntilDelivered, postPrivateJob, requireModel, retireDelivered } from './post-job'

const TIMEOUT_MS = 180_000

const started = Date.now()
const mark = (label: string): void =>
  console.log(`  [+${String(Date.now() - started).padStart(6)}ms] ${label}`)

const PROMPT = process.env.DUSK_PROMPT ?? 'hi'

console.log('── dusk gate 3: the private path ──')
console.log('')

const buyer = buildBuyerDeps()
mark(`buyer ready (${buyer.address})`)

const job = await postPrivateJob(buyer, {
  prompt: PROMPT,
  model: requireModel(),
  maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
  maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '8'),
  deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '600000'),
})
mark(`private job posted → ${job.id}`)

if (!job.encryptedRef) {
  console.log('\n✗ postPrivateJob returned no encryptedRef — nothing to seal')
  process.exit(1)
}

const onChain = (await buyer.arkiv.query<Job>('job')).find((j) => j.id === job.id)
console.log('')
console.log('── what the chain shows about this job ──')
console.log(`  visibility : ${onChain?.visibility}`)
console.log(`  input ref  : ${onChain?.inputRef ?? '(absent — there is nothing to fetch)'}`)
console.log(`  input hash : ${onChain?.inputHash}  ← a commitment, not the content`)
console.log(`  buyer held : ${job.encryptedRef.slice(0, 24)}… (${job.encryptedRef.length} chars, never written)`)
if (onChain?.inputRef) {
  console.log('\n✗ the job entity carries an input reference — the prompt is readable from the chain')
  process.exit(1)
}

const worker = await buildDeps()
mark(`worker ready (${worker.models.join(', ')}, signs as ${worker.arkiv.address})`)
if (worker.arkiv.address.toLowerCase() === buyer.address.toLowerCase()) {
  console.log('           ! buyer and worker share one account — two keys are required')
}
if (!process.env.DUSK_TRUSTED_MODELS) {
  console.log('           ! DUSK_TRUSTED_MODELS unset — model verification spent extra credits')
}

const claim = await claimJob(worker, job)
if (!claim) {
  console.log('\n✗ the worker did not win its own claim (nobody else is running)')
  process.exit(1)
}
mark(`claimed, publishing pubkey ${claim.workerPubkey?.slice(0, 20)}… on the claim`)

mark('buyer now watches for the claim; worker now polls for a grant')

const [grantId] = await Promise.all([
  grantUntilDelivered(buyer, job, job.encryptedRef),
  (async (): Promise<Receipt> => {
    const r = await runJob(worker, job, claim)
    mark('worker delivered')
    return r
  })(),
])

if (!grantId) {
  console.log('\n✗ no grant was written — the buyer never saw a claim it would seal to')
  process.exit(1)
}
mark(`grant written → ${grantId}`)

const grant = (await buyer.arkiv.query<Grant>('grant')).find((g) => g.id === grantId)
console.log('')
console.log('── what the chain shows about the grant ──')
console.log(`  job id     : ${grant?.jobId}`)
console.log(`  worker id  : ${grant?.workerId}`)
console.log(
  `  sealed ref : ${grant!.sealedRef!.slice(0, 40)}… (${grant!.sealedRef!.length} chars)`,
)
console.log('               ↑ ciphertext. Opens with one key, which is not on the chain.')

const receipt = (await buyer.arkiv.query<Receipt>('receipt')).find((r) => r.jobId === job.id)
if (!receipt) {
  console.log(`\n✗ delivered, but no receipt found for job ${job.id}`)
  process.exit(1)
}
mark(`receipt found → ${receipt.id}`)

const sealedOutputRef = receipt.outputRef
let output: string
try {
  if (!buyer.unsealOutput) throw new Error('buyer has no unseal capability configured')
  const realRef = buyer.unsealOutput(sealedOutputRef as `0x${string}`)
  const outputBytes = await buyer.swarm.download(realRef)
  output = new TextDecoder().decode(outputBytes)
  mark(`output unsealed with the buyer's key and fetched (${output.length} bytes)`)
  const retired = await retireDelivered(buyer, job, receipt, outputBytes)
  mark(retired ? 'delivery verified — job entity removed from Arkiv' : 'job entity NOT removed (delivery unverified or delete failed)')
} catch (e) {
  console.log(`\n✗ the buyer could not open its own output: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}

console.log('')
console.log('── receipt ──')
console.log(`  job          : ${receipt.jobId}`)
console.log(`  worker payout: ${receipt.worker}`)
console.log(`  model served : ${receipt.modelServed}`)
console.log(`  tokens       : in ${receipt.tokensIn}, out ${receipt.tokensOut}`)
console.log(`  credits spent: ${receipt.creditsSpent}  ← the worker's own claim, not 0G's`)
console.log(`  output ref   : ${sealedOutputRef.slice(0, 40)}… (${sealedOutputRef.length} chars, sealed)`)
console.log(`  output hash  : ${receipt.outputHash}  ← a commitment, not the content`)

console.log('')
console.log('── output, readable only by the buyer ──')
console.log(output.split('\n').map((l) => `  ${l}`).join('\n'))

console.log('')
console.log('── gate 3, the private path ──')
console.log(`  ✓ the job entity carried no input reference — nothing on chain to fetch`)
console.log(`  ✓ the input reached the worker only through a grant sealed to its own key`)
console.log(`  ✓ the grant's payload is ciphertext, in the payload and never an attribute`)
console.log(`  ✓ the output came back sealed to the buyer, who opened it with its own key`)
console.log(`  ✓ a passive reader of Arkiv and Swarm learns two hashes and nothing else`)
console.log('')
console.log('  Not proved, and stated rather than glossed:')
console.log('  · This is not privacy from the worker. Whoever is granted the input reads')
console.log('    the prompt — it has to, to run it.')
console.log('  · On a permissionless order book the buyer picks that recipient from')
console.log('    unauthenticated data. Owner-binding proves a claim controls the account')
console.log('    it names; it does not prove the claimant deserves the job. One funded')
console.log('    Arkiv account can still claim a private job and be granted its input.')
console.log('  · Closing that needs stake or reputation bound to a worker identity.')
console.log('    DESIGN.md §3 carries the full statement.')
console.log('')
console.log('✓ Gate 3 core green — the private path works, with its limit written down.')

if (job.fundTx) {
  console.log('')
  console.log('── this run left real money on Galileo, Committed ──')
  console.log(`  escrow id      : ${job.escrowId}`)
  console.log(`  fund tx        : ${job.fundTx}`)
  console.log(`  amount escrowed: ${job.amountWei} wei`)
  console.log(
    '  collect it with `pnpm reclaim --mine --worker` — it signs with\n' +
      '  DUSK_WORKER_PRIVATE_KEY, which is who DuskEscrow pays.\n' +
      '  A running `pnpm worker` on the same key also collects it, from the receipt.',
  )
}

if (Date.now() - started > TIMEOUT_MS) {
  console.log(`\n! took longer than ${TIMEOUT_MS / 1000}s`)
}
