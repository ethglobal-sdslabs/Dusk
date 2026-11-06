import { createPublicClient, http, keccak256, toHex, zeroAddress, namehash, type Address } from 'viem'
import { ENSV1RegistryAbi, ETHRegistryAbi } from './abi'
import type { EnsConfig } from './config'

export class EnsProbeError extends Error {
  override name = 'EnsProbeError'
}

const V1_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

type RegistryState = {
  status: number
  expiry: bigint
  latestOwner: Address
  tokenId: bigint
  resource: bigint
}

type HierarchyEntry = {
  label: string
  registry: Address
  codeHash: `0x${string}`
  state: RegistryState
  child: Address
  resolver: Address
}

export type ProbeReport = {
  chainId: number
  blockNumber: bigint
  blockHash: string
  timestamp: bigint
  parentName: string
  parentNamehash: `0x${string}`
  rootRegistry: Address
  hierarchy: HierarchyEntry[]
  namespaceRegistry?: Address
  namespaceOwner?: Address
  namespaceResolver?: Address
  namespaceExpiry?: bigint
  childRegistry?: Address
  ownerMatches?: boolean
  registryMatches?: boolean
  childRegistryMatches?: boolean
  ownerRootRoles?: bigint
  v2NamespaceFound: boolean
  blockingReason?: string
  v1Record?: { exists: boolean; owner?: Address; ownerIsContract?: boolean; resolver?: Address; ttl?: bigint }
  readyForPermissionAudit: boolean
  writesVerified: false
}

export async function probeNamespace(config: EnsConfig): Promise<ProbeReport> {
  if (!config.rootRegistry) throw new EnsProbeError('ENS_ROOT_REGISTRY is required for namespace discovery.')
  const client = createPublicClient({ transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) })
  const actualChainId = await client.getChainId()
  if (actualChainId !== config.chainId) throw new EnsProbeError('ENS RPC chain does not match ENS_CHAIN_ID.')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const blockNumber = block.number
  if (blockNumber === null) throw new EnsProbeError('RPC did not return a finalized block number.')
  const parentNamehash = namehash(config.parentName)

  const report: ProbeReport = {
    chainId: actualChainId, blockNumber, blockHash: block.hash, timestamp: block.timestamp,
    parentName: config.parentName, parentNamehash,
    rootRegistry: config.rootRegistry, hierarchy: [],
    v2NamespaceFound: false, readyForPermissionAudit: false, writesVerified: false,
  }

  try {
    const [exists, owner, resolver, ttl] = await Promise.all([
      client.readContract({ address: V1_REGISTRY, abi: ENSV1RegistryAbi, functionName: 'recordExists', args: [parentNamehash], blockNumber }),
      client.readContract({ address: V1_REGISTRY, abi: ENSV1RegistryAbi, functionName: 'owner', args: [parentNamehash], blockNumber }),
      client.readContract({ address: V1_REGISTRY, abi: ENSV1RegistryAbi, functionName: 'resolver', args: [parentNamehash], blockNumber }),
      client.readContract({ address: V1_REGISTRY, abi: ENSV1RegistryAbi, functionName: 'ttl', args: [parentNamehash], blockNumber }),
    ])
    let ownerIsContract: boolean | undefined
    if (owner !== zeroAddress) {
      const code = await client.getCode({ address: owner, blockNumber })
      ownerIsContract = code !== undefined && code !== '0x'
    }
    report.v1Record = {
      exists,
      owner: owner === zeroAddress ? undefined : owner,
      ownerIsContract,
      resolver: resolver === zeroAddress ? undefined : resolver,
      ttl,
    }
  } catch {
    report.v1Record = undefined
  }

  const hasCode = async (address: Address): Promise<`0x${string}`> => {
    const code = await client.getCode({ address, blockNumber })
    if (!code || code === '0x') throw new EnsProbeError(`No deployed contract at ${address}.`)
    return keccak256(code)
  }

  const inspect = async (registry: Address, label: string): Promise<HierarchyEntry> => {
    const codeHash = await hasCode(registry)
    const id = BigInt(keccak256(toHex(label)))
    const [state, child, resolver] = await Promise.all([
      client.readContract({ address: registry, abi: ETHRegistryAbi, functionName: 'getState', args: [id], blockNumber }),
      client.readContract({ address: registry, abi: ETHRegistryAbi, functionName: 'getSubregistry', args: [label], blockNumber }),
      client.readContract({ address: registry, abi: ETHRegistryAbi, functionName: 'getResolver', args: [label], blockNumber }),
    ])
    return { label, registry, codeHash, state, child, resolver }
  }

  const labels = config.parentName.split('.')
  const leaf = labels[0]!
  const ancestors = labels.slice(1).reverse()

  let registry: Address = config.rootRegistry
  for (const label of ancestors) {
    const entry = await inspect(registry, label)
    report.hierarchy.push(entry)
    if (entry.state.status !== 2 || entry.state.expiry <= block.timestamp) {
      report.blockingReason = `Ancestor label ${label} is not active in registry ${registry} at finalized block ${blockNumber}.`
      return report
    }
    if (entry.child === zeroAddress) {
      report.blockingReason = `No child registry for ancestor label ${label}; cannot reach the namespace registry.`
      return report
    }
    registry = entry.child
  }

  const leafEntry = await inspect(registry, leaf)
  report.hierarchy.push(leafEntry)
  report.namespaceRegistry = registry
  report.namespaceOwner = leafEntry.state.latestOwner
  report.namespaceResolver = leafEntry.resolver === zeroAddress ? undefined : leafEntry.resolver
  report.namespaceExpiry = leafEntry.state.expiry
  report.childRegistry = leafEntry.child === zeroAddress ? undefined : leafEntry.child

  if (leafEntry.state.status !== 2 || leafEntry.state.expiry <= block.timestamp) {
    report.blockingReason = `Namespace name ${leaf} is not active in registry ${registry} at finalized block ${blockNumber}.`
    return report
  }

  report.v2NamespaceFound = true
  report.ownerMatches = config.expectedOwner === undefined ? undefined : leafEntry.state.latestOwner.toLowerCase() === config.expectedOwner.toLowerCase()
  report.registryMatches = config.registry === undefined ? undefined : registry.toLowerCase() === config.registry.toLowerCase()
  if (config.childRegistry) report.childRegistryMatches = leafEntry.child.toLowerCase() === config.childRegistry.toLowerCase()
  if (config.expectedOwner) {
    report.ownerRootRoles = await client.readContract({
      address: registry, abi: ETHRegistryAbi, functionName: 'roles', args: [0n, config.expectedOwner], blockNumber,
    })
  }
  report.readyForPermissionAudit = report.ownerMatches === true && report.registryMatches === true &&
    report.childRegistryMatches !== false
  if (!config.expectedOwner || !config.registry) report.blockingReason = 'Set ENS_OWNER_ADDRESS and ENS_REGISTRY_ADDRESS: the probe only reports ready against stated expectations.'
  else if (report.childRegistryMatches === false) report.blockingReason = `${config.parentName}'s live subregistry is not ENS_CHILD_REGISTRY.`
  return report
}
