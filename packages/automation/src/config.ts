import { getAddress, isAddress, type Address } from 'viem'
import type { ReputationSources } from '../../ens/src/reputation-score'

export type ReputationWorkflowConfig = {
  schedule: string
  ens: { rpc: string; chainId: number; controller: Address; reputation: Address; chainSelector: string }
  galileo: { rpc: string; chainId: number; escrow: Address; fromBlock: string }
  arkiv: { rpc: string; chainId: number }
  verifiers: Address[]
  swarm: { uploadUrl: string; downloadUrl: string; batchId?: string }
  limits: { logRange: number; maxPages: number; maxWallets: number; gasLimit: string }
}

export function parseReputationWorkflowConfig(raw: unknown): ReputationWorkflowConfig {
  const value = raw as ReputationWorkflowConfig
  if (!value || typeof value !== 'object' || !value.ens || !value.galileo || !value.arkiv || !value.limits || !value.swarm) throw new Error('Missing public reputation workflow configuration.')
  const address = (v: unknown): Address => {
    if (typeof v !== 'string' || !isAddress(v, { strict: false }) || /^0x0{40}$/i.test(v)) throw new Error('Workflow needs deployed public contract addresses.')
    return getAddress(v.toLowerCase())
  }
  const rpc = (v: unknown): string => {
    if (typeof v !== 'string') throw new Error('Workflow needs public chain RPCs.')
    const u = new URL(v)
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || /\b(?:sk|mk)-/.test(v)) throw new Error('Workflow RPC configuration contains unsupported or private material.')
    return v
  }
  for (const n of [value.ens.chainId, value.galileo.chainId, value.arkiv.chainId, value.limits.logRange, value.limits.maxPages, value.limits.maxWallets]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Workflow chain IDs and scan limits must be positive integers.')
  }
  if (typeof value.schedule !== 'string' || value.schedule.split(/\s+/).length !== 6) throw new Error('Workflow needs a six-field cron schedule.')
  if (!/^\d+$/.test(value.ens.chainSelector) || !/^\d+$/.test(value.galileo.fromBlock) || !/^\d+$/.test(value.limits.gasLimit)) throw new Error('Workflow block, gas and chain-selector values must be unsigned integers.')
  if (!Array.isArray(value.verifiers)) throw new Error('Workflow needs an explicit approved verifier list.')
  return {
    schedule: value.schedule,
    ens: { rpc: rpc(value.ens.rpc), chainId: value.ens.chainId, controller: address(value.ens.controller), reputation: address(value.ens.reputation), chainSelector: value.ens.chainSelector },
    galileo: { rpc: rpc(value.galileo.rpc), chainId: value.galileo.chainId, escrow: address(value.galileo.escrow), fromBlock: value.galileo.fromBlock },
    arkiv: { rpc: rpc(value.arkiv.rpc), chainId: value.arkiv.chainId },
    verifiers: [...new Set(value.verifiers.map((v) => address(v).toLowerCase()))].sort().map((v) => getAddress(v)),
    swarm: { uploadUrl: rpc(value.swarm.uploadUrl), downloadUrl: rpc(value.swarm.downloadUrl), ...(value.swarm.batchId ? { batchId: value.swarm.batchId } : {}) },
    limits: { logRange: value.limits.logRange, maxPages: value.limits.maxPages, maxWallets: value.limits.maxWallets, gasLimit: value.limits.gasLimit },
  }
}

export function reputationWorkflowSources(c: ReputationWorkflowConfig): ReputationSources {
  return { ensChainId: c.ens.chainId, controller: c.ens.controller, galileoChainId: c.galileo.chainId, escrow: c.galileo.escrow, arkivChainId: c.arkiv.chainId, verifiers: c.verifiers }
}
