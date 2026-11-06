import { createPublicClient, getAddress, http, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex, type Log, type PublicClient } from 'viem'
import { normalize } from 'viem/ens'
import { ETHRegistryAbi } from './abi'
import { DuskIdentityControllerAbi } from './controller-abi'
import type { EnsConfig } from './config'
import { normalizeLabel } from './names'
import type { IdentitySnapshot } from './policy'

type AtBlock = { universalResolverAddress: Address; blockNumber?: bigint }

export interface EnsChainClient {
  getChainId(): Promise<number>
  getBlock(args: { blockTag: 'latest' }): Promise<{ number: bigint | null; timestamp: bigint }>
  readContract: PublicClient['readContract']
  getEnsAddress(args: { name: string } & AtBlock): Promise<Address | null>
  getEnsName(args: { address: Address } & AtBlock): Promise<string | null>
  getEnsText(args: { name: string; key: string } & AtBlock): Promise<string | null>
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>
  getLogs(args: {
    address: Address
    fromBlock: bigint
    toBlock: bigint
    event: { type: 'event'; name: string; inputs: readonly { indexed?: boolean; name: string; type: string }[] }
  }): Promise<Log[]>
}

const REGISTERED = 2
const MEMBERSHIP_NONE = 0

const LABEL_REGISTERED = {
  type: 'event',
  name: 'LabelRegistered',
  inputs: [
    { indexed: true, name: 'tokenId', type: 'uint256' },
    { indexed: true, name: 'labelHash', type: 'bytes32' },
    { name: 'label', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { indexed: true, name: 'sender', type: 'address' },
  ],
} as const

export type VerifiedIdentity = IdentitySnapshot & {
  subregistry?: Address
  blockNumber?: bigint
  reason?: string
}

export type Profile = { description?: string; url?: string }

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function sanitizeProfileText(raw: string, maxBytes: number): string {
  const bounded = raw.slice(0, maxBytes * 8)
  // eslint-disable-next-line no-control-regex
  const text = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    out += ch
  }
  return out.trimEnd()
}

function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 200) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function candidateLabel(candidate: string, parent: string): string | undefined {
  try {
    const name = candidate.includes('.') ? normalize(candidate) : undefined
    const raw = name === undefined ? candidate : name.endsWith(`.${parent}`) ? name.slice(0, -parent.length - 1) : undefined
    if (raw === undefined || raw.includes('.')) return undefined
    return normalizeLabel(raw)
  } catch {
    return undefined
  }
}

export function createEnsReader(config: EnsConfig, client?: EnsChainClient, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now
  const chain: EnsChainClient = client ?? createPublicClient({ transport: http(config.rpc, { timeout: 15_000, retryCount: 1 }) })
  const [first, ...rest] = config.parentName.split('.')
  if (!first || rest.length === 0) throw new Error('ENS parent must have a label under a registry.')
  const leaf: string = first

  let labelScan: { key: string; labels: { label: string; owner: Address }[] } | undefined

  const deployScan = new Map<string, bigint>()

  const prunedRead = (e: unknown): boolean => {
    const details = e instanceof Error && 'details' in e ? String((e as { details: unknown }).details ?? '') : ''
    return /pruned|exceed maximum block range/i.test(`${e instanceof Error ? e.message : ''} ${details}`)
  }

  async function codeAt(sub: Address, blockNumber: bigint): Promise<boolean> {
    try {
      const code = await chain.getCode({ address: sub, blockNumber })
      return !!code && code !== '0x'
    } catch (e) {
      if (prunedRead(e)) return false
      throw e
    }
  }

  async function registryDeployBlock(sub: Address, blockNumber: bigint): Promise<bigint | undefined> {
    const key = sub.toLowerCase()
    const known = deployScan.get(key)
    if (known !== undefined) return known
    if (!(await codeAt(sub, blockNumber))) return undefined
    let low = 0n
    let high = blockNumber
    while (low < high) {
      const mid = (low + high) / 2n
      if (await codeAt(sub, mid)) high = mid
      else low = mid + 1n
    }
    deployScan.set(key, low)
    return low
  }

  async function registryOwnedName(
    wallet: Address,
    sub: Address,
    blockNumber: bigint,
    blockTimestamp: bigint,
    universalResolverAddress: Address,
  ): Promise<string | undefined> {
    const key = `${sub.toLowerCase()}:${blockNumber}`
    if (!labelScan || labelScan.key !== key) {
      const from = config.childRegistryFromBlock ?? (await registryDeployBlock(sub, blockNumber))
      if (from === undefined) return undefined
      const CHUNK = 40_000n
      const logs: Log[] = []
      for (let start = from; start <= blockNumber; start += CHUNK) {
        const end = start + CHUNK - 1n < blockNumber ? start + CHUNK - 1n : blockNumber
        logs.push(...(await chain.getLogs({ address: sub, fromBlock: start, toBlock: end, event: LABEL_REGISTERED })))
      }
      const labels: { label: string; owner: Address }[] = []
      for (const log of logs) {
        const args = (log as Log & { args?: unknown }).args as unknown as { label?: unknown; owner?: unknown }
        if (typeof args?.label !== 'string' || typeof args.owner !== 'string' || !isAddress(args.owner, { strict: false })) continue
        labels.push({ label: args.label, owner: getAddress(args.owner.toLowerCase()) })
      }
      labelScan = { key, labels }
    }
    for (const entry of labelScan.labels) {
      if (!sameAddress(entry.owner, wallet)) continue
      const label = candidateLabel(entry.label, config.parentName)
      if (label === undefined) continue
      const state = await chain.readContract({ address: sub, abi: ETHRegistryAbi, functionName: 'getState', args: [BigInt(keccak256(toHex(label)))], blockNumber })
      if (!sameAddress(state.latestOwner, wallet)) continue
      if (state.status !== REGISTERED || state.expiry <= blockTimestamp) continue
      const name = `${label}.${config.parentName}`
      const resolved = await chain.getEnsAddress({ name, universalResolverAddress, blockNumber })
      if (!resolved || !sameAddress(resolved, wallet)) continue
      return name
    }
    return undefined
  }

  async function identityOf(wallet: Address, args: { candidate?: string } = {}): Promise<VerifiedIdentity> {
    const snapshot: VerifiedIdentity = {
      wallet, chainId: config.chainId, registry: config.registry ?? zeroAddress, status: 'unknown', checkedAt: now(),
    }
    const unknown = (reason: string): VerifiedIdentity => ({ ...snapshot, status: 'unknown', reason })
    if (!config.registry || !config.universalResolver) return unknown('ENS reads are not configured.')
    if (!isAddress(wallet, { strict: false })) return unknown('Not a wallet address.')
    const universalResolverAddress = config.universalResolver
    snapshot.wallet = getAddress(wallet.toLowerCase())

    try {
      if ((await chain.getChainId()) !== config.chainId) return unknown('ENS RPC is not on the configured chain.')
      const block = await chain.getBlock({ blockTag: 'latest' })
      const blockNumber = block.number
      if (blockNumber === null) return unknown('ENS RPC returned a pending block.')
      snapshot.blockNumber = blockNumber

      const parent = await chain.readContract({
        address: config.registry, abi: ETHRegistryAbi, functionName: 'getState', args: [BigInt(keccak256(toHex(leaf)))], blockNumber,
      })
      if (parent.status !== REGISTERED || parent.expiry <= block.timestamp) return unknown(`${config.parentName} is not an active name.`)
      const sub = await chain.readContract({ address: config.registry, abi: ETHRegistryAbi, functionName: 'getSubregistry', args: [leaf], blockNumber })
      if (config.childRegistry && !sameAddress(sub, config.childRegistry)) return unknown(`${config.parentName}'s subregistry is not the configured one.`)
      if (sub === zeroAddress) return { ...snapshot, status: 'unnamed' }
      snapshot.subregistry = sub

      let candidate = args.candidate
      let generation: bigint | undefined
      if (config.controller) {
        const controller = config.controller
        const [registry, ban, membership] = await Promise.all([
          chain.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY', blockNumber }),
          chain.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'banOf', args: [snapshot.wallet], blockNumber }),
          chain.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'membershipOf', args: [snapshot.wallet], blockNumber }),
        ])
        if (!sameAddress(registry, sub)) return unknown('The configured controller does not issue into dusk.eth\'s registry.')
        const [label, gen] = membership
        if (ban[0]) {
          return { ...snapshot, status: 'banned', ...(label ? { name: `${label}.${config.parentName}`, generation: gen } : {}) }
        }
        if (membership[4] === MEMBERSHIP_NONE) {
          const direct = await registryOwnedName(snapshot.wallet, sub, blockNumber, block.timestamp, universalResolverAddress)
          return direct ? { ...snapshot, status: 'active', name: direct } : { ...snapshot, status: 'unnamed' }
        }
        candidate = label
        generation = gen
      } else {
        candidate ??= (await chain.getEnsName({ address: snapshot.wallet, universalResolverAddress, blockNumber })) ?? undefined
      }
      const label = candidate === undefined ? undefined : candidateLabel(candidate, config.parentName)
      if (label === undefined) {
        const direct = await registryOwnedName(snapshot.wallet, sub, blockNumber, block.timestamp, universalResolverAddress)
        return direct ? { ...snapshot, status: 'active', name: direct } : { ...snapshot, status: 'unnamed' }
      }
      const name = `${label}.${config.parentName}`

      const entry = await chain.readContract({ address: sub, abi: ETHRegistryAbi, functionName: 'getState', args: [BigInt(keccak256(toHex(label)))], blockNumber })
      if (!sameAddress(entry.latestOwner, snapshot.wallet)) return { ...snapshot, status: 'unnamed' }
      const gen = generation === undefined ? {} : { generation }
      if (entry.status !== REGISTERED || entry.expiry <= block.timestamp) return { ...snapshot, status: 'expired', name, ...gen }

      const resolved = await chain.getEnsAddress({ name, universalResolverAddress, blockNumber })
      if (!resolved || !sameAddress(resolved, snapshot.wallet)) {
        return { ...snapshot, status: 'mismatch', name, ...gen, reason: `${name} does not resolve to its owner.` }
      }
      return { ...snapshot, status: 'active', name, ...gen }
    } catch {
      return unknown('ENS could not be read. Retry later.')
    }
  }

  async function profileOf(identity: VerifiedIdentity): Promise<Profile> {
    if (identity.status !== 'active' || !identity.name || !config.universalResolver) return {}
    const read = (key: string) => chain.getEnsText({
      name: identity.name!, key, universalResolverAddress: config.universalResolver!, blockNumber: identity.blockNumber,
    }).catch(() => null)
    const [description, url] = await Promise.all([read('description'), read('url')])
    const profile: Profile = {}
    const text = description ? sanitizeProfileText(description, 280) : ''
    if (text) profile.description = text
    const link = url ? safeUrl(url) : undefined
    if (link) profile.url = link
    return profile
  }

  return { identityOf, profileOf }
}

export type EnsReader = ReturnType<typeof createEnsReader>
