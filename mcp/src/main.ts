import './preamble'
import '@dusk/core/env'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServiceDeps } from './deps'
import { createDuskService } from './service'
import { buildServer } from './tools'

const deps = buildServiceDeps(process.env)
console.error(
  `[dusk-mcp] buyer ${deps.buyer.address} · escrow ${deps.escrowConfigured ? 'configured' : 'NOT configured (jobs post unfunded)'} · ` +
    `caps: max_tokens ${deps.limits.maxTokens}, bid ${deps.limits.maxPricePer1kOut} wei/1k, escrow ${deps.limits.maxEscrowWei} wei/job`,
)
const server = buildServer(createDuskService(deps))
await server.connect(new StdioServerTransport())
