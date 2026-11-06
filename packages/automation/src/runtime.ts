import {
  cre, consensusIdenticalAggregation, getNetwork, prepareReportRequest, text, ok,
  type Runtime, type HTTPSendRequester,
} from '@chainlink/cre-sdk/unrestricted'
import { keccak256, toHex, type Hex } from 'viem'
import { collectReputationReports, type ReputationRpc } from './collect'
import { parseReputationWorkflowConfig, type ReputationWorkflowConfig } from './config'

type HttpRequest = { url: string; method: string; body?: string; headers?: Record<string, string> }

function http(runtime: Runtime<ReputationWorkflowConfig>, request: HttpRequest): string {
  const capability = new cre.capabilities.HTTPClient()
  return capability.sendRequest(runtime, (send: HTTPSendRequester, req: HttpRequest) => {
    const response = send.sendRequest({
      url: req.url, method: req.method,
      ...(req.body === undefined ? {} : { body: toBase64(req.body) }),
      headers: req.headers ?? {}, cacheSettings: { store: false, maxAge: '0s' }, timeout: '20s',
    }).result()
    if (!ok(response)) throw new Error(`Public evidence transport failed (${response.statusCode}); no report was signed.`)
    return text(response)
  }, consensusIdenticalAggregation<string>())(request).result()
}

function toBase64(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = new TextEncoder().encode(value)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]! +
      (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63]! : '=') + (i + 2 < bytes.length ? alphabet[n & 63]! : '=')
  }
  return out
}

export function evaluateScheduledReputation(runtime: Runtime<ReputationWorkflowConfig>): number {
  const config = parseReputationWorkflowConfig(runtime.config)
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.ens.chainId === 1 ? 'ethereum-mainnet' : 'ethereum-testnet-sepolia', isTestnet: config.ens.chainId !== 1 })
  if (!network || network.chainId !== String(config.ens.chainId) || network.chainSelector.selector !== BigInt(config.ens.chainSelector)) throw new Error('Configured CRE destination selector does not match the ENS chain.')
  const rpc: ReputationRpc = (url, method, params) => {
    const raw = http(runtime, { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    let response: { result?: unknown; error?: unknown }
    try { response = JSON.parse(raw) as typeof response } catch { throw new Error('Public chain RPC returned unreadable data; no reputation was published.') }
    if (response.error || response.result === undefined) throw new Error('Public chain RPC refused an evidence read; no reputation was published.')
    return response.result
  }
  const storeEvidence = (body: string): Hex => {
    const expected = keccak256(toHex(body))
    const response = http(runtime, {
      url: `${config.swarm.uploadUrl.replace(/\/$/, '')}/bzz`, method: 'POST', body,
      headers: { 'content-type': 'application/json', 'swarm-pin': 'false', ...(config.swarm.batchId ? { 'swarm-postage-batch-id': config.swarm.batchId } : {}) },
    })
    let reference: unknown
    try { reference = (JSON.parse(response) as { reference?: unknown }).reference } catch { throw new Error('Swarm did not retain the public reputation evidence.') }
    if (typeof reference !== 'string' || !/^[0-9a-f]{64}$/i.test(reference)) throw new Error('Swarm did not return a public content reference.')
    const readback = http(runtime, { url: `${config.swarm.downloadUrl.replace(/\/$/, '')}/bzz/${reference}/`, method: 'GET' })
    if (keccak256(toHex(readback)) !== expected) throw new Error('Public evidence readback disagrees; no reputation was published.')
    return `0x${reference}`
  }
  const result = collectReputationReports(config, rpc, BigInt(Math.floor(runtime.now().getTime() / 1000)), storeEvidence)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  for (const encoded of result.reports) {
    const report = runtime.report(prepareReportRequest(encoded)).result()
    const submitted = evm.writeReport(runtime, { receiver: config.ens.reputation, report, gasConfig: { gasLimit: config.limits.gasLimit } }).result()
    if (submitted.txStatus !== 2) throw new Error('The reputation report did not execute; inspect its on-chain result before retrying.')
  }
  runtime.log(`Recomputed ${result.evaluated} wallet reputations and submitted ${result.reports.length} bounded reports.`)
  return result.evaluated
}

export function initReputationWorkflow(config: ReputationWorkflowConfig) {
  const validated = parseReputationWorkflowConfig(config)
  const cron = new cre.capabilities.CronCapability()
  return [cre.handler(cron.trigger({ schedule: validated.schedule }), evaluateScheduledReputation)]
}

