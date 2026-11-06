import { getAddress, isAddress, zeroAddress, type Address } from 'viem'
import { EnsInputError, normalizeParent } from './names'

export type EnsMode = 'off' | 'display' | 'enrollment' | 'application-enforced'
export type EnsConfig = {
  mode: EnsMode
  chainId: number
  rpc: string
  parentName: string
  expectedOwner?: Address
  rootRegistry?: Address
  registry?: Address
  childRegistry?: Address
  controller?: Address
  reputation?: Address
  universalResolver?: Address
  childRegistryFromBlock?: bigint
}

function address(env: Record<string, string | undefined>, key: string): Address | undefined {
  const raw = env[key]?.trim()
  if (!raw) return undefined
  if (!isAddress(raw, { strict: false }) || raw.toLowerCase() === zeroAddress) throw new EnsInputError(`${key} must be a nonzero address.`)
  return getAddress(raw.toLowerCase())
}

function twoLabels(parent: string): string {
  if (parent.split('.').length !== 2) throw new EnsInputError('ENS_PARENT_NAME must have exactly two labels, like dusk.eth.')
  return parent
}

export function loadEnsConfig(env: Record<string, string | undefined>): EnsConfig {
  const mode = env.ENS_MODE?.trim() || 'off'
  if (!['off', 'display', 'enrollment', 'application-enforced'].includes(mode)) throw new EnsInputError('ENS_MODE is invalid.')
  const rawChain = env.ENS_CHAIN_ID?.trim() || '11155111'
  if (!/^[1-9][0-9]*$/.test(rawChain) || !Number.isSafeInteger(Number(rawChain))) throw new EnsInputError('ENS_CHAIN_ID must be an integer.')
  const chainId = Number(rawChain)
  if (chainId !== 1 && chainId !== 11155111) throw new EnsInputError('ENS supports Ethereum mainnet or Sepolia only.')
  const rpc = env.ENS_RPC?.trim() || (chainId === 11155111 ? 'https://ethereum-sepolia-rpc.publicnode.com' : 'https://ethereum-rpc.publicnode.com')
  try {
    const url = new URL(rpc)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\b(sk|mk)-/.test(rpc)) throw new Error()
  } catch { throw new EnsInputError('ENS_RPC must be an HTTP(S) URL without embedded credentials or compute keys.') }
  const config: EnsConfig = {
    mode: mode as EnsMode, chainId, rpc,
    parentName: twoLabels(normalizeParent(env.ENS_PARENT_NAME?.trim() || 'dusk.eth')),
    expectedOwner: address(env, 'ENS_OWNER_ADDRESS'),
    rootRegistry: address(env, 'ENS_ROOT_REGISTRY'),
    registry: address(env, 'ENS_REGISTRY_ADDRESS'),
    childRegistry: address(env, 'ENS_CHILD_REGISTRY'),
    controller: address(env, 'ENS_CONTROLLER_ADDRESS'),
    reputation: address(env, 'ENS_REPUTATION_ADDRESS'),
    universalResolver: address(env, 'ENS_UNIVERSAL_RESOLVER'),
  }
  const rawFromBlock = env.ENS_CHILD_REGISTRY_DEPLOY_BLOCK?.trim()
  if (rawFromBlock !== undefined && rawFromBlock !== '') {
    if (!/^(0|[1-9][0-9]*)$/.test(rawFromBlock)) throw new EnsInputError('ENS_CHILD_REGISTRY_DEPLOY_BLOCK must be a non-negative integer.')
    config.childRegistryFromBlock = BigInt(rawFromBlock)
  }
  if (mode !== 'off' && !config.registry) throw new EnsInputError('ENS_REGISTRY_ADDRESS is required when ENS is enabled.')
  if (mode !== 'off' && !config.universalResolver) throw new EnsInputError('ENS_UNIVERSAL_RESOLVER is required when ENS is enabled.')
  if ((mode === 'enrollment' || mode === 'application-enforced') && (!config.controller || !config.universalResolver)) {
    throw new EnsInputError('ENS_CONTROLLER_ADDRESS and ENS_UNIVERSAL_RESOLVER are required for enrollment.')
  }
  return config
}
