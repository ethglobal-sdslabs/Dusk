import { grantUntilDelivered, postJob } from '@dusk/buyer'
import { createArkivStore } from '@dusk/arkiv'
import { loadConfig, partyKey, type EscrowClient } from '@dusk/core'
import { unseal } from '@dusk/crypto'
import { admitFromEnv, createEnsReader } from '@dusk/ens'
import { createEscrowClient } from '@dusk/escrow'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { privateKeyToAccount } from 'viem/accounts'
import type { Limits, ServiceDeps } from './service'

type Env = Record<string, string | undefined>

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}

function big(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name} must be a positive integer (wei), got ${JSON.stringify(raw)}`)
  return BigInt(raw)
}

export function limitsFromEnv(env: Env): Limits {
  return {
    maxTokens: int(env, 'DUSK_MCP_MAX_TOKENS', 2048),
    maxPricePer1kOut: big(env, 'DUSK_MCP_MAX_PRICE', 10_000_000n),
    maxEscrowWei: big(env, 'DUSK_MCP_MAX_ESCROW_WEI', 10n ** 15n),
    maxDeadlineSec: int(env, 'DUSK_MCP_MAX_DEADLINE_SEC', 3600),
  }
}

export function modelsFromEnv(env: Env): string[] {
  const raw = env.DUSK_MCP_MODELS ?? env.DUSK_TRUSTED_MODELS ?? env.NEXT_PUBLIC_DUSK_MODELS ?? ''
  return raw.split(',').map((m) => m.trim()).filter(Boolean)
}

export function buildServiceDeps(env: Env): ServiceDeps & { escrowConfigured: boolean } {
  const config = loadConfig(env)
  const pk = partyKey(env, 'buyer')
  const account = privateKeyToAccount(pk)

  let escrow: EscrowClient | undefined
  if (config.escrow.address) {
    escrow = createEscrowClient({
      rpc: config.escrow.rpc,
      chainId: config.escrow.chainId,
      address: config.escrow.address,
      privateKey: pk,
    })
  }

  return {
    escrowConfigured: escrow !== undefined,
    buyer: {
      arkiv: createArkivStore({
        rpc: config.arkiv.rpc,
        chainId: config.arkiv.chainId,
        privateKey: pk,
        ...(env.ARKIV_ACCESS_KEY ? { accessKey: env.ARKIV_ACCESS_KEY } : {}),
      }),
      swarm: createSwarmStore({
        uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
        downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
      }),
      ...(escrow ? { escrow } : {}),
      buyerPubkey: account.publicKey,
      address: account.address,
      now: () => Date.now(),
      clock: config.clock,
      ttlGrantSeconds: config.ttl.grant,
      imageModels: config.og.imageModels,
      unsealOutput: (sealed) => unseal(sealed, pk),
      admit: admitFromEnv(env, createEnsReader),
    },
    post: postJob,
    authorise: (deps, job, encryptedRef) => grantUntilDelivered(deps, job, encryptedRef),
    configuredModels: modelsFromEnv(env),
    imageModels: config.og.imageModels,
    limits: limitsFromEnv(env),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs: 3000,
  }
}
