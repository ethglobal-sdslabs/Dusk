import 'dotenv/config'
import '@dusk/core/env'
import { attrCmp, attrEq, createArkivReader } from '@dusk/arkiv'
import { loadConfig, type Receipt, type WorkerAd } from '@dusk/core'
import { lte } from '@arkiv-network/sdk/query'

const config = loadConfig(process.env)

const MAX_PRICE = BigInt(process.env.DUSK_QUERY_MAX_PRICE ?? '1000000')
const MODEL = process.env.DUSK_QUERY_MODEL ?? '0gm-1.0-35b-a3b'
const worker = (process.argv[2] ?? process.env.DUSK_WORKER_ADDRESS) as `0x${string}` | undefined

const reader = createArkivReader({
  rpc: config.arkiv.rpc,
  chainId: config.arkiv.chainId,
  ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
})

console.log(`── live supply ──  ${config.arkiv.rpc}  (chain ${config.arkiv.chainId})`)
console.log(`   filter: price_per_1k_out <= ${MAX_PRICE} (u256, server-side via attrCmp)`)
console.log(`   then:   serves ${MODEL}, credits bucket not '<10%' (client-side)\n`)

const ads = await reader.query<WorkerAd>('worker', attrCmp('worker', 'pricePer1kOut', lte, MAX_PRICE))
const live = ads
  .filter((ad) => ad.models.includes(MODEL) && ad.creditsBucket !== '<10%')
  .sort((a, b) => (a.pricePer1kOut < b.pricePer1kOut ? -1 : a.pricePer1kOut > b.pricePer1kOut ? 1 : 0))

if (ads.length === 0) {
  console.log('   (nobody is advertising right now — a worker ad lives 120s, so this is what')
  console.log('    a quiet night looks like. Run `pnpm worker`, or open /earn, and re-run.)')
} else {
  console.log('   payout                                      price/1k out  credits  models')
  for (const ad of live) {
    console.log(
      `   ${ad.payout}  ${String(ad.pricePer1kOut).padStart(12)}  ${(ad.creditsBucket ?? '?').padStart(7)}  ${ad.models.join(', ')}`,
    )
  }
  console.log(`\n   ${ads.length} ad(s) under the price cap, ${live.length} of them serving ${MODEL}`)
}

console.log(`\n── receipts ──  the 7-day reputation window; older work is gone, not hidden`)
if (worker) console.log(`   filter: worker = addr(${worker})  — the tag is why this matches at all (#20)`)
const receipts = await reader.query<Receipt>(
  'receipt',
  ...(worker ? [attrEq('receipt', 'worker', worker)] : []),
)
for (const r of receipts) {
  console.log(`   ${r.jobId.slice(0, 10)}…  ${r.modelServed}  out ${r.tokensOut}  spent ${r.creditsSpent}  ${r.worker}`)
}
console.log(`\n   ${receipts.length} receipt(s). \`credits_spent\` is the worker's own figure, not an attestation`)
console.log(`   from 0G — where it reads tokens:in/out it is a labelled proxy.`)
