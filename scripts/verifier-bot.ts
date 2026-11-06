import 'dotenv/config'
import '@dusk/core/env'
import { createPublicClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { attrEq, createArkivReader } from '@dusk/arkiv'
import { galileoChain, loadConfig, type Job, type Receipt } from '@dusk/core'
import { createEscrowClient, DUSK_ESCROW_ABI } from '@dusk/escrow'
import { onChainServiceReader } from '@dusk/og/sealed'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { judgeCommit } from '@dusk/buyer/verify'
import { canaryEveryMs, runCanaryLoop } from './canary'

const env = process.env as Record<string, string>
const config = loadConfig(env)
const key = env['DUSK_VERIFIER_PRIVATE_KEY'] as Hex | undefined
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DUSK_VERIFIER_PRIVATE_KEY must be a 0x-prefixed 32-byte key')
if (!config.escrow.address) throw new Error('DUSK_ESCROW_ADDRESS is not set')
const me = privateKeyToAccount(key).address

const escrow = createEscrowClient({ rpc: config.escrow.rpc, chainId: config.escrow.chainId, address: config.escrow.address, privateKey: key })
const pub = createPublicClient({ chain: galileoChain(config.escrow), transport: http(config.escrow.rpc) })
const reader = createArkivReader({
  rpc: config.arkiv.rpc,
  chainId: config.arkiv.chainId,
  ...(env['ARKIV_ACCESS_KEY'] ? { accessKey: env['ARKIV_ACCESS_KEY'] } : {}),
})
const swarm = createSwarmStore({
  uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
  downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
})
const readService = onChainServiceReader({ rpc: config.og.teeProof.rpc, servingContract: config.og.teeProof.servingContract })

const LOOKBACK_BLOCKS = BigInt(env['DUSK_VERIFIER_LOOKBACK_BLOCKS'] ?? '5000')
const done = new Set<Hex>()

const lastSaid = new Map<string, string>()
async function pass(window: number): Promise<void> {
  const latest = await pub.getBlockNumber()
  const logs = await pub.getContractEvents({
    address: config.escrow.address!,
    abi: DUSK_ESCROW_ABI,
    eventName: 'Committed',
    fromBlock: latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n,
    toBlock: latest,
  })
  const ids = [...new Set(logs.map((l) => (l.args as { jobId: Hex }).jobId))].filter((id) => !done.has(id))
  if (ids.length === 0) return
  const jobs = await reader.query<Job>('job')
  const nowSec = Math.floor(Date.now() / 1000)

  for (const id of ids) {
    const deal = await escrow.deal(id)
    if (deal.state !== 'committed' || nowSec > deal.commitAtSec + window) {
      done.add(id)
      continue
    }
    const receipts = (await reader.query<Receipt>('receipt', attrEq('receipt', 'escrowId', id))).filter((r) => r.escrowId === id)
    const job = jobs.find((j) => receipts.some((r) => r.jobId === j.id))
    const j = await judgeCommit(deal, receipts, job, { swarm, readService, imageModels: config.og.imageModels }, { nowSec, graceSec: Math.floor(window / 2) })
    const tag = `[verifier] ${id.slice(0, 10)}… worker ${deal.worker.slice(0, 10)}…`
    if (j.verdict === 'abstain') {
      // Every pass re-reads every deal in its window; say an abstention once, not every 10s.
      if (lastSaid.get(id) !== j.reason) console.log(`${tag} abstain — ${j.reason}`)
      lastSaid.set(id, j.reason)
      continue
    }
    try {
      if (j.verdict === 'invalid') {
        await escrow.reject(id, await escrow.signVerdict(id, deal.outputHash, false))
        console.log(`${tag} REJECTED — buyer refunded. ${j.reason}`)
      } else {
        await escrow.settleVerified(id, await escrow.signVerdict(id, deal.outputHash, true))
        console.log(`${tag} verified — worker paid. ${j.reason}`)
      }
      done.add(id)
    } catch (e) {
      console.error(`${tag} ${j.verdict} verdict could not be submitted: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

const onChainVerifier = (await pub.readContract({ address: config.escrow.address, abi: DUSK_ESCROW_ABI, functionName: 'VERIFIER' })) as string
if (onChainVerifier.toLowerCase() !== me.toLowerCase()) {
  throw new Error(`this key is ${me}, but the escrow's VERIFIER is ${onChainVerifier} — its verdicts would revert NotVerifier`)
}
const window = Number(await pub.readContract({ address: config.escrow.address, abi: DUSK_ESCROW_ABI, functionName: 'CHALLENGE_WINDOW' }))
console.log(`── dusk verifier ──  ${me}  escrow ${config.escrow.address}  window ${window}s`)
// Canary jobs start with the verifier, which has to stay running anyway: one every
// DUSK_CANARY_EVERY (default 5m, `off` disables), signed by this same key. A canary
// failure is logged and never stops the verdict loop below.
const canaryEvery = env['PASS_ONCE'] === '1' ? null : canaryEveryMs(env)
if (canaryEvery !== null) void runCanaryLoop(canaryEvery)
else console.log('[canary] off')
for (;;) {
  await pass(window).catch((e) => console.error(`[verifier] pass failed: ${e instanceof Error ? e.message : String(e)}`))
  if (env['PASS_ONCE'] === '1') break
  await new Promise((r) => setTimeout(r, 10_000))
}
