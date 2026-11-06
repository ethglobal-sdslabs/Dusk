import { getAddress, isAddress, type Address } from 'viem'
import { loadConfig } from '@dusk/core'
import { loadEnsConfig, reputationSourceHash } from '@dusk/ens'
import { parseReputationWorkflowConfig, reputationWorkflowSources } from '../packages/automation/src/config'

export function reputationSetup(env: Record<string, string | undefined>) {
  const ens = loadEnsConfig({ ...env, ENS_MODE: 'off' })
  const core = loadConfig(env)
  if (!ens.controller || !core.escrow.address) throw new Error('Deploy the identity controller and configure the escrow in config.json before preparing reputation automation.')
  const publicAddress = (raw: string | undefined, label: string): Address => {
    if (!raw || !isAddress(raw, { strict: false }) || /^0x0{40}$/i.test(raw)) throw new Error(`config.json ${label} must be a public address.`)
    return getAddress(raw.toLowerCase())
  }
  const integer = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('config.json has an invalid reputation policy or scan limit; no value is repeated.')
    return n
  }
  const workflowOwner = publicAddress(env.DUSK_REPUTATION_WORKFLOW_OWNER, 'reputation.workflowOwner')
  const verifiers = (env.DUSK_VERIFIERS ?? '').split(',').map((v) => v.trim()).filter(Boolean).map((v) => publicAddress(v, 'reputation.verifiers'))
  const publicWorkflow = (reputation: Address) => parseReputationWorkflowConfig({
    schedule: env.DUSK_REPUTATION_SCHEDULE || '0 0 */4 * * *',
    ens: { rpc: ens.rpc, chainId: ens.chainId, controller: ens.controller!, reputation, chainSelector: ens.chainId === 1 ? '5009297550715157269' : '16015286601757825753' },
    galileo: { rpc: core.escrow.rpc, chainId: core.escrow.chainId, escrow: core.escrow.address!, fromBlock: env.DUSK_REPUTATION_ESCROW_FROM_BLOCK || '0' },
    arkiv: { rpc: core.arkiv.rpc, chainId: core.arkiv.chainId }, verifiers,
    swarm: { uploadUrl: core.swarm.endpoint || 'https://api.gateway.ethswarm.org', downloadUrl: core.swarm.downloadEndpoint || 'https://download.gateway.ethswarm.org', ...(core.swarm.batchId ? { batchId: core.swarm.batchId } : {}) },
    limits: { logRange: integer('DUSK_REPUTATION_LOG_RANGE', 20_000), maxPages: integer('DUSK_REPUTATION_MAX_PAGES', 1000), maxWallets: integer('DUSK_REPUTATION_MAX_WALLETS', 1000), gasLimit: String(integer('DUSK_REPUTATION_GAS_LIMIT', 8_000_000)) },
  })
  const sources = reputationWorkflowSources(publicWorkflow(ens.reputation ?? ens.controller))
  return { ens, core, sources, sourceHash: reputationSourceHash(sources), workflowOwner, publicWorkflow,
    policy: { below: integer('DUSK_REPUTATION_REVOKE_BELOW', 50, 0, 100), minimumResolved: integer('DUSK_REPUTATION_MINIMUM_RESOLVED', 3), maxReportAge: integer('DUSK_REPUTATION_MAX_REPORT_AGE', 3600, 1, 86400) } }
}
