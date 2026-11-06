import 'dotenv/config'
import '@dusk/core/env'
import { keccak256, toHex, type Hex } from 'viem'
import { attrEq, createArkivReader } from '@dusk/arkiv'
import { loadConfig, partyKey, type Job, type Receipt } from '@dusk/core'
import { onChainServiceReader } from '@dusk/og/sealed'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { ProofError, verifyReceiptProof } from '@dusk/buyer/verify'

const args = process.argv.slice(2)
const jobId = args[0]
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
if (!jobId) {
  console.error('usage: pnpm verify <jobId> [--prompt …] [--model …] [--max-tokens …]')
  process.exit(2)
}

const config = loadConfig(process.env as Record<string, string>)
const reader = createArkivReader({
  rpc: config.arkiv.rpc,
  chainId: config.arkiv.chainId,
  ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
})

const receipts = await reader.query<Receipt>('receipt', attrEq('receipt', 'jobId', jobId))
const receipt = receipts.find((r) => r.jobId === jobId)
if (!receipt) {
  console.error(`✗ no receipt for job ${jobId} — not delivered, or its 7-day receipt has lapsed`)
  process.exit(1)
}

const live = (await reader.query<Job>('job')).find((j) => j.id === jobId)
const prompt = flag('prompt')
const job = {
  id: jobId,
  model: flag('model') ?? live?.model,
  maxTokens: Number(flag('max-tokens') ?? live?.maxTokens),
  inputHash: prompt !== undefined ? keccak256(toHex(prompt)) : live?.inputHash,
  visibility: live?.visibility ?? receipt.visibility ?? 'public',
}
if (!job.model || !Number.isFinite(job.maxTokens) || !job.inputHash) {
  console.error(`✗ job ${jobId} has expired from Arkiv; pass --prompt, --model and --max-tokens to say what you asked for`)
  process.exit(1)
}

const swarm = createSwarmStore({
  uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
  downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
})
const tee = config.og.teeProof
try {
  const v = await verifyReceiptProof(job as Job, receipt, {
    swarm,
    readService: onChainServiceReader({ rpc: tee.rpc, servingContract: tee.servingContract }),
    ...(job.visibility === 'private' ? { buyerKey: partyKey(process.env as Record<string, string>, 'buyer') as Hex } : {}),
  })
  console.log(`✓ job ${jobId} verified by 0G TEE ${v.teeSigner} (provider ${v.provider})`)
  console.log(`  model      : ${v.model}  (asked ${job.model})`)
  console.log(`  max_tokens : ${v.maxTokens}`)
  console.log(`  prompt     : matches inputHash ${job.inputHash}${job.visibility === 'private' ? '' : ` — "${v.prompt}"`}`)
  console.log(`  output     : matches outputHash ${receipt.outputHash}`)
} catch (e) {
  console.error(`✗ ${e instanceof ProofError ? e.message : `verification could not run: ${e instanceof Error ? e.message : String(e)}`}`)
  process.exit(1)
}
