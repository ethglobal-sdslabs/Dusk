import 'dotenv/config'
import '@dusk/core/env'
import { createArkivReader } from '@dusk/arkiv'
import { loadConfig } from '@dusk/core'
const config = loadConfig(process.env)
const r = createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId,
  ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}) })
const s = (x: unknown) => JSON.stringify(x, (_k, v) => typeof v === 'bigint' ? v.toString() : (typeof v === 'string' && v.length > 70 ? v.slice(0, 18) + '…(' + v.length + ')' : v))
for (const kind of ['worker', 'job', 'claim', 'grant', 'receipt'] as const) {
  const rows = await r.query<any>(kind)
  console.log(`\n== ${kind} (${rows.length})`)
  for (const row of rows) console.log(s(row))
}
console.log('\nnow', Date.now())
