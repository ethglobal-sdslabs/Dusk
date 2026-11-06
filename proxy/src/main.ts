import './preamble'
import '@dusk/core/env'
import type { WorkerAd } from '@dusk/core'
import { buildServiceDeps } from '@dusk/mcp/src/deps'
import { createDuskService } from '@dusk/mcp/src/service'
import { proxyConfigFromEnv } from './config'
import { createProxyServer } from './server'

const cfg = proxyConfigFromEnv(process.env)
const deps = buildServiceDeps(cfg.serviceEnv)
const service = createDuskService(deps)
const log = (line: string) => console.error(`[dusk-proxy] ${new Date().toISOString()} ${line}`)

const server = createProxyServer({
  service,
  ads: () => deps.buyer.arkiv.query<WorkerAd>('worker'),
  limits: deps.limits,
  defaults: cfg.defaults,
  ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  log,
})

server.listen(cfg.port, cfg.host, () => {
  log(
    `listening on http://${cfg.host}:${cfg.port}/v1 · buyer ${deps.buyer.address} · ` +
      `escrow ${deps.escrowConfigured ? 'configured' : 'NOT configured (jobs post unfunded)'} · ` +
      `bid ${cfg.defaults.price !== undefined ? `${cfg.defaults.price} wei/1k (DUSK_PROXY_PRICE)` : 'highest live ask'} · ` +
      `caps: max_tokens ${deps.limits.maxTokens}, bid ${deps.limits.maxPricePer1kOut} wei/1k, escrow ${deps.limits.maxEscrowWei} wei/job · ` +
      `auth ${cfg.apiKey ? 'bearer key required' : 'none (loopback only)'}`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig}: closing. Jobs still in flight stay funded; reclaim unclaimed escrow with \`pnpm reclaim --mine\`.`)
    server.close()
    process.exit(0)
  })
}
