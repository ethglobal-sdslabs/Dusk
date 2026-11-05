import 'dotenv/config'
import '@dusk/core/env'
import type { EscrowClient, Receipt } from '@dusk/core'
import { loadConfig, partyKey } from '@dusk/core'
import { attrEq, createArkivStore } from '@dusk/arkiv'
import { unseal } from '@dusk/crypto'
import { createEscrowClient } from '@dusk/escrow'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { admitFromEnv, createEnsReader } from '@dusk/ens'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { grantUntilDelivered, postJob, retireDelivered, StuckDealError, type BuyerDeps } from '@dusk/buyer'

export {
  DeadlineOutlivesCreditsError,
  grantOnClaim,
  grantUntilDelivered,
  newEscrowId,
  postJob,
  postPrivateJob,
  retireDelivered,
  StuckDealError,
  type BuyerDeps,
  type JobSpec,
  type PostedJob,
} from '@dusk/buyer'

export function requireModel(): string {
  const m = process.env.DUSK_MODEL?.trim() || process.env.DUSK_TRUSTED_MODELS?.split(',')[0]?.trim()
  if (!m) {
    throw new Error(
      'set DUSK_MODEL (or DUSK_TRUSTED_MODELS) to a model you have confirmed the Router ' +
        'can serve — pnpm probe:og lists what actually answers',
    )
  }
  return m
}

export function buildBuyerDeps(): BuyerDeps & { address: string } {
  const config = loadConfig(process.env)
  const pk = partyKey(process.env, 'buyer')
  const account = privateKeyToAccount(pk)

  let escrow: EscrowClient | undefined
  if (config.escrow.address) {
    escrow = createEscrowClient({
      rpc: config.escrow.rpc,
      chainId: config.escrow.chainId,
      address: config.escrow.address,
      privateKey: pk,
    })
  } else {
    console.log('— no escrow configured (need DUSK_ESCROW_ADDRESS): posting unfunded —')
  }

  return {
    arkiv: createArkivStore({
      rpc: config.arkiv.rpc,
      chainId: config.arkiv.chainId,
      privateKey: pk as Hex,
      ...(process.env.ARKIV_ACCESS_KEY ? { accessKey: process.env.ARKIV_ACCESS_KEY } : {}),
    }),
    swarm: createSwarmStore({
      uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
      downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
    }),
    escrow,
    buyerPubkey: account.publicKey,
    address: account.address,
    now: () => Date.now(),
    clock: config.clock,
    ttlGrantSeconds: config.ttl.grant,
    imageModels: config.og.imageModels,
    unsealOutput: (sealed) => unseal(sealed, pk as Hex),
    ...ensAdmit(),
  }
}

function ensAdmit(): Pick<BuyerDeps, 'admit'> {
  return { admit: admitFromEnv(process.env, createEnsReader) }
}

if (process.argv[1]?.endsWith('post-job.ts')) {
  const watch = process.argv.includes('--grant')
  const deps = buildBuyerDeps()
  try {
    const job = await postJob(deps, {
      prompt: process.env.DUSK_PROMPT ?? 'hi',
      model: requireModel(),
      maxPricePer1kOut: BigInt(process.env.DUSK_MAX_PRICE ?? '1000000'),
      maxTokens: Number(process.env.DUSK_MAX_TOKENS ?? '8'),
      deadlineMs: Number(process.env.DUSK_DEADLINE_MS ?? '600000'),
    })

    console.log('── job posted ──')
    console.log(`  buyer     : ${deps.address}`)
    console.log(`  job id    : ${job.id}`)
    console.log(`  model     : ${job.model}`)
    console.log(`  max tokens: ${job.maxTokens}`)
    console.log(`  input ref : ${job.inputRef}`)
    console.log(`  expires   : ${new Date(job.expiresAt).toISOString()}`)
    console.log(`  escrow id : ${job.escrowId}`)
    console.log(`  amount    : ${job.amountWei} wei`)
    console.log(`  fund tx   : ${job.fundTx ?? '(unfunded)'}`)

    if (!watch) {
      console.log()
      console.log('── not authorised: no worker can be paid for this job ──')
      console.log('  `commit` needs this buyer\'s CommitAuth, which is written to a `grant`')
      console.log('  only after a claim appears. This process has exited, so no grant will')
      console.log('  ever be written: a worker will claim, wait, release, and retry until')
      console.log(`  ${new Date(job.expiresAt).toISOString()}.`)
      console.log('  Re-run as `pnpm post-job --grant` to stay up and authorise the claimant.')
      if (job.fundTx) {
        console.log(`  To get the ${job.amountWei} wei back after the deadline: pnpm reclaim --mine`)
      }
    } else {
      console.log()
      console.log('── waiting for a claim, to authorise it ──')
      console.log('  Ctrl-C leaves the job funded and unservable; see `pnpm reclaim --mine`.')
      const grantId = await grantUntilDelivered(deps, job, undefined, {
        onGrant: (id, claim) => console.log(`  grant     : ${id} → ${claim.owner} may commit and be paid`),
      })
      if (grantId === null) {
        console.log('  nobody claimed before the job expired — a quiet market, not an error')
        console.log('  the escrowed money is refundable now: pnpm reclaim --mine')
      } else {
        console.log('  stopped watching: the deal left `funded` (delivered), or the job expired')
        let retired = false
        for (let i = 0; i < 30 && !retired && Date.now() < job.expiresAt; i++) {
          const receipts = await deps.arkiv
            .query<Receipt>('receipt', attrEq('receipt', 'jobId', job.id))
            .catch(() => [] as Receipt[])
          for (const r of receipts) {
            const bytes = await deps.swarm.download(r.outputRef).catch(() => null)
            if (bytes && (await retireDelivered(deps, job, r, bytes))) {
              retired = true
              console.log(`  delivered : ${r.outputRef} — job entity removed from Arkiv`)
              break
            }
          }
          if (!retired) await new Promise((res) => setTimeout(res, 2_000))
        }
        if (!retired) console.log('  no verified delivery found — the job entity stays until its TTL')
      }
    }
  } catch (e) {
    if (e instanceof StuckDealError) {
      console.error(
        e.funding === 'funded'
          ? '── funded, but the job entity never got written ──'
          : '── fund did not confirm — this escrow id may still be funded ──',
      )
      console.error(`  escrow id : ${e.escrowId}`)
      console.error(`  fund tx   : ${e.fundTx ?? '(no transaction hash — none was broadcast, or none is known)'}`)
      console.error(`  ${e.message}`)
    }
    throw e
  }
}
