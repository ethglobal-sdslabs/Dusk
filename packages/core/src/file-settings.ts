import { ConfigError, keyDefect, normaliseKey } from './config'

export const FILE_SETTINGS = {
  og: { baseUrl: 'OG_BASE_URL_MAIN', routerUrl: 'OG_ROUTER_CLOUD_URL', rpc: 'OG_MAINNET_RPC', servingContract: 'OG_SERVING_CONTRACT', teeProof: 'DUSK_TEE_PROOF', models: 'DUSK_MODELS', imageModels: 'DUSK_IMAGE_MODELS', imageSize: 'DUSK_IMAGE_SIZE' },
  arkiv: { rpc: 'ARKIV_RPC', chainId: 'ARKIV_CHAIN_ID', accessKey: 'ARKIV_ACCESS_KEY' },
  escrow: { address: 'DUSK_ESCROW_ADDRESS', rpc: 'GALILEO_RPC', chainId: 'GALILEO_CHAIN_ID', admissionAddress: 'DUSK_ADMISSION_ADDRESS', verifierAddress: 'DUSK_VERIFIER_ADDRESS', challengeWindowSec: 'DUSK_CHALLENGE_WINDOW_SEC' },
  swarm: { endpoint: 'SWARM_ENDPOINT', downloadEndpoint: 'SWARM_DOWNLOAD_ENDPOINT', batchId: 'SWARM_BATCH_ID' },
  ens: { mode: 'ENS_MODE', chainId: 'ENS_CHAIN_ID', rpc: 'ENS_RPC', parentName: 'ENS_PARENT_NAME', ownerAddress: 'ENS_OWNER_ADDRESS', rootRegistry: 'ENS_ROOT_REGISTRY', registryAddress: 'ENS_REGISTRY_ADDRESS', universalResolver: 'ENS_UNIVERSAL_RESOLVER', childRegistry: 'ENS_CHILD_REGISTRY', childRegistryDeployBlock: 'ENS_CHILD_REGISTRY_DEPLOY_BLOCK', controllerAddress: 'ENS_CONTROLLER_ADDRESS', controllerDeployBlock: 'ENS_CONTROLLER_DEPLOY_BLOCK', revokerAddress: 'ENS_REVOKER_ADDRESS', reputationAddress: 'ENS_REPUTATION_ADDRESS', mirrorTtlSeconds: 'ENS_MIRROR_TTL_SECONDS', attestationValiditySec: 'ENS_ATTESTATION_VALIDITY_SEC' },
  operators: { ensOwnerPrivateKey: 'ENS_OWNER_PRIVATE_KEY', ensRevokerPrivateKey: 'ENS_REVOKER_PRIVATE_KEY', ensUnbannerPrivateKey: 'ENS_UNBANNER_PRIVATE_KEY', ensIndexerPrivateKey: 'ENS_INDEXER_PRIVATE_KEY', ensAttesterPrivateKey: 'ENS_ATTESTER_PRIVATE_KEY', ensSubmitterPrivateKey: 'ENS_SUBMITTER_PRIVATE_KEY', verifierPrivateKey: 'DUSK_VERIFIER_PRIVATE_KEY' },
  worker: { models: 'DUSK_TRUSTED_MODELS', pricePer1kOut: 'DUSK_PRICE_PER_1K_OUT', payoutAddress: 'DUSK_PAYOUT_ADDRESS' },
  buyer: { model: 'DUSK_MODEL', prompt: 'DUSK_PROMPT', maxTokens: 'DUSK_MAX_TOKENS', maxPrice: 'DUSK_MAX_PRICE', deadlineMs: 'DUSK_DEADLINE_MS' },
  input: { maxBytes: 'DUSK_INPUT_MAX_BYTES', maxAttachments: 'DUSK_INPUT_MAX_ATTACHMENTS', maxImagePx: 'DUSK_INPUT_MAX_IMAGE_PX' },
  clock: { everySeconds: 'DUSK_CLOCK_EVERY_SECONDS' },
  ttl: { worker: 'DUSK_TTL_WORKER', claim: 'DUSK_TTL_CLAIM', grant: 'DUSK_TTL_GRANT', receipt: 'DUSK_TTL_RECEIPT' },
  reputation: { verifiers: 'DUSK_VERIFIERS', revokeBelow: 'DUSK_REPUTATION_REVOKE_BELOW', minimumResolved: 'DUSK_REPUTATION_MINIMUM_RESOLVED', schedule: 'DUSK_REPUTATION_SCHEDULE', workflowOwner: 'DUSK_REPUTATION_WORKFLOW_OWNER', workflowId: 'DUSK_REPUTATION_WORKFLOW_ID', forwarderAddress: 'DUSK_REPUTATION_FORWARDER', maxReportAgeSec: 'DUSK_REPUTATION_MAX_REPORT_AGE', deployBlock: 'DUSK_REPUTATION_DEPLOY_BLOCK', escrowFromBlock: 'DUSK_REPUTATION_ESCROW_FROM_BLOCK', logRange: 'DUSK_REPUTATION_LOG_RANGE', maxPages: 'DUSK_REPUTATION_MAX_PAGES', maxWallets: 'DUSK_REPUTATION_MAX_WALLETS', gasLimit: 'DUSK_REPUTATION_GAS_LIMIT' },
  pricing: { usdPer1mIn: 'DUSK_LIST_USD_PER_1M_IN', usdPer1mOut: 'DUSK_LIST_USD_PER_1M_OUT', usdPer0g: 'DUSK_0G_USD' },
} as const

const comment = (key: string) => key.startsWith('_') || key.startsWith('//') || key.startsWith('$')

export function parseFileSettings(root: Record<string, unknown>): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const [section, fields] of Object.entries(FILE_SETTINGS)) {
    const raw = root[section]
    if (raw == null) continue
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`config.json: ${section} must be an object.`)
    const object = raw as Record<string, unknown>
    const extra = section === 'og' ? ['computeKey', 'accessKey'] : ['buyer', 'worker'].includes(section) ? ['privateKey', 'address'] : []
    for (const name of Object.keys(object)) {
      if (!comment(name) && !Object.hasOwn(fields, name) && !extra.includes(name)) throw new ConfigError(`config.json: ${section} has an unknown field ${JSON.stringify(name)}.`)
    }
    for (const [field, name] of Object.entries(fields)) {
      const value = object[field]
      if (value == null) continue
      const list = Array.isArray(value) && value.every((v) => typeof v === 'string')
      if (!list && !['string', 'number', 'boolean'].includes(typeof value)) throw new ConfigError(`config.json: ${section}.${field} must be a string, number, boolean or string list.`)
      let text = (list ? (value as string[]).join(',') : String(value)).trim()
      if (!text) { if (section === 'ens') settings[name] = ''; continue }
      if (field.endsWith('PrivateKey')) {
        text = normaliseKey(text)
        if (keyDefect(text)) throw new ConfigError(`config.json: ${section}.${field} must be a valid 32-byte signing key. The value is withheld.`)
      }
      settings[name] = text
    }
  }
  return settings
}

const PUBLIC_SETTINGS = [
  'ARKIV_RPC', 'ARKIV_CHAIN_ID', 'ARKIV_ACCESS_KEY', 'GALILEO_RPC', 'GALILEO_CHAIN_ID', 'DUSK_ESCROW_ADDRESS',
  'SWARM_ENDPOINT', 'SWARM_DOWNLOAD_ENDPOINT', 'SWARM_BATCH_ID', 'DUSK_MODELS', 'DUSK_IMAGE_MODELS', 'DUSK_IMAGE_SIZE',
  'DUSK_CLOCK_EVERY_SECONDS', 'DUSK_TTL_WORKER', 'DUSK_TTL_CLAIM', 'DUSK_TTL_GRANT', 'DUSK_TTL_RECEIPT',
  'DUSK_INPUT_MAX_BYTES', 'DUSK_INPUT_MAX_ATTACHMENTS', 'DUSK_INPUT_MAX_IMAGE_PX',
  'DUSK_VERIFIERS', 'DUSK_LIST_USD_PER_1M_IN', 'DUSK_LIST_USD_PER_1M_OUT', 'DUSK_0G_USD',
  'ENS_MODE', 'ENS_CHAIN_ID', 'ENS_RPC', 'ENS_PARENT_NAME', 'ENS_REGISTRY_ADDRESS', 'ENS_CHILD_REGISTRY', 'ENS_CHILD_REGISTRY_DEPLOY_BLOCK', 'ENS_CONTROLLER_ADDRESS', 'ENS_REPUTATION_ADDRESS', 'ENS_UNIVERSAL_RESOLVER',
] as const

export function publicSettingsEnv(settings: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PUBLIC_SETTINGS) if (settings[name] !== undefined) out[`NEXT_PUBLIC_${name}`] = settings[name]!
  if (settings.OG_BASE_URL_MAIN) out.NEXT_PUBLIC_OG_BASE_URL = settings.OG_BASE_URL_MAIN
  for (const [name, value] of Object.entries(out)) {
    if (/\b(?:sk|mk)-/.test(value)) throw new ConfigError(`config.json: ${name} contains key-shaped material and cannot be published.`)
  }
  return out
}
