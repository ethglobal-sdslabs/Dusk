import '@dusk/core/env'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, type Address, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { loadConfig, type ArkivStore, type IdentityMirror, type ModerationMirror } from '@dusk/core'
import { createArkivStore } from '@dusk/arkiv'
import { DuskIdentityControllerAbi, indexOnce, loadEnsConfig, mirrorsFromLogs, refreshMirrors, verifyIdentityMirror, verifyModerationMirror } from '@dusk/ens'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1] }
const here = dirname(fileURLToPath(import.meta.url))
const TTL_SECONDS = Number(process.env.ENS_MIRROR_TTL_SECONDS ?? 30 * 86_400)

async function main(): Promise<void> {
  if (!Number.isInteger(TTL_SECONDS) || TTL_SECONDS <= 0 || TTL_SECONDS % 2 !== 0) throw new Error('ENS_MIRROR_TTL_SECONDS must be a positive even number (2s Arkiv blocks)')
  const rpc = arg('--rpc')
  const ens = loadEnsConfig({ ...process.env, ...(rpc ? { ENS_RPC: rpc } : {}), ENS_MODE: 'display' })
  if (!ens.controller) throw new Error('ENS_CONTROLLER_ADDRESS is required')
  const controller = ens.controller
  const pub = createPublicClient({ chain: sepolia, transport: http(ens.rpc) })
  if ((await pub.getChainId()) !== ens.chainId) throw new Error(`ENS RPC is not chain ${ens.chainId}`)
  const namespaceRegistry = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY' }) as Address

  const checkpointPath = join(here, '..', '.dusk', `ens-index-${ens.chainId}-${controller.toLowerCase()}.json`)
  const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as { nextBlock: string; lastRefreshMs?: number } : undefined
  const saved = checkpoint ? BigInt(checkpoint.nextBlock) : undefined
  let lastRefreshMs = checkpoint?.lastRefreshMs ?? 0
  const explicit = arg('--from-block')
  const deployBlock = process.env.ENS_CONTROLLER_DEPLOY_BLOCK?.trim()
  let from = explicit ? BigInt(explicit) : saved ?? (deployBlock ? BigInt(deployBlock) : undefined)
  if (from === undefined) throw new Error('No checkpoint yet: pass --from-block <controller deployment block> or set ENS_CONTROLLER_DEPLOY_BLOCK')

  const chain = {
    finalizedBlock: async () => (await pub.getBlock({ blockTag: process.argv.includes('--latest') ? 'latest' : 'finalized' })).number!,
    getLogs: (a: { address: Address; fromBlock: bigint; toBlock: bigint }) => pub.getLogs(a),
  }

  if (process.argv.includes('--dry-run')) {
    const to = await chain.finalizedBlock()
    const logs = await chain.getLogs({ address: controller, fromBlock: from, toBlock: to })
    const { identities, moderations } = mirrorsFromLogs(ens, namespaceRegistry, logs)
    console.log(`── dry run: blocks ${from}–${to}, ${identities.length} identity and ${moderations.length} moderation rows (nothing written)`)
    for (const row of identities) {
      const ok = await verifyIdentityMirror(ens, pub, { ...row, id: '' } as IdentityMirror, namespaceRegistry)
      console.log(`  identity   ${row.ensName.padEnd(24)} ${row.wallet} gen ${row.generation}  verified=${ok}`)
    }
    for (const row of moderations) {
      const ok = await verifyModerationMirror(ens, pub, { ...row, id: '' } as ModerationMirror, namespaceRegistry)
      console.log(`  moderation ${row.action.padEnd(6)} ${row.subjectWallet} seq ${row.sequence}  verified=${ok}`)
    }
    return
  }

  const key = process.env.ENS_INDEXER_PRIVATE_KEY?.trim()
  if (!key) throw new Error('config.json operators.ensIndexerPrivateKey is required: the indexer writes Arkiv rows from its own account')
  const config = loadConfig(process.env)
  const arkiv = createArkivStore({
    rpc: config.arkiv.rpc, chainId: config.arkiv.chainId, privateKey: (key.startsWith('0x') ? key : `0x${key}`) as Hex,
    ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
  }) as ArkivStore & { address: Address }

  const watch = process.argv.includes('--watch')
  do {
    const out = await indexOnce({ config: ens, namespaceRegistry, arkiv, chain, ttlSeconds: TTL_SECONDS }, from)
    if (out.written || out.skipped) console.log(`  blocks ${from}–${out.nextBlock - 1n}: wrote ${out.written}, already mirrored ${out.skipped}`)
    from = out.nextBlock
    const extended = await refreshMirrors({ arkiv, ttlSeconds: TTL_SECONDS }, { nowMs: Date.now(), lastRefreshMs })
    if (extended > 0) { lastRefreshMs = Date.now(); console.log(`  extended ${extended} mirror rows by ${TTL_SECONDS}s`) }
    mkdirSync(dirname(checkpointPath), { recursive: true })
    writeFileSync(checkpointPath, JSON.stringify({ nextBlock: String(from), lastRefreshMs }))
    if (watch) await new Promise((r) => setTimeout(r, 60_000))
  } while (watch)
  console.log(`── indexed to block ${from - 1n}; checkpoint ${checkpointPath}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : 'Indexing failed; no URL is repeated here.')
  process.exitCode = 1
}
