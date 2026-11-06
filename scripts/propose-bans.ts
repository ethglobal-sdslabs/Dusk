import '@dusk/core/env'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createPublicClient, getAddress, http, keccak256, toHex, type Address, type Hex } from 'viem'
import { loadConfig, type Claim, type Deal, type Grant, type Job, type Receipt } from '@dusk/core'
import { createArkivReader } from '@dusk/arkiv'
import { createEscrowHistory } from '@dusk/escrow'
import { createEnsReader, loadEnsConfig, proposeBans, REPUTATION_POLICY, type VerifiedIdentity } from '@dusk/ens'

const config = loadConfig(process.env)
if (!config.escrow.address) throw new Error('DUSK_ESCROW_ADDRESS is required: deals are the evidence')
const reader = createArkivReader({ rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}) })
const history = createEscrowHistory({ rpc: config.escrow.rpc, chainId: config.escrow.chainId, address: config.escrow.address })

const [receipts, grants, claims, jobs, committed] = await Promise.all([
  reader.query<Receipt>('receipt'),
  reader.query<Grant>('grant'),
  reader.query<Claim>('claim'),
  reader.query<Job>('job'),
  history.events('Committed'),
])

const known = new Set<string>([...claims, ...receipts].flatMap((e) => (e.owner ? [e.owner.toLowerCase()] : [])))
for (const c of committed) known.add(c.party.toLowerCase())
const byHash = new Map<string, Address>()
for (const a of known) for (const spelling of [a, getAddress(a)]) byHash.set(keccak256(toHex(spelling)).toLowerCase(), a as Address)
const escrowOfJob = new Map(jobs.map((j) => [j.id.toLowerCase(), j.escrowId]))

const arkivPub = createPublicClient({ transport: http(config.arkiv.rpc) })
const blockTime = new Map<bigint, number | undefined>()
async function timeOf(block: bigint | undefined): Promise<number | undefined> {
  if (block === undefined) return undefined
  if (!blockTime.has(block)) {
    try { blockTime.set(block, Number((await arkivPub.getBlock({ blockNumber: block })).timestamp)) } catch { blockTime.set(block, undefined) }
  }
  return blockTime.get(block)
}
const resolvedGrants: Array<{ owner: Address; escrowId: Hex; worker: Address; grantedAtSec?: number }> = []
for (const g of grants) {
  const worker = byHash.get(g.workerId.toLowerCase())
  const escrowId = escrowOfJob.get(g.jobId.toLowerCase())
  if (!worker || !escrowId || !g.owner) continue
  const grantedAtSec = await timeOf(g.createdAtBlock)
  resolvedGrants.push({ owner: g.owner, escrowId, worker, ...(grantedAtSec !== undefined ? { grantedAtSec } : {}) })
}

const ids = new Set<string>([...receipts.map((r) => r.escrowId), ...resolvedGrants.map((g) => g.escrowId)].map((x) => x.toLowerCase()))
const deals = new Map<string, Deal>()
for (const id of ids) {
  try { deals.set(id, await history.deal(id as Hex)) } catch { }
}

let exclude: Set<string> | undefined
let verifiedBuyers: Set<string> | undefined
if (process.env.ENS_CONTROLLER_ADDRESS?.trim()) {
  const ens = createEnsReader(loadEnsConfig({ ...process.env, ENS_MODE: 'display' }))
  exclude = new Set()
  verifiedBuyers = new Set()
  const buyers = new Set(resolvedGrants.map((g) => g.owner.toLowerCase()))
  for (const w of new Set([...known, ...buyers])) {
    const identity: VerifiedIdentity = await ens.identityOf(w as Address)
    if (identity.status === 'banned') exclude.add(w)
    if (identity.status === 'active' && buyers.has(w)) verifiedBuyers.add(w)
  }
} else {
  console.warn('   ENS_CONTROLLER_ADDRESS unset: ban state and buyer identities were NOT checked, so a banned wallet can reappear and every buyer address counts as distinct.')
}

const proposals = proposeBans({ deals, receipts, grants: resolvedGrants, nowSec: Math.floor(Date.now() / 1000), ...(exclude ? { exclude } : {}), ...(verifiedBuyers ? { verifiedBuyers } : {}) })

console.log(`── ban proposals · ${REPUTATION_POLICY.id} · OBSERVATION ONLY — nothing is sent`)
console.log(`   evidence: ${receipts.length} receipts · ${resolvedGrants.length}/${grants.length} grants resolved · ${deals.size} deals read`)
if (proposals.length === 0) console.log('   no wallet meets the policy.')
mkdirSync('.dusk/proposals', { recursive: true })
for (const p of proposals) {
  const file = `.dusk/proposals/${p.decisionId}.json`
  writeFileSync(file, p.evidence)
  console.log(`\n   ${p.wallet}  reason ${p.reasonCode}  ${p.signals.map((s) => s.kind + (s.kind === 'granted-not-committed' ? ' (buyer-influenced: check the jobs before acting)' : '')).join(', ')}`)
  console.log(`   evidence ${file}  (${p.evidenceHash})`)
  console.log(`   to act after review: pnpm ens:revoke ${p.wallet} --decision ${p.decisionId} --reason ${p.reasonCode} --evidence-file ${file}`)
}
if (process.argv.includes('--json')) console.log(JSON.stringify(proposals))
