import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAbiItem, keccak256, toHex, type Abi, type Address, type Hex } from 'viem'
import { DuskIdentityControllerAbi } from '../../ens/src/controller-abi'
import { DuskReputationAbi } from '../../ens/src/reputation-abi'
import { DUSK_ESCROW_ABI } from '../../escrow/src/abi'
import { reputationSourceHash } from '../../ens/src/reputation-score'
import { collectReputationReports, type ReputationRpc } from '../src/collect'
import { parseReputationWorkflowConfig, reputationWorkflowSources, type ReputationWorkflowConfig } from '../src/config'

export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
export const h = (s: string) => keccak256(toHex(s))
export const user = addr(1)
export const verifier = addr(2)
export const controller = addr(3)
export const reputation = addr(4)
export const escrow = addr(5)
export const config: ReputationWorkflowConfig = {
  schedule: '0 0 */4 * * *',
  ens: { rpc: 'https://ens.example', chainId: 11155111, controller, reputation, chainSelector: '16015286601757825753' },
  galileo: { rpc: 'https://galileo.example', chainId: 16602, escrow, fromBlock: '0' },
  arkiv: { rpc: 'https://arkiv.example', chainId: 7794095 }, verifiers: [verifier],
  swarm: { uploadUrl: 'https://swarm-upload.example', downloadUrl: 'https://swarm-download.example' },
  limits: { logRange: 1000, maxPages: 10, maxWallets: 1000, gasLimit: '8000000' },
}
const evaluationArray = { ...getAbiItem({ abi: DuskReputationAbi, name: 'processEvaluation' }).inputs[0], type: 'tuple[]' as const }
export function decoded(report: Hex) {
  return decodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint32' }, { type: 'bytes32' }, evaluationArray], report)
}
export function world() {
  const state = {
    wallets: [user], receipts: [] as unknown[], verifications: [] as unknown[],
    calls: [] as string[], sourceHash: reputationSourceHash(reputationWorkflowSources(config)),
    fail: '', badAnswers: 0, illegal: 0, flags: new Map<string, number>(), missingInventory: false, paused: false,
  }
  const encode = (abi: Abi, functionName: string, result: unknown) => encodeFunctionResult({ abi, functionName, result })
  const rpc: ReputationRpc = (url, method, params) => {
    state.calls.push(`${url}:${method}`)
    if (state.fail === method) throw new Error('Source unavailable with confidential URL details')
    if (method === 'eth_chainId') return toHex(url === config.ens.rpc ? 11155111 : url === config.galileo.rpc ? 16602 : 7794095)
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x384', hash: h(url) }
    if (method === 'eth_getLogs') {
      return [1, 2, 3].flatMap((n) => {
        const jobId = h(`job-${n}`)
        return [{ address: escrow, blockNumber: toHex(n), transactionHash: h(`c-${n}`), removed: false,
          topics: encodeEventTopics({ abi: DUSK_ESCROW_ABI, eventName: 'Committed', args: { jobId, worker: user } }),
          data: encodeAbiParameters([{ type: 'bytes32' }], [h('correct')]) },
        { address: escrow, blockNumber: toHex(n + 10), transactionHash: h(`s-${n}`), removed: false,
          topics: encodeEventTopics({ abi: DUSK_ESCROW_ABI, eventName: 'Settled', args: { jobId, worker: user } }),
          data: encodeAbiParameters([{ type: 'uint256' }], [1n]) }]
      })
    }
    if (method === 'arkiv_query') {
      const query = String(params[0])
      const rows = (query.includes('dusk.receipt') ? state.receipts : state.verifications) as Array<{ key: Hex }>
      const after = /\$key > key\((0x[0-9a-f]+)\)/.exec(query)?.[1]
      return { data: rows.filter((r) => !after || r.key > after).sort((a, b) => a.key.localeCompare(b.key)).slice(0, 100), blockNumber: '0x65' }
    }
    if (method === 'eth_call') {
      const call = params[0] as { to: Address; data: Hex }
      const abi = call.to === controller ? DuskIdentityControllerAbi : DuskReputationAbi
      const parsed = decodeFunctionData({ abi, data: call.data })
      const args = parsed.args as readonly unknown[]
      const fn = parsed.functionName
      if (fn === 'CONTROLLER') return encode(abi, fn, controller)
      if (fn === 'revoker') return encode(abi, fn, reputation)
      if (fn === 'paused') return encode(abi, fn, state.paused)
      if (fn === 'sourceContextHash') return encode(abi, fn, state.sourceHash)
      if (fn === 'policyEpoch') return encode(abi, fn, 3)
      if (fn === 'memberCount') return encode(abi, fn, BigInt(state.wallets.length))
      if (fn === 'memberWallets') return encode(abi, fn, state.missingInventory ? [] : state.wallets.slice(Number(args[0]), Number(args[0]) + Number(args[1])))
      if (fn === 'membershipOf') return encode(abi, fn, ['member', 1n, addr(9), 100000n, 1])
      if (fn === 'evaluationState') return encode(abi, fn, [state.badAnswers, state.illegal, (args[1] as Hex[]).map((job) => state.flags.get(job.toLowerCase()) ?? 0)])
    }
    throw new Error(`Unexpected test call ${method}`)
  }
  return { state, rpc }
}
export function receipt(n: number, creator = user) {
  return { key: `0x${n.toString(16).padStart(64, '0')}`, creator, createdAt: '0x32', creationFlags: 1, attributes: [
    { name: 'escrow_id', type: 'str', value: h(`job-${n % 3 + 1}`) },
    { name: 'worker', type: 'addr', value: user }, { name: 'output_hash', type: 'str', value: h('lie') },
  ] }
}

