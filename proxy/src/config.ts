import type { TrustMode, Visibility } from '@dusk/core'
import type { ProxyDefaults } from './server'

type Env = Record<string, string | undefined>

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  return n
}

function wei(env: Env, name: string): bigint | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name} must be a positive integer (wei), got ${JSON.stringify(raw)}`)
  return BigInt(raw)
}

function pick<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  return raw as T
}

export type ProxyConfig = {
  host: string
  port: number
  apiKey?: string
  defaults: ProxyDefaults
  /** Env handed to the MCP deps builder, with DUSK_PROXY_* caps mapped onto its DUSK_MCP_* names. */
  serviceEnv: Env
}

export function proxyConfigFromEnv(env: Env): ProxyConfig {
  const host = env.DUSK_PROXY_HOST || '127.0.0.1'
  const port = int(env, 'DUSK_PROXY_PORT', 8787)
  const apiKey = env.DUSK_PROXY_API_KEY || undefined
  if (!apiKey && !LOOPBACK.has(host)) {
    throw new Error(
      `DUSK_PROXY_HOST is ${host} but DUSK_PROXY_API_KEY is unset. Every request spends the buyer wallet's 0G, ` +
        'so a proxy reachable beyond this machine must require a key.',
    )
  }
  const price = wei(env, 'DUSK_PROXY_PRICE')
  const defaults: ProxyDefaults = {
    maxTokens: int(env, 'DUSK_PROXY_DEFAULT_MAX_TOKENS', 1024),
    deadlineSec: int(env, 'DUSK_PROXY_DEADLINE_SEC', 600),
    visibility: pick<Visibility>(env, 'DUSK_PROXY_VISIBILITY', ['private', 'public'], 'private'),
    trustMode: pick<TrustMode>(env, 'DUSK_PROXY_TRUST_MODE', ['standard', 'verified'], 'standard'),
    ...(price !== undefined ? { price } : {}),
  }
  const serviceEnv: Env = { ...env }
  for (const [from, to] of [
    ['DUSK_PROXY_MAX_TOKENS', 'DUSK_MCP_MAX_TOKENS'],
    ['DUSK_PROXY_MAX_PRICE', 'DUSK_MCP_MAX_PRICE'],
    ['DUSK_PROXY_MAX_ESCROW_WEI', 'DUSK_MCP_MAX_ESCROW_WEI'],
    ['DUSK_PROXY_MAX_DEADLINE_SEC', 'DUSK_MCP_MAX_DEADLINE_SEC'],
    ['DUSK_PROXY_MODELS', 'DUSK_MCP_MODELS'],
  ] as const) {
    if (env[from]) serviceEnv[to] = env[from]
  }
  return { host, port, ...(apiKey ? { apiKey } : {}), defaults, serviceEnv }
}
