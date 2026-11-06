import 'dotenv/config'
import '@dusk/core/env'
import { loadConfig } from '@dusk/core'
import { createEscrowClient } from '@dusk/escrow'
import type { Hex } from 'viem'

const config = loadConfig(process.env)
const argv = process.argv.slice(2)
const readOnly = argv.includes('--read')
const mine = argv.includes('--mine')
const asWorker = argv.includes('--worker')
const positional = argv.filter((a) => !a.startsWith('--')) as Hex[]

if (positional.length === 0 && !mine) {
  console.error(
    'usage: pnpm reclaim [--read] <escrowId> [escrowId…]\n' +
      '       pnpm reclaim --mine [--worker] [--read]\n\n' +
      '  --mine            enumerate from the chain instead of taking ids on the command line\n' +
      '  --worker          the worker side: deals left Committed, collected with settle\n' +
      '  --read            report state and change nothing',
  )
  process.exit(1)
}
if (!config.escrow.address) throw new Error('DUSK_ESCROW_ADDRESS is not set')

const keyName = asWorker ? 'DUSK_WORKER_PRIVATE_KEY' : 'DUSK_BUYER_PRIVATE_KEY'
const key = process.env[keyName] as Hex | undefined
if (!key) {
  throw new Error(
    `${keyName} is not set — it is the address ${asWorker ? 'settle' : 'refund'} pays`,
  )
}

const escrow = createEscrowClient({
  rpc: config.escrow.rpc,
  chainId: config.escrow.chainId,
  address: config.escrow.address,
  privateKey: key,
})

const nowSec = Math.floor(Date.now() / 1000)
console.log(`── ${config.escrow.address} on chain ${config.escrow.chainId}, signing as ${escrow.signer} ──`)

let ids = positional
if (mine) {
  const refs = asWorker
    ? await escrow.committedBy(escrow.signer)
    : await escrow.fundedBy(escrow.signer)
  const found = refs.map((r) => r.escrowId)
  ids = [...new Set([...positional, ...found])]
  console.log(
    `  found ${found.length} ${asWorker ? 'Committed' : 'Funded'} event(s) for this address` +
      (found.length === 0 ? ' — nothing to reclaim' : ''),
  )
}

for (const id of ids) {
  const deal = await escrow.deal(id)
  const refundableIn = deal.deadlineSec - nowSec
  console.log(
    `\n  ${id}\n    state ${deal.state}  amount ${deal.amount} wei  buyer ${deal.buyer}\n` +
      `    deadline ${new Date(deal.deadlineSec * 1000).toISOString()}` +
      (refundableIn > 0 ? `  (refundable in ${refundableIn}s)` : '  (passed)'),
  )
  if (readOnly) continue

  if (asWorker) {
    if (deal.state !== 'committed') {
      console.log('    nothing to collect: only a committed deal can be settled')
      continue
    }
    try {
      const tx = await escrow.settle(id)
      const after = await escrow.deal(id)
      console.log(`    settled — tx ${tx}, state now ${after.state}`)
    } catch (e) {
      console.log(`    settle failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    continue
  }

  if (deal.state !== 'funded') {
    console.log(`    nothing to reclaim: only a funded deal can be refunded`)
    continue
  }
  try {
    const tx = await escrow.refund(id)
    const after = await escrow.deal(id)
    console.log(`    refunded — tx ${tx}, state now ${after.state}, amount ${after.amount}`)
  } catch (e) {
    console.log(`    refund failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
