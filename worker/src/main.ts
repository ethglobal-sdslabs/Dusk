import 'dotenv/config'
import { credentialsFromFileSummary } from '@dusk/core/env'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { unseal } from '@dusk/crypto'
import { isImageModel, loadConfig, parseCreditBalance, partyKey, refuseImageModels } from '@dusk/core'
import { createArkivStore, type DuskArkivStore } from '@dusk/arkiv'
import { createOgClient, verifiedModels } from '@dusk/og'
import { createSealedOgClient, onChainServiceReader, routeByTrust } from '@dusk/og/sealed'
import { createEscrowClient, type DuskEscrowClient } from '@dusk/escrow'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { forgetAd, runWorker, type WorkerDeps } from './loop'
import { resolvePayout } from './payout'
import { admitFromEnv, createEnsReader, loadEnsConfig } from '@dusk/ens'
import { fallbackDelayMsFrom, fallbackPrice, reservePricePer1kFrom } from './fallback'
import { defaultUnitsPerTokenFrom, newBudget } from './budget'

const FROM_CONFIG_JSON: Record<string, string> = {
  OG_INFERE_MAIN: 'og.computeKey in config.json',
  OG_MANAGE_MAIN: 'og.accessKey in config.json',
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    const where = FROM_CONFIG_JSON[name] ?? `${name} in .env (copy .env.example)`
    throw new Error(`${name} is not set — fill in ${where}`)
  }
  return v
}

export async function buildDeps(): Promise<
  WorkerDeps & { arkiv: DuskArkivStore; escrow?: DuskEscrowClient }
> {
  const config = loadConfig(process.env)
  const fallbackDelay = fallbackDelayMsFrom(process.env)
  const reservePrice = fallbackPrice(fallbackDelay, reservePricePer1kFrom(process.env))
  const unitsPerToken = defaultUnitsPerTokenFrom(process.env)

  const workerKey = partyKey(process.env, 'worker')

  const arkiv = createArkivStore({
    rpc: config.arkiv.rpc,
    chainId: config.arkiv.chainId,
    privateKey: workerKey,
    ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
  })

  const ogConfig = {
    baseUrl: required('OG_BASE_URL_MAIN'),
    inferKey: required('OG_INFERE_MAIN'),
    ...(process.env.OG_MANAGE_MAIN ? { manageKey: process.env.OG_MANAGE_MAIN } : {}),
  }
  const tee = config.og.teeProof
  const og = tee.enabled
    ? routeByTrust(
        createOgClient(ogConfig),
        createSealedOgClient({
          ...ogConfig,
          routerUrl: tee.routerUrl,
          readService: onChainServiceReader({ rpc: tee.rpc, servingContract: tee.servingContract }),
        }),
      )
    : createOgClient(ogConfig)

  const swarm = createSwarmStore({
    uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
    downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
    ...(config.swarm.batchId ? { batchId: config.swarm.batchId } : {}),
  })

  const trusted = process.env.DUSK_TRUSTED_MODELS?.split(',').map((m) => m.trim()).filter(Boolean)
  if (trusted?.length) refuseImageModels(trusted, config.og.imageModels)
  const models = trusted?.length
    ? trusted
    : await verifiedModels(
        og,
        (await og.models()).filter((m) => !isImageModel(m, config.og.imageModels)),
      )

  if (models.length === 0) {
    throw new Error('no servable models: every advertised model failed a test completion')
  }

  let dayStartCredits = 0n
  try {
    dayStartCredits = parseCreditBalance((await og.balance()).creditBalance)
  } catch {
  }

  const escrow = config.escrow.address
    ? createEscrowClient({
        rpc: config.escrow.rpc,
        chainId: config.escrow.chainId,
        address: config.escrow.address,
        privateKey: workerKey,
      })
    : undefined
  if (!escrow) {
    console.log(
      '  ! no escrow configured (need DUSK_ESCROW_ADDRESS) — this worker will deliver UNPAID',
    )
  }

  const payout = resolvePayout({
    ...(escrow ? { escrowSigner: escrow.signer } : {}),
    arkivAddress: privateKeyToAccount(workerKey).address,
    ...(process.env.DUSK_PAYOUT_ADDRESS
      ? { configured: process.env.DUSK_PAYOUT_ADDRESS as Address }
      : {}),
  })

  return {
    arkiv,
    og,
    swarm,
    config,
    workerId: keccak256(toHex(arkiv.address)),
    pubkey: privateKeyToAccount(workerKey).publicKey,
    unsealInput: (sealed) => unseal(sealed, workerKey),
    payout,
    pricePer1kOut: reservePrice ?? BigInt(process.env.DUSK_PRICE_PER_1K_OUT ?? '1'),
    models,
    dayStartCredits,
    now: () => Date.now(),
    escrow,
    deliverMarginMs: config.ttl.claim * 1000,
    provesTee: tee.enabled,
    ...ensAdmit(),
    ...(fallbackDelay !== undefined ? { fallbackDelayMs: fallbackDelay } : {}),
    budget: newBudget(unitsPerToken),
  }
}

function ensAdmit(): Pick<WorkerDeps, 'admit'> {
  return { admit: admitFromEnv(process.env, createEnsReader) }
}

async function main(): Promise<void> {
  const deps = await buildDeps()
  const controller = new AbortController()

  console.log('── dusk worker ──')
  console.log(`  config.json   : ${credentialsFromFileSummary()}`)
  console.log(`  arkiv address : ${deps.arkiv.address}`)
  console.log(`  worker id     : ${deps.workerId}`)
  console.log(`  payout        : ${deps.payout}`)
  console.log(
    `  escrow        : ${deps.escrow ? deps.config.escrow.address : 'NOT CONFIGURED — delivering unpaid'}`,
  )
  console.log(`  models        : ${deps.models.join(', ')}`)
  console.log(
    `  tee proof     : ${
      deps.provesTee
        ? 'ON — sealed client-side, enclave signature checked per job, proof linked on each receipt'
        : 'OFF (DUSK_TEE_PROOF=0) — no proof of what ran; TEE (private-tier) jobs are skipped'
    }`,
  )
  console.log(`  price/1k out  : ${deps.pricePer1kOut}`)
  console.log(`  credits bucket: based on ${deps.dayStartCredits} at window start`)
  console.log(`  claim lease   : ${deps.config.ttl.claim}s, renewed at half`)
  console.log(`  ens admission : ${deps.admit ? `on (${loadEnsConfig(process.env).mode})` : 'off'}`)
  console.log(
    `  affordability : checked before every claim (${deps.budget?.defaultUnitsPerToken} units/token until measured` +
      `${process.env.OG_MANAGE_MAIN ? '' : '; NO management key — check is off'})`,
  )
  if (deps.fallbackDelayMs !== undefined) {
    console.log(
      `  FALLBACK MODE : sells at cost (${process.env.DUSK_RESERVE_COST_WEI} wei for ` +
        `${process.env.DUSK_RESERVE_TOKENS} tokens → ${deps.pricePer1kOut} wei per 1,000, ` +
        'DUSK_PRICE_PER_1K_OUT ignored); ' +
        `only claims jobs left unclaimed for ${deps.fallbackDelayMs / 1000}s — ` +
        'a backstop for what ordinary sellers cannot serve',
    )
  }
  console.log('  polling every 5s. ctrl-c to stop.')

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('\n  stopping — removing this worker from the supply list…')
    controller.abort()
  })

  await runWorker(deps, { intervalMs: 5_000, signal: controller.signal })

  if (deps.adState) await deps.arkiv.del(deps.adState.id).catch(() => {})
  forgetAd(deps)
  console.log('  stopped.')
}

if (process.argv[1]?.endsWith('main.ts')) {
  await main()
}
