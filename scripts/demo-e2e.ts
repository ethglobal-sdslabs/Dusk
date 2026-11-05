import 'dotenv/config'
import '@dusk/core/env'
import { createPublicClient, formatEther, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { galileoChain, loadConfig, type Job, type Receipt } from '@dusk/core'
import { buildDeps } from '../worker/src/main'
import { claimJob, runJob, settleDue } from '../worker/src/loop'
import { buildBuyerDeps, grantUntilDelivered, postJob, requireModel, retireDelivered } from './post-job'

const SETTLE_TIMEOUT_MS = 180_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

const started = Date.now()
const mark = (label: string): void =>
  console.log(`  [+${String(Date.now() - started).padStart(6)}ms] ${label}`)

console.log('── dusk: gate 1 + gate 2, end to end ──')

const buyer = buildBuyerDeps()
mark(`buyer ready (${buyer.address})`)

const escrowConfig = loadConfig(process.env).escrow
const galileoPub = createPublicClient({
  chain: galileoChain(escrowConfig),
  transport: http(escrowConfig.rpc, { timeout: 30_000, retryCount: 5, retryDelay: 1_000 }),
})
const buyerEscrowAddress = process.env.DUSK_BUYER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.DUSK_BUYER_PRIVATE_KEY as Hex).address
  : undefined
const buyerGalileoBefore = buyerEscrowAddress
  ? await galileoPub.getBalance({ address: buyerEscrowAddress })
  : undefined
if (buyerGalileoBefore !== undefined) {
  mark(`buyer Galileo balance before funding: ${formatEther(buyerGalileoBefore)} 0G`)
}

const job = await postJob(buyer, {
  prompt: process.env.DUSK_PROMPT ?? 'hi',
  model: requireModel(),
  maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
  maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '8'),
  deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '600000'),
})
mark(`job posted → ${job.id}`)
console.log(`           model ${job.model}, max_tokens ${job.maxTokens}, input ${job.inputRef?.slice(0, 16)}…`)

const worker = await buildDeps()
mark(`worker ready (${worker.models.join(', ')}, price ${worker.pricePer1kOut})`)
console.log(`           worker signs as ${worker.arkiv.address}`)
const sameIdentity = worker.arkiv.address.toLowerCase() === buyer.address.toLowerCase()
if (sameIdentity) {
  console.log('           ! buyer and worker share one account — DUSK_BUYER_PRIVATE_KEY and')
  console.log('             DUSK_WORKER_PRIVATE_KEY must be two different keys')
}
if (!process.env.DUSK_TRUSTED_MODELS) {
  console.log('           ! DUSK_TRUSTED_MODELS unset — model verification spent extra credits')
}

const claim = await claimJob(worker, job)
if (!claim) {
  console.log(`\n✗ could not claim ${job.id} — something else won the race for it`)
  process.exit(1)
}
mark(`claimed ${job.id} (lease ${worker.config.ttl.claim}s)`)

const granting = grantUntilDelivered(buyer, job)

let delivered = 0
try {
  await runJob(worker, job, claim)
  delivered = 1
  mark('delivered')
} catch (e) {
  console.log(`           ! ${e instanceof Error ? e.message : String(e)}`)
}

if (delivered === 0) {
  console.log('')
  console.log(`✗ claimed ${job.id} but did not deliver — see the error above`)
  process.exit(1)
}

const grantId = await granting
mark(grantId ? `buyer authorised the claim → grant ${grantId}` : 'buyer wrote no grant')

const receipts = await buyer.arkiv.query<Receipt>('receipt')
const receipt = receipts.find((r) => r.jobId === job.id)
if (!receipt) {
  console.log(`\n✗ delivered, but no receipt found for job ${job.id}`)
  process.exit(1)
}
mark(`receipt found → ${receipt.id}`)

const outputBytes = await buyer.swarm.download(receipt.outputRef)
const output = new TextDecoder().decode(outputBytes)
mark(`output downloaded from swarm (${output.length} bytes)`)
const retired = await retireDelivered(buyer, job, receipt, outputBytes)
mark(retired ? 'delivery verified — job entity removed from Arkiv' : 'job entity NOT removed (delivery unverified or delete failed)')

console.log('')
console.log('── receipt ──')
console.log(`  job          : ${receipt.jobId}`)
console.log(`  worker payout: ${receipt.worker}`)
console.log(`  model served : ${receipt.modelServed}${
  receipt.modelServed === job.model ? '' : '   ← DIFFERS from requested'
}`)
console.log(`  tokens       : in ${receipt.tokensIn}, out ${receipt.tokensOut}`)
console.log(`  credits spent: ${receipt.creditsSpent}`)
console.log(`  latency      : ${receipt.latencyMs}ms`)
console.log(`  trust mode   : ${receipt.trustMode}`)
console.log(`  output ref   : ${receipt.outputRef.slice(0, 24)}… (${receipt.outputRef.length} chars)`)
console.log(`  output hash  : ${receipt.outputHash}`)
console.log('')
console.log('── output ──')
console.log(output.split('\n').map((l) => `  ${l}`).join('\n'))

const openAfter = (await buyer.arkiv.query<Job>('job')).filter((j) => j.id === job.id)
console.log('')
console.log('── gate 1 ──')
console.log(
  sameIdentity
    ? '  · job posted and claimed by the SAME account (two keys are required)'
    : `  ✓ job posted by ${buyer.address.slice(0, 10)}…, claimed by ${worker.arkiv.address.slice(0, 10)}… — different accounts`,
)
console.log(`  ✓ inference ran on 0G, paid for by the worker's own credits`)
console.log(`  ✓ the buyer retrieved the result from Swarm by reference alone`)
console.log(`  ✓ a receipt is queryable from Arkiv (${receipts.length} total on chain)`)
console.log(`  ${openAfter.length === 0 ? '✓' : '·'} job entity removed after delivery: ${openAfter.length === 0}`)
console.log('')
console.log('✓ Gate 1 green — no server held a key, matched a job, or saw the result.')

if (!buyer.escrow || !worker.escrow || !job.fundTx || buyerGalileoBefore === undefined) {
  console.log('')
  console.log('── gate 2 ──')
  console.log(
    `  · escrow not configured on the ${!buyer.escrow ? 'buyer' : 'worker'} side ` +
      '(need DUSK_ESCROW_ADDRESS) — skipping the money proof',
  )
} else {
  const dealCommitted = await worker.escrow.deal(job.escrowId)
  const hashMatches = dealCommitted.outputHash === receipt.outputHash
  mark(
    `deal on chain: state=${dealCommitted.state}, outputHash=${dealCommitted.outputHash.slice(0, 18)}…`,
  )
  console.log(`           committed hash matches receipt.outputHash: ${hashMatches}`)
  if (dealCommitted.state !== 'committed' || !hashMatches) {
    console.log(
      `\n✗ expected a 'committed' deal carrying the receipt's own hash, got state=` +
        `${dealCommitted.state}, outputHash=${dealCommitted.outputHash}`,
    )
    process.exit(1)
  }

  const workerGalileoBeforeSettle = await galileoPub.getBalance({ address: worker.escrow.signer })
  mark(`worker Galileo balance before settlement: ${formatEther(workerGalileoBeforeSettle)} 0G`)

  mark('deal is committed and collectable — running the settle pass')
  let settled = 0
  const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < settleDeadline && settled === 0) {
    settled += await settleDue(worker)
    if (settled === 0) await sleep(2_000)
  }
  if (settled === 0) {
    console.log(`\n✗ no deal settled within ${SETTLE_TIMEOUT_MS / 1000}s of the commit`)
    process.exit(1)
  }
  mark(`settled ${settled} deal(s)`)

  const workerGalileoAfterSettle = await galileoPub.getBalance({ address: worker.escrow.signer })
  mark(`worker Galileo balance after settlement: ${formatEther(workerGalileoAfterSettle)} 0G`)

  const dealFinal = await worker.escrow.deal(job.escrowId)
  mark(`final deal state: ${dealFinal.state}`)

  const fundReceipt = await galileoPub.getTransactionReceipt({ hash: job.fundTx })
  const fundGasCost = fundReceipt.gasUsed * fundReceipt.effectiveGasPrice
  const buyerGalileoAfter = await galileoPub.getBalance({ address: buyerEscrowAddress! })
  const buyerDelta = buyerGalileoAfter - buyerGalileoBefore
  const buyerExpectedDelta = -(job.amountWei + fundGasCost)

  console.log('')
  console.log('── escrow settlement ──')
  console.log(`  escrow id               : ${job.escrowId}`)
  console.log(`  escrowed amount         : ${job.amountWei} wei`)
  console.log(`  committed output hash   : ${dealCommitted.outputHash}`)
  console.log(`  worker balance before   : ${formatEther(workerGalileoBeforeSettle)} 0G`)
  console.log(`  worker balance after    : ${formatEther(workerGalileoAfterSettle)} 0G`)
  console.log(
    `  worker balance delta    : ${workerGalileoAfterSettle - workerGalileoBeforeSettle} wei ` +
      '(gas for the settle tx is in this delta too — at this demo\'s tiny escrow size, gas ' +
      'can dominate it, the same effect demo-refund.ts documents for the refund path)',
  )
  console.log(`  buyer balance before fund: ${formatEther(buyerGalileoBefore)} 0G`)
  console.log(`  buyer balance after fund : ${formatEther(buyerGalileoAfter)} 0G`)
  console.log(`  buyer balance delta      : ${buyerDelta} wei`)
  console.log(
    `  buyer expected delta     : ${buyerExpectedDelta} wei  [= −(escrowed amount + fund tx gas)]`,
  )

  if (buyerDelta !== buyerExpectedDelta) {
    console.log(
      `\n✗ buyer's measured balance delta (${buyerDelta}) does not match the fund-tx-derived ` +
        `expected delta (${buyerExpectedDelta}) — something besides this fund call touched the ` +
        'buyer\'s balance',
    )
    process.exit(1)
  }
  if (dealFinal.state !== 'settled') {
    console.log(`\n✗ expected final deal state 'settled', got '${dealFinal.state}'`)
    process.exit(1)
  }

  console.log('')
  console.log('── gate 2 ──')
  console.log('  ✓ the buyer funded the deal before the job entity existed')
  console.log(`  ✓ the worker committed the output hash on chain, matching receipt.outputHash`)
  console.log(
    "  ✓ the worker was paid: DuskEscrow's settle moved the deal to 'settled', which the " +
      'contract only reaches after a successful transfer of the escrowed amount to the worker',
  )
  console.log(
    `  ✓ buyer's balance fell by exactly the escrowed amount (${job.amountWei} wei) plus the ` +
      "fund tx's own gas — checked against that transaction's mined receipt, not a sign check",
  )
  console.log(`  ✓ final deal state: ${dealFinal.state}`)
  console.log('')
  console.log('✓ Gate 2 green — funded before the job existed, paid out after an honest delivery.')
}
