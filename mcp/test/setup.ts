import { postJob, type BuyerDeps, type PostedJob } from '@dusk/buyer'
import { loadConfig, type Job, type Receipt, type WorkerAd } from '@dusk/core'
import { keccak256, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { seal, unseal } from '@dusk/crypto'
import { fakeArkiv, fakeEscrow, fakeSwarm, FAKE_WRITER } from '../../worker/test/fakes'
import { createDuskService, type ServiceDeps } from '../src/service'

export const MODEL = '0gm-1.0-35b-a3b'
const WORKER: Address = `0x${'ab'.repeat(20)}`

export function setup(opts: { escrow?: boolean; authorise?: ServiceDeps['authorise']; maxEscrowWei?: bigint } = {}) {
  let now = 1_700_000_000_000
  const clock = () => now
  const config = loadConfig({ OG_BASE_URL_MAIN: 'https://router.example', DUSK_CLOCK_EVERY_SECONDS: '86400' })
  const arkiv = fakeArkiv(clock)
  const swarm = fakeSwarm()
  const escrow = opts.escrow === false ? undefined : fakeEscrow({ now: clock, signer: FAKE_WRITER })
  const key = generatePrivateKey()
  const account = privateKeyToAccount(key)
  const buyer: BuyerDeps & { address: string } = {
    arkiv,
    swarm,
    ...(escrow ? { escrow } : {}),
    buyerPubkey: account.publicKey,
    address: FAKE_WRITER,
    now: clock,
    clock: config.clock,
    ttlGrantSeconds: 300,
    unsealOutput: (sealed) => unseal(sealed, key),
  }
  const authorised: PostedJob[] = []
  const service = createDuskService({
    buyer,
    post: postJob,
    authorise:
      opts.authorise ??
      (async (_d, job) => {
        authorised.push(job as PostedJob)
        return null
      }),
    configuredModels: [MODEL],
    imageModels: config.og.imageModels,
    limits: { maxTokens: 1024, maxPricePer1kOut: 10_000_000n, maxEscrowWei: opts.maxEscrowWei ?? 10n ** 15n, maxDeadlineSec: 3600 },
    sleep: async (ms) => {
      now += ms
    },
    pollMs: 1000,
  })
  const advertise = (price: bigint, models = [MODEL]) =>
    arkiv.putAs<Omit<WorkerAd, 'id'>>(
      WORKER,
      'worker',
      { models, pricePer1kOut: price, creditsBucket: '>50%', trustModes: ['standard', 'verified'], payout: WORKER },
      { ttlSeconds: 120 },
    )
  const deliver = async (job: Job, text: string, opts: { commitHash?: Hex; owner?: Address } = {}) => {
    const bytes = new TextEncoder().encode(text)
    const plain = await swarm.upload(bytes, { encrypt: job.visibility === 'private' })
    const outputRef = job.visibility === 'private' ? seal(plain, job.buyerPubkey) : plain
    const outputHash = keccak256(bytes)
    if (escrow) {
      const deal = escrow.deals.get(job.escrowId as Hex)!
      escrow.deals.set(job.escrowId as Hex, { ...deal, state: 'committed', worker: WORKER, outputHash: opts.commitHash ?? outputHash })
    }
    const receipt: Omit<Receipt, 'id'> = {
      jobId: job.id,
      escrowId: job.escrowId,
      worker: WORKER,
      modelServed: job.model,
      creditsSpent: 'tokens:3/5',
      tokensIn: 3,
      tokensOut: 5,
      outputRef,
      visibility: job.visibility,
      outputHash,
      latencyMs: 900,
      trustMode: job.trustMode,
    }
    await arkiv.putAs(opts.owner ?? WORKER, 'receipt', receipt, { ttlSeconds: 600 })
  }
  return { service, arkiv, swarm, escrow, authorised, advertise, deliver, tick: (ms: number) => (now += ms) }
}

