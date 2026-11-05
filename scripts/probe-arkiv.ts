import 'dotenv/config'
import '@dusk/core/env'
import { createPublicClient, http } from 'viem'
import { formatEther } from 'viem'
import { loadConfig, partyKeys, type Claim } from '@dusk/core'
import { arkivChain, attrEq, createArkivStore } from '@dusk/arkiv'
import { ARKIV_BLOCK_TIME_SEC, assertBlockAligned, driftRatio } from '../packages/core/src/expiry'

const config = loadConfig(process.env)
const { buyer, worker } = partyKeys(process.env)
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()

const transportInput = accessKey ? { accessKey } : {}
const chain = arkivChain(transportInput)
const pub = createPublicClient({ chain, transport: http() })

const mine = (k: `0x${string}`) =>
  createArkivStore({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, privateKey: k, ...transportInput })

const a = mine(worker)
const b = mine(buyer)

const line = (s = '') => console.log(s)
const step = (n: string) => line(`\n── ${n} ──`)

line('── arkiv probe ──')
line(`  chain id    : ${await pub.getChainId()} (configured ${config.arkiv.chainId})`)
line(`  endpoint    : ${config.arkiv.rpc}`)
line(`  access key  : ${accessKey ? 'set — the chain URL carries it' : 'none — public endpoint, heavily rate limited'}`)
line(`  writer A    : ${a.address}  ${formatEther(await pub.getBalance({ address: a.address }))} GLM`)
line(`  writer B    : ${b.address}  ${formatEther(await pub.getBalance({ address: b.address }))} GLM`)

step('block timing')
const SPAN = 50
const latest = await pub.getBlockNumber()
const [now, then] = await Promise.all([
  pub.getBlock({ blockNumber: latest }),
  pub.getBlock({ blockNumber: latest - BigInt(SPAN) }),
])
const measured = Number(now.timestamp - then.timestamp) / SPAN
line(`  ${SPAN} blocks took ${Number(now.timestamp - then.timestamp)}s → ${measured.toFixed(3)}s/block`)
line(`  ARKIV_BLOCK_TIME_SEC = ${ARKIV_BLOCK_TIME_SEC}, drift ratio ${driftRatio(ARKIV_BLOCK_TIME_SEC, measured).toFixed(3)}`)
line(`  a 90s claim therefore really lasts about ${(90 * (measured / ARKIV_BLOCK_TIME_SEC)).toFixed(0)}s`)

step('write, then read back through a filtered query')
const JOB = `0x${'ab'.repeat(32)}` as const
const TTL = assertBlockAligned(120)
const written = {
  jobId: JOB,
  workerId: `0x${'cd'.repeat(32)}`,
  price: 7n,
  claimedAt: 1_700_000_000_000,
  workerPubkey: `0x${'04'.repeat(65)}`,
}
const id = await a.put('claim', written, { ttlSeconds: TTL })
line(`  put claim → ${id}  (ttl ${TTL}s)`)

const rows = await a.query<Claim>('claim', attrEq('claim', 'jobId', JOB))
const got = rows.find((r) => r.id === id)
line(`  query(attrEq jobId) → ${rows.length} row(s); ours present: ${got !== undefined}`)
if (got) {
  line(`    owner          ${got.owner}  (engine-stamped; equals writer A: ${got.owner?.toLowerCase() === a.address.toLowerCase()})`)
  line(`    createdAtBlock ${got.createdAtBlock}  (engine-stamped — what winningClaim orders on)`)
  line(`    price          ${got.price} (${typeof got.price})`)
  line(`    claimedAt      ${got.claimedAt} (${typeof got.claimedAt})`)
  line(`    workerPubkey   ${String(got.workerPubkey).slice(0, 26)}…  (bytes column, stored not indexed)`)
  line(`    round-trip exact: ${
    got.jobId === written.jobId &&
    got.price === written.price &&
    got.claimedAt === written.claimedAt &&
    String(got.workerPubkey).toLowerCase() === written.workerPubkey
  }`)
}

step('a filter on a bytes column')
try {
  attrEq('claim', 'workerPubkey', written.workerPubkey)
  line('  built one — UNEXPECTED, a bytes column is never indexed')
} catch (e) {
  line(`  refused before any request: ${e instanceof Error ? e.message.split('.')[0] : String(e)}`)
}

step('extend extends; shortening reverts')
await a.extend(id, assertBlockAligned(300))
line('  extend to 300s: ok')
try {
  await a.extend(id, assertBlockAligned(60))
  line('  shorten to 60s: ACCEPTED — the engine no longer reverts a shortening')
} catch (e) {
  line(`  shorten to 60s: reverted, as expected (${e instanceof Error ? e.name : 'error'})`)
}

step('a non-owner')
try {
  await b.del(id)
  line('  writer B deleted writer A’s entity: UNEXPECTED')
} catch (e) {
  line(`  writer B cannot delete writer A's entity (${e instanceof Error ? e.name : 'error'})`)
}

step('cleanup')
await a.del(id)
const after = (await a.query<Claim>('claim', attrEq('claim', 'jobId', JOB))).some((r) => r.id === id)
line(`  deleted; still visible: ${after}`)
line('\n✓ probe complete — nothing above is asserted, it is reported.')
