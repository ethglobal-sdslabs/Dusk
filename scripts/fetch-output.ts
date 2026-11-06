import 'dotenv/config'
import '@dusk/core/env'
import { attrEq, createArkivReader } from '@dusk/arkiv'
import { createSwarmStore } from '@dusk/swarm'
import { loadConfig } from '@dusk/core'
import { eq } from '@arkiv-network/sdk/query'

const config = loadConfig(process.env)
const jobId = process.argv[2]
const reader = createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId })
const swarm = createSwarmStore({
  uploadUrl: 'https://api.gateway.ethswarm.org',
  downloadUrl: 'https://download.gateway.ethswarm.org',
})

const receipts = await reader.query<any>('receipt', attrEq('receipt', 'jobId', jobId) as any)
for (const r of receipts) {
  console.log('output_ref:', r.outputRef ?? r.output_ref ?? JSON.stringify(r).slice(0, 400))
}
if (receipts.length === 0) {
  const all = await reader.query<any>('receipt')
  for (const r of all) {
    if ((r.jobId ?? '').startsWith((jobId ?? '').slice(0, 12))) {
      console.log(JSON.stringify(r, null, 2).slice(0, 800))
      if (r.outputRef || r.output_ref) {
        const ref = r.outputRef ?? r.output_ref
        const data = await swarm.download(ref)
        console.log('--- OUTPUT ---')
        console.log(new TextDecoder().decode(data))
      }
    }
  }
}
