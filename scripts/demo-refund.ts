import 'dotenv/config'
import '@dusk/core/env'
import { createPublicClient, formatEther, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { escrowDeadlineSec, galileoChain, loadConfig, parseCreditBalance } from '@dusk/core'
import { createOgClient } from '@dusk/og'
import { EscrowRevertError } from '@dusk/escrow'
import { buildBuyerDeps, newEscrowId, postJob, StuckDealError, type PostedJob } from './post-job'

const started = Date.now()
const mark = (s: string): void =>
  console.log(`  [+${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${s}`)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)))

const DEADLINE_BUFFER_SEC = 6

console.log('── dusk: the refund path ──')

const buyer = buildBuyerDeps()
if (!buyer.escrow) {
  console.log('✗ no escrow configured — set DUSK_ESCROW_ADDRESS in .env')
  process.exit(1)
}
const escrow = buyer.escrow
const escrowSignerAddress = privateKeyToAccount(process.env.DUSK_BUYER_PRIVATE_KEY as Hex).address
mark(`buyer ready (arkiv ${buyer.address}, galileo escrow identity ${escrowSignerAddress})`)

const config = loadConfig(process.env)
const chain = galileoChain(config.escrow)
const pub = createPublicClient({
  chain,
  transport: http(config.escrow.rpc, { timeout: 30_000, retryCount: 5, retryDelay: 1_000 }),
})

const og =
  process.env.OG_BASE_URL_MAIN && process.env.OG_INFERE_MAIN && process.env.OG_MANAGE_MAIN
    ? createOgClient({
        baseUrl: process.env.OG_BASE_URL_MAIN,
        inferKey: process.env.OG_INFERE_MAIN,
        manageKey: process.env.OG_MANAGE_MAIN,
      })
    : undefined
if (!og) {
  console.log(
    '  ! OG_BASE_URL_MAIN/OG_INFERE_MAIN/OG_MANAGE_MAIN not all set — skipping the credit check',
  )
}

async function creditBalance(): Promise<bigint | undefined> {
  if (!og) return undefined
  try {
    return parseCreditBalance((await og.balance()).creditBalance)
  } catch (e) {
    console.log(`  ! could not read 0G credit balance: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

const creditsBefore = await creditBalance()
if (creditsBefore !== undefined) mark(`0G credit balance before: ${creditsBefore}`)

const galileoBefore = await pub.getBalance({ address: escrowSignerAddress })
mark(`buyer Galileo balance before: ${formatEther(galileoBefore)} 0G (${galileoBefore} wei)`)

const unclaimableModel = process.env.DUSK_UNCLAIMABLE_MODEL ?? 'dusk-demo/no-worker-will-ever-serve-this'

const escrowId = newEscrowId()
let job: PostedJob
try {
  job = await postJob(buyer, {
    prompt: 'hi',
    model: unclaimableModel,
    maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
    maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '8'),
    deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '120000'),
    escrowId,
  })
} catch (e) {
  console.log(`\n✗ postJob failed for escrow id ${escrowId}`)
  if (e instanceof StuckDealError) {
    if (e.funding === 'funded') {
      console.log(`  funded (tx ${e.fundTx}) but the job entity never got written`)
    } else if (e.fundTx) {
      console.log(`  fund's transaction (${e.fundTx}) did not mine before the receipt timeout`)
      console.log(`  it may still land — check ${e.fundTx} before assuming this id is unfunded`)
    } else {
      console.log('  fund failed with no transaction hash — probably nothing was broadcast')
    }
    console.log(`  ${e.message}`)
  } else if (e instanceof EscrowRevertError) {
    console.log(`  fund reverted: ${e.revertName} — nothing was sent, this escrow id was never funded`)
  } else {
    console.log('  no transaction hash is known for this attempt — see the error below')
    console.log(`  ${e instanceof Error ? e.message : String(e)}`)
  }
  throw e
}
mark(`job posted → ${job.id}`)
console.log(`           model ${job.model}`)
console.log(`           escrow id ${job.escrowId}`)
console.log(`           amount funded: ${job.amountWei} wei (fund tx ${job.fundTx ?? '(none)'})`)

if (!job.fundTx) {
  console.log('✗ job posted unfunded — nothing was escrowed, so there is nothing to refund')
  process.exit(1)
}

const galileoAfterFund = await pub.getBalance({ address: escrowSignerAddress })
mark(`buyer Galileo balance after funding: ${formatEther(galileoAfterFund)} 0G (${galileoAfterFund} wei)`)

const dealAfterFund = await escrow.deal(job.escrowId)
const onChainDeadlineSec = dealAfterFund.deadlineSec
const locallyComputedDeadlineSec = escrowDeadlineSec(job.expiresAt)
if (onChainDeadlineSec !== locallyComputedDeadlineSec) {
  console.log(
    `  ! on-chain deadline (${onChainDeadlineSec}) != locally computed (${locallyComputedDeadlineSec})`,
  )
}

const chainNowSec = Number((await pub.getBlock()).timestamp)
const waitSec = Math.max(0, onChainDeadlineSec - chainNowSec + DEADLINE_BUFFER_SEC)
mark(
  `deal deadline is chain-second ${onChainDeadlineSec}, chain is at ${chainNowSec} — waiting ${waitSec}s`,
)
await sleep(waitSec * 1000)

mark('deadline should have passed — calling refund')

let refundTx: `0x${string}`
try {
  refundTx = await escrow.refund(job.escrowId)
} catch (e) {
  if (e instanceof EscrowRevertError) {
    console.log(`\n✗ refund reverted: ${e.revertName}`)
    if (e.revertName === 'DeadlineNotReached') {
      console.log(
        '  the chain says the deadline has not passed — that is a real mismatch between ' +
          'job.expiresAt, escrowDeadlineSec, and the chain\'s own block.timestamp, not ' +
          'something to fix by waiting longer and trying again. Needs investigation.',
      )
    } else if (e.revertName === 'NotBuyer') {
      console.log('  signed with a key that is not deal.buyer — check DUSK_BUYER_PRIVATE_KEY')
    } else if (e.revertName === 'NotFunded') {
      console.log('  the deal is not in Funded state (already committed/refunded/settled?)')
    }
  } else {
    console.log(
      `\n✗ refund failed with no revert name — the chain was never reached or never ` +
        `answered; the transaction may still mine. ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  process.exit(1)
}
mark(`refund tx → ${refundTx}`)

const dealAfterRefund = await escrow.deal(job.escrowId)
mark(`deal state: ${dealAfterRefund.state}`)

const galileoAfterRefund = await pub.getBalance({ address: escrowSignerAddress })
mark(`buyer Galileo balance after refund: ${formatEther(galileoAfterRefund)} 0G (${galileoAfterRefund} wei)`)

const creditsAfter = await creditBalance()
if (creditsAfter !== undefined) mark(`0G credit balance after: ${creditsAfter}`)

const refundReceipt = await pub.getTransactionReceipt({ hash: refundTx })
const gasCost = refundReceipt.gasUsed * refundReceipt.effectiveGasPrice
const delta = galileoAfterRefund - galileoAfterFund
const expectedDelta = job.amountWei - gasCost

console.log('')
console.log('── balances ──')
console.log(`  before funding   : ${formatEther(galileoBefore)} 0G`)
console.log(`  after funding    : ${formatEther(galileoAfterFund)} 0G`)
console.log(`  after refund     : ${formatEther(galileoAfterRefund)} 0G`)
console.log(`  escrowed amount  : ${job.amountWei} wei`)
console.log(`  refund tx gas    : ${gasCost} wei (gasUsed ${refundReceipt.gasUsed} @ ${refundReceipt.effectiveGasPrice} wei/gas)`)
console.log(`  delta (measured) : ${delta} wei`)
console.log(`  delta (expected) : ${expectedDelta} wei  [= escrowed amount − refund tx gas]`)

if (delta !== expectedDelta) {
  console.log(
    `\n✗ measured delta (${delta}) does not match the receipt-derived expected delta ` +
      `(${expectedDelta}) — something besides this refund touched the buyer's balance`,
  )
  process.exit(1)
}
console.log('')
console.log(
  '  · at this escrow size, gas for one transaction outweighs the whole principal — the ' +
    'escrowed amount came back in full, but the net wei change is gas-dominated, not a ' +
    'visible "balance went up". The exact-equality check above is what actually proves ' +
    'the money came back: it is tied to the refund tx\'s own mined receipt, not a sign check.',
)

if (dealAfterRefund.state !== 'refunded') {
  console.log(`\n✗ expected deal state 'refunded', got '${dealAfterRefund.state}'`)
  process.exit(1)
}

if (creditsBefore !== undefined && creditsAfter !== undefined) {
  if (creditsBefore !== creditsAfter) {
    console.log(
      `\n! 0G credit balance moved (${creditsBefore} → ${creditsAfter}) even though this run made ` +
        'no completion — that points at activity outside this script, not at the refund path.',
    )
  } else {
    console.log(`  ✓ 0G credit balance unchanged (${creditsBefore}) — no completion was ever made`)
  }
} else if (creditsBefore !== undefined || creditsAfter !== undefined) {
  console.log('  ? could not confirm the credit balance was unchanged — only one of the two reads succeeded')
}

console.log('')
console.log('✓ refund proven — a job nobody could serve returned its escrowed money to the buyer.')

await buyer.arkiv.del(job.id).catch(() => {})
