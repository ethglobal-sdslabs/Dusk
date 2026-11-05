import { defineChain, type Address, type Chain, type Hex } from 'viem'
import type { ClockConfig } from './clock'
import { assertBlockAligned } from './expiry'

export const ARKIV_RABDI_CHAIN_ID = 7794095
export const ARKIV_RABDI_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network'

export const OG_GALILEO_CHAIN_ID = 16602
export const OG_GALILEO_RPC = 'https://evmrpc-testnet.0g.ai'
export const OG_ROUTER_CLOUD_URL = 'https://router-api-cloud.0g.ai'
export const OG_MAINNET_RPC = 'https://evmrpc.0g.ai'
export const OG_MAINNET_INFERENCE_SERVING: Address = '0x47340d900bdFec2BD393c626E12ea0656F938d84'

export interface DuskConfig {
  og: {
    baseUrl: string
    models: string[]
    imageModels: string[]
    imageSize: string
    teeProof: {
      enabled: boolean
      routerUrl: string
      rpc: string
      servingContract: Address
    }
  }
  input: {
    maxBytes: number
    maxAttachments: number
    maxImagePx: number
  }
  arkiv: { rpc: string; chainId: number }
  swarm: { endpoint?: string; downloadEndpoint?: string; batchId?: string }
  escrow: {
    address?: Address
    chainId: number
    rpc: string
    challengeWindowSec: number
    verifier?: Address
  }
  clock: ClockConfig
  ttl: { worker: number; claim: number; grant: number; receipt: number }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) {
    throw new ConfigError(`${name} is not set — configure it in config.json`)
  }
  return value
}

function requiredOneOf(env: Env, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  throw new ConfigError(
    `${names[0]} is not set (nor ${names.slice(1).join(' / ')}) — configure the corresponding setting in config.json`,
  )
}

function ttl(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return assertBlockAligned(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number of seconds, got ${JSON.stringify(raw)}`)
  }
  return assertBlockAligned(parsed)
}

function numeric(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

function optionalAddress(env: Env, name: string): Address | undefined {
  const raw = env[name]
  if (!raw) return undefined
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigError(
      `${name} must be a 0x-prefixed 20-byte address, got ${JSON.stringify(raw)}`,
    )
  }
  return raw as Address
}

function clockFrom(env: Env): ClockConfig {
  const raw = env['DUSK_CLOCK_EVERY_SECONDS']
  if (raw === undefined || raw === '') return { resetAt: 'daily-utc-midnight' }
  const everySeconds = Number(raw)
  if (!Number.isInteger(everySeconds) || everySeconds <= 0) {
    throw new ConfigError(
      `DUSK_CLOCK_EVERY_SECONDS must be a positive whole number of seconds, got ` +
        `${JSON.stringify(raw)}`,
    )
  }
  return { resetAt: { everySeconds } }
}

export type Party = 'buyer' | 'worker'

const PARTY_KEY: Record<Party, string> = {
  buyer: 'DUSK_BUYER_PRIVATE_KEY',
  worker: 'DUSK_WORKER_PRIVATE_KEY',
}

const RETIRED_KEY_NAMES = [
  'ARKIV_PRIVATE_KEY',
  'ARKIV_PRIVATE_KEY_2',
  'GALILEO_PRIVATE_KEY',
  'GALILEO_PRIVATE_KEY_2',
] as const

export function normaliseKey(raw: string): string {
  let v = raw.trim()
  if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1).trim()
  if (v.startsWith('0X')) v = `0x${v.slice(2)}`
  if (!v.startsWith('0x')) v = `0x${v}`
  return v
}

export function keyDefect(v: string): string | undefined {
  const body = v.slice(2)
  if (body.length !== 64) {
    return `it has ${body.length} hex characters, not 64 (a 32-byte key)`
  }
  const bad = body.replace(/[0-9a-fA-F]/g, '').length
  if (bad > 0) {
    return `${bad} of its 64 characters ${bad === 1 ? 'is' : 'are'} not hexadecimal`
  }
  return undefined
}

export function partyKey(env: Env, party: Party): Hex {
  const name = PARTY_KEY[party]
  const raw = env[name]
  if (!raw) {
    const stale = RETIRED_KEY_NAMES.filter((n) => env[n])
    if (stale.length > 0) {
      throw new ConfigError(
        `${name} is not set, but ${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} — ` +
          'those names are retired. Dusk now uses ONE key per party on both chains: ' +
          `${PARTY_KEY.buyer} and ${PARTY_KEY.worker}. Separate Arkiv and Galileo keys ` +
          'silently broke every job, because isFundedFor compares the Galileo deal.buyer ' +
          'against the Arkiv job.owner. Fund the single address on both faucets.',
      )
    }
    throw new ConfigError(
      `${party}.privateKey is not set in config.json (nor ${name} in .env) — copy ` +
        'config.user.example.json to config.json and paste the throwaway key for that party. ' +
        'Every field there is optional; this one is required by what you just ran.',
    )
  }
  const key = normaliseKey(raw)
  const defect = keyDefect(key)
  if (defect) {
    throw new ConfigError(
      `${name} is not a 32-byte private key: ${defect}. A leading "0x" is optional. The ` +
        'value is deliberately not repeated here.',
    )
  }

  const other = party === 'buyer' ? 'worker' : 'buyer'
  const otherRaw = env[PARTY_KEY[other]]
  if (otherRaw) {
    const otherKey = normaliseKey(otherRaw)
    if (!keyDefect(otherKey) && otherKey.toLowerCase() === key.toLowerCase()) {
      throw new ConfigError(
        `${PARTY_KEY.buyer} and ${PARTY_KEY.worker} are the same key. Dusk needs two ` +
          'distinct accounts, or "posted by one participant and claimed by another" is not ' +
          'true of anything it demonstrates — and DuskEscrow would refuse the commit anyway, ' +
          'because a buyer may not be the worker on its own deal. Without this check the ' +
          'revert arrives after the completion is already billed, on every job.',
      )
    }
  }
  return key as Hex
}

export function partyKeys(env: Env): { buyer: Hex; worker: Hex } {
  return { buyer: partyKey(env, 'buyer'), worker: partyKey(env, 'worker') }
}

export const DEFAULT_IMAGE_MODELS = ['z-image-turbo'] as const

function imageModelsFrom(env: Env): string[] {
  const listed = (env['DUSK_IMAGE_MODELS'] ?? '').split(',').map((m) => m.trim()).filter(Boolean)
  return listed.length > 0 ? [...new Set(listed)] : [...DEFAULT_IMAGE_MODELS]
}

function imageSizeFrom(env: Env): string {
  const raw = env['DUSK_IMAGE_SIZE']?.trim()
  if (!raw) return '1024x1024'
  if (!/^\d{2,5}x\d{2,5}$/.test(raw)) {
    throw new ConfigError(`DUSK_IMAGE_SIZE must be WIDTHxHEIGHT, such as 1024x1024`)
  }
  return raw
}

const ROUTER_BODY_LIMIT = 20 * 1024 * 1024

function positiveInt(env: Env, name: string, fallback: number): number {
  const n = numeric(env, name, fallback)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ConfigError(`${name} must be a whole number of at least 1, got ${JSON.stringify(env[name])}`)
  }
  return n
}

function inputFrom(env: Env): DuskConfig['input'] {
  const maxBytes = positiveInt(env, 'DUSK_INPUT_MAX_BYTES', 4_000_000)
  if (maxBytes >= ROUTER_BODY_LIMIT) {
    throw new ConfigError('DUSK_INPUT_MAX_BYTES must be under 20 MiB, the largest request 0G\'s Router accepts')
  }
  return {
    maxBytes,
    maxAttachments: positiveInt(env, 'DUSK_INPUT_MAX_ATTACHMENTS', 4),
    maxImagePx: positiveInt(env, 'DUSK_INPUT_MAX_IMAGE_PX', 1568),
  }
}

export function loadConfig(env: Env): DuskConfig {
  return {
    og: {
      baseUrl: requiredOneOf(env, 'OG_BASE_URL', 'OG_BASE_URL_MAIN')
        .replace(/\/+$/, '')
        .replace(/\/v1$/, ''),
      models: [],
      imageModels: imageModelsFrom(env),
      imageSize: imageSizeFrom(env),
      teeProof: {
        enabled: !['0', 'false', 'no', 'off'].includes((env['DUSK_TEE_PROOF'] ?? '').toLowerCase()),
        routerUrl: (env['OG_ROUTER_CLOUD_URL'] ?? OG_ROUTER_CLOUD_URL).replace(/\/+$/, '').replace(/\/v1$/, ''),
        rpc: env['OG_MAINNET_RPC'] ?? OG_MAINNET_RPC,
        servingContract: optionalAddress(env, 'OG_SERVING_CONTRACT') ?? OG_MAINNET_INFERENCE_SERVING,
      },
    },
    input: inputFrom(env),
    arkiv: {
      rpc: env['ARKIV_RPC'] ?? ARKIV_RABDI_RPC,
      chainId: numeric(env, 'ARKIV_CHAIN_ID', ARKIV_RABDI_CHAIN_ID),
    },
    swarm: {
      endpoint: env['SWARM_ENDPOINT'] || undefined,
      downloadEndpoint: env['SWARM_DOWNLOAD_ENDPOINT'] || undefined,
      batchId: env['SWARM_BATCH_ID'] || undefined,
    },
    escrow: {
      address: optionalAddress(env, 'DUSK_ESCROW_ADDRESS'),
      chainId: numeric(env, 'GALILEO_CHAIN_ID', OG_GALILEO_CHAIN_ID),
      rpc: env['GALILEO_RPC'] ?? OG_GALILEO_RPC,
      challengeWindowSec: numeric(env, 'DUSK_CHALLENGE_WINDOW_SEC', 600),
      verifier: optionalAddress(env, 'DUSK_VERIFIER_ADDRESS'),
    },
    clock: clockFrom(env),
    ttl: {
      worker: ttl(env, 'DUSK_TTL_WORKER', 120),
      claim: ttl(env, 'DUSK_TTL_CLAIM', 90),
      grant: ttl(env, 'DUSK_TTL_GRANT', 300),
      receipt: ttl(env, 'DUSK_TTL_RECEIPT', 604800),
    },
  }
}

export function galileoChain(escrow: Pick<DuskConfig['escrow'], 'chainId' | 'rpc'>): Chain {
  return defineChain({
    id: escrow.chainId,
    name: '0G Galileo',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
    rpcUrls: { default: { http: [escrow.rpc] } },
  })
}
