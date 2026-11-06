import { ConfigError, loadConfig, type ClockConfig, type DuskConfig } from '@dusk/core'
import { EnsInputError, loadEnsConfig, type EnsConfig } from '@dusk/ens'
import type { Pricing } from './past'

export const PUBLIC_ENV_PREFIX = 'NEXT_PUBLIC_'

export const PUBLIC_CONFIG_NAMES = [
  'OG_BASE_URL',
  'ARKIV_RPC',
  'ARKIV_CHAIN_ID',
  'SWARM_ENDPOINT',
  'SWARM_DOWNLOAD_ENDPOINT',
  'SWARM_BATCH_ID',
  'DUSK_ESCROW_ADDRESS',
  'GALILEO_CHAIN_ID',
  'GALILEO_RPC',
  'DUSK_CLOCK_EVERY_SECONDS',
  'DUSK_TTL_WORKER',
  'DUSK_TTL_CLAIM',
  'DUSK_TTL_GRANT',
  'DUSK_TTL_RECEIPT',
  'DUSK_IMAGE_MODELS',
  'DUSK_IMAGE_SIZE',
  'DUSK_INPUT_MAX_BYTES',
  'DUSK_INPUT_MAX_ATTACHMENTS',
  'DUSK_INPUT_MAX_IMAGE_PX',
] as const

export type PublicConfigName = (typeof PUBLIC_CONFIG_NAMES)[number]

type Env = Record<string, string | undefined>

const KEY_SHAPED = /\b(sk|mk)-/

function publicEnvOf(env: Env): Env {
  const picked: Env = {}
  for (const name of PUBLIC_CONFIG_NAMES) {
    const value = env[`${PUBLIC_ENV_PREFIX}${name}`]
    if (value === undefined) continue
    if (KEY_SHAPED.test(value)) {
      throw new ConfigError(
        `${PUBLIC_ENV_PREFIX}${name} looks like a 0G API key. NEXT_PUBLIC_ values are ` +
          `compiled into the browser bundle, so a key there is published. Remove it.`,
      )
    }
    picked[name] = value
  }
  return picked
}

function reprefix(message: string): string {
  let out = message
  for (const name of PUBLIC_CONFIG_NAMES) {
    out = out.replace(new RegExp(`(?<!${PUBLIC_ENV_PREFIX})\\b${name}\\b`, 'g'), `${PUBLIC_ENV_PREFIX}${name}`)
  }
  return out
}

export function browserConfig(env?: Env): DuskConfig {
  const source = env ?? inlinedPublicEnv()
  try {
    return loadConfig(publicEnvOf(source))
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(reprefix(error.message))
    throw error
  }
}

const CLOCK_ONLY_BASE_URL = 'about:blank#dusk-read-only-surfaces-make-no-router-calls'

export function browserReadConfig(env?: Env): DuskConfig {
  const source = env ?? inlinedPublicEnv()
  return browserConfig({
    ...source,
    NEXT_PUBLIC_OG_BASE_URL: source[`${PUBLIC_ENV_PREFIX}OG_BASE_URL`] || CLOCK_ONLY_BASE_URL,
  })
}

export function browserArkivAccessKey(env?: Env): string | undefined {
  const source = env ?? { [`${PUBLIC_ENV_PREFIX}ARKIV_ACCESS_KEY`]: process.env.NEXT_PUBLIC_ARKIV_ACCESS_KEY }
  const raw = source[`${PUBLIC_ENV_PREFIX}ARKIV_ACCESS_KEY`]?.trim()
  if (!raw) return undefined
  if (KEY_SHAPED.test(raw)) {
    throw new ConfigError(
      `${PUBLIC_ENV_PREFIX}ARKIV_ACCESS_KEY looks like a 0G API key. Arkiv wants a hub key from ` +
        'https://hub.arkiv.network, which buys read quota and nothing else. A 0G key spends ' +
        'credits with no cap, and this value is compiled into the browser bundle — so it ' +
        'would be published to every visitor. The value is not repeated here on purpose.',
    )
  }
  return raw
}

export const DEFAULT_MODELS = ['0gm-1.0-35b-a3b'] as const

export const MODELS_NAME = 'NEXT_PUBLIC_DUSK_MODELS'

export function browserModels(env?: Env): string[] {
  const source = env ?? { [MODELS_NAME]: process.env.NEXT_PUBLIC_DUSK_MODELS }
  const raw = source[MODELS_NAME]?.trim()
  if (!raw) return [...DEFAULT_MODELS]
  if (KEY_SHAPED.test(raw)) {
    throw new ConfigError(
      `${MODELS_NAME} looks like a 0G API key, not a list of model ids. NEXT_PUBLIC_ values ` +
        'are compiled into the browser bundle, so a key there is published. Remove it.',
    )
  }
  const models = [...new Set(raw.split(',').map((m) => m.trim()).filter(Boolean))]
  return models.length > 0 ? models : [...DEFAULT_MODELS]
}

const VERIFIERS_NAME = 'NEXT_PUBLIC_DUSK_VERIFIERS'

export function browserVerifiers(env?: Env): string[] {
  const source = env ?? { [VERIFIERS_NAME]: process.env.NEXT_PUBLIC_DUSK_VERIFIERS }
  const list = (source[VERIFIERS_NAME] ?? '').split(',').map((a) => a.trim()).filter(Boolean)
  for (const a of list) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new ConfigError(`${VERIFIERS_NAME} holds "${a}", which is not an address.`)
  }
  return list
}

const PRICING_NAMES = {
  usdPer1mIn: 'NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_IN',
  usdPer1mOut: 'NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_OUT',
  usdPer0g: 'NEXT_PUBLIC_DUSK_0G_USD',
} as const

export function browserPricing(env?: Env): Pricing | null {
  const source = env ?? {
    NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_IN: process.env.NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_IN,
    NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_OUT: process.env.NEXT_PUBLIC_DUSK_LIST_USD_PER_1M_OUT,
    NEXT_PUBLIC_DUSK_0G_USD: process.env.NEXT_PUBLIC_DUSK_0G_USD,
  }
  const entries = Object.entries(PRICING_NAMES).map(([field, name]) => [field, name, source[name]?.trim() || undefined] as const)
  const set = entries.filter(([, , raw]) => raw !== undefined)
  if (set.length === 0) return null
  if (set.length < entries.length) {
    const missing = entries.filter(([, , raw]) => raw === undefined).map(([, name]) => name)
    throw new ConfigError(
      `Savings pricing is partly configured: set ${missing.join(' and ')} too, or unset all three. ` +
        'A saving cannot be computed from a list price without a 0G rate, or the reverse.',
    )
  }
  const pricing: Record<string, number> = {}
  for (const [field, name, raw] of entries) {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new ConfigError(`${name} must be a non-negative number of US dollars, got ${JSON.stringify(raw)}`)
    }
    pricing[field] = value
  }
  return pricing as Pricing
}

const ENS_NAMES = [
  'ENS_MODE',
  'ENS_CHAIN_ID',
  'ENS_RPC',
  'ENS_PARENT_NAME',
  'ENS_REGISTRY_ADDRESS',
  'ENS_CHILD_REGISTRY',
  'ENS_CHILD_REGISTRY_DEPLOY_BLOCK',
  'ENS_CONTROLLER_ADDRESS',
  'ENS_REPUTATION_ADDRESS',
  'ENS_UNIVERSAL_RESOLVER',
] as const

export function browserEns(env?: Env): EnsConfig | null {
  const source = env ?? inlinedEnsEnv()
  const mode = source[`${PUBLIC_ENV_PREFIX}ENS_MODE`]?.trim()
  if (!mode || mode === 'off') return null
  const picked: Env = {}
  for (const name of ENS_NAMES) {
    const value = source[`${PUBLIC_ENV_PREFIX}${name}`]
    if (value === undefined) continue
    if (KEY_SHAPED.test(value)) {
      throw new ConfigError(
        `${PUBLIC_ENV_PREFIX}${name} looks like a 0G API key. NEXT_PUBLIC_ values are ` +
          'compiled into the browser bundle, so a key there is published. The value is not repeated here.',
      )
    }
    picked[name] = value
  }
  try {
    const config = loadEnsConfig(picked)
    return config.mode === 'off' ? null : config
  } catch (error) {
    if (!(error instanceof EnsInputError)) throw error
    let message = error.message
    for (const name of ENS_NAMES) message = message.replace(new RegExp(`(?<!${PUBLIC_ENV_PREFIX})\\b${name}\\b`, 'g'), `${PUBLIC_ENV_PREFIX}${name}`)
    throw new ConfigError(message)
  }
}

export function browserEnsSetup(env?: Env): { config: EnsConfig | null; parentName: string; chainId: number; status: 'ready' | 'disabled' | 'unavailable' } {
  const source = env ?? inlinedEnsEnv()
  let parentName = 'dusk.eth'
  let chainId = 11155111
  try {
    const metadata = loadEnsConfig({ ENS_MODE: 'off', ENS_PARENT_NAME: source.NEXT_PUBLIC_ENS_PARENT_NAME, ENS_CHAIN_ID: source.NEXT_PUBLIC_ENS_CHAIN_ID })
    parentName = metadata.parentName; chainId = metadata.chainId
  } catch { return { config: null, parentName, chainId, status: 'unavailable' } }
  try {
    const config = browserEns(source)
    return { config, parentName, chainId, status: config ? 'ready' : 'disabled' }
  } catch { return { config: null, parentName, chainId, status: 'unavailable' } }
}

function inlinedEnsEnv(): Env {
  return {
    NEXT_PUBLIC_ENS_MODE: process.env.NEXT_PUBLIC_ENS_MODE,
    NEXT_PUBLIC_ENS_CHAIN_ID: process.env.NEXT_PUBLIC_ENS_CHAIN_ID,
    NEXT_PUBLIC_ENS_RPC: process.env.NEXT_PUBLIC_ENS_RPC,
    NEXT_PUBLIC_ENS_PARENT_NAME: process.env.NEXT_PUBLIC_ENS_PARENT_NAME,
    NEXT_PUBLIC_ENS_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_ENS_REGISTRY_ADDRESS,
    NEXT_PUBLIC_ENS_CHILD_REGISTRY: process.env.NEXT_PUBLIC_ENS_CHILD_REGISTRY,
    NEXT_PUBLIC_ENS_CHILD_REGISTRY_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_ENS_CHILD_REGISTRY_DEPLOY_BLOCK,
    NEXT_PUBLIC_ENS_CONTROLLER_ADDRESS: process.env.NEXT_PUBLIC_ENS_CONTROLLER_ADDRESS,
    NEXT_PUBLIC_ENS_REPUTATION_ADDRESS: process.env.NEXT_PUBLIC_ENS_REPUTATION_ADDRESS,
    NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER: process.env.NEXT_PUBLIC_ENS_UNIVERSAL_RESOLVER,
  }
}

export function browserClock(env?: Env): ClockConfig {
  return browserReadConfig(env).clock
}

function inlinedPublicEnv(): Env {
  return {
    NEXT_PUBLIC_OG_BASE_URL: process.env.NEXT_PUBLIC_OG_BASE_URL,
    NEXT_PUBLIC_ARKIV_RPC: process.env.NEXT_PUBLIC_ARKIV_RPC,
    NEXT_PUBLIC_ARKIV_CHAIN_ID: process.env.NEXT_PUBLIC_ARKIV_CHAIN_ID,
    NEXT_PUBLIC_SWARM_ENDPOINT: process.env.NEXT_PUBLIC_SWARM_ENDPOINT,
    NEXT_PUBLIC_SWARM_DOWNLOAD_ENDPOINT: process.env.NEXT_PUBLIC_SWARM_DOWNLOAD_ENDPOINT,
    NEXT_PUBLIC_SWARM_BATCH_ID: process.env.NEXT_PUBLIC_SWARM_BATCH_ID,
    NEXT_PUBLIC_DUSK_ESCROW_ADDRESS: process.env.NEXT_PUBLIC_DUSK_ESCROW_ADDRESS,
    NEXT_PUBLIC_GALILEO_CHAIN_ID: process.env.NEXT_PUBLIC_GALILEO_CHAIN_ID,
    NEXT_PUBLIC_GALILEO_RPC: process.env.NEXT_PUBLIC_GALILEO_RPC,
    NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS: process.env.NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS,
    NEXT_PUBLIC_DUSK_TTL_WORKER: process.env.NEXT_PUBLIC_DUSK_TTL_WORKER,
    NEXT_PUBLIC_DUSK_TTL_CLAIM: process.env.NEXT_PUBLIC_DUSK_TTL_CLAIM,
    NEXT_PUBLIC_DUSK_TTL_GRANT: process.env.NEXT_PUBLIC_DUSK_TTL_GRANT,
    NEXT_PUBLIC_DUSK_TTL_RECEIPT: process.env.NEXT_PUBLIC_DUSK_TTL_RECEIPT,
    NEXT_PUBLIC_DUSK_IMAGE_MODELS: process.env.NEXT_PUBLIC_DUSK_IMAGE_MODELS,
    NEXT_PUBLIC_DUSK_IMAGE_SIZE: process.env.NEXT_PUBLIC_DUSK_IMAGE_SIZE,
    NEXT_PUBLIC_DUSK_INPUT_MAX_BYTES: process.env.NEXT_PUBLIC_DUSK_INPUT_MAX_BYTES,
    NEXT_PUBLIC_DUSK_INPUT_MAX_ATTACHMENTS: process.env.NEXT_PUBLIC_DUSK_INPUT_MAX_ATTACHMENTS,
    NEXT_PUBLIC_DUSK_INPUT_MAX_IMAGE_PX: process.env.NEXT_PUBLIC_DUSK_INPUT_MAX_IMAGE_PX,
  }
}

const FALLBACK_NAME = 'NEXT_PUBLIC_DUSK_FALLBACK_ADDRESS'

export function browserFallbackAddress(env?: Env): string | undefined {
  const source = env ?? { [FALLBACK_NAME]: process.env.NEXT_PUBLIC_DUSK_FALLBACK_ADDRESS }
  const raw = source[FALLBACK_NAME]?.trim()
  if (!raw) return undefined
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ConfigError(`${FALLBACK_NAME} holds "${raw}", which is not an address.`)
  return raw
}
