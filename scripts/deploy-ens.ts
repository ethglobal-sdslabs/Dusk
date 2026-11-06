import '@dusk/core/env'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, isAddress, keccak256, toHex,
  zeroAddress, type Abi, type Account, type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { keyDefect, normaliseKey } from '../packages/core/src/config'
import { controllerJournalStore, controllerRuntimeMatches, resolveControllerDeployment } from './ens-controller-deployment'
import {
  CONTROLLER_ROLES, ETHRegistryAbi, GOVERNANCE_ROLES, loadEnsConfig, RESERVED_LABELS, UserRegistryAbi, VerifiableFactoryAbi,
} from '@dusk/ens'

const here = dirname(fileURLToPath(import.meta.url))
const deployment = JSON.parse(readFileSync(join(here, '..', 'docs', 'ens-deployments', 'sepolia.json'), 'utf8')) as {
  chainId: number; parentName: string; ethRegistry: Address; userRegistryImpl: Address; permissionedResolverImpl: Address; verifiableFactory: Address
}
const CHILD_SALT = BigInt(keccak256(toHex('dusk.eth child registry v1')))
const PARENT_DNS: Hex = '0x046475736b0365746800'
const DAY = 86_400n

function artifact(): { abi: Abi; bytecode: Hex; deployedBytecode: { object: Hex; immutableReferences: Record<string, Array<{ start: number; length: number }>> } } {
  const path = join(here, '..', 'contracts', 'out', 'DuskIdentityController.sol', 'DuskIdentityController.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences: Record<string, Array<{ start: number; length: number }>> } }
    return { abi: parsed.abi, bytecode: parsed.bytecode.object, deployedBytecode: parsed.deployedBytecode }
  } catch {
    throw new Error(`${path} is missing — run "cd contracts && forge build" first`)
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes')
  const impersonate = process.argv.includes('--impersonate')
  const config = loadEnsConfig({ ...process.env, ENS_MODE: 'off' })
  if (config.chainId !== deployment.chainId || config.parentName !== deployment.parentName || config.registry?.toLowerCase() !== deployment.ethRegistry.toLowerCase()) {
    throw new Error('config.json ens settings do not match the pinned Sepolia dusk.eth deployment. Refusing to deploy into an unverified namespace.')
  }
  const rpc = arg('--rpc') ?? config.rpc
  if (impersonate && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(rpc)) {
    throw new Error('--impersonate only drives a local fork; pass --rpc http://127.0.0.1:<port>')
  }
  if (!config.expectedOwner) throw new Error('config.json ens.ownerAddress is required')
  const owner = config.expectedOwner
  const revokerRaw = process.env.ENS_REVOKER_ADDRESS?.trim()
  if (!revokerRaw || !isAddress(revokerRaw, { strict: false })) throw new Error('config.json ens.revokerAddress must be a public wallet or contract address. No value is repeated here.')
  const revoker = getAddress(revokerRaw.toLowerCase())
  if (revoker === zeroAddress) throw new Error('config.json ens.revokerAddress must not be the zero address.')
  if (revoker.toLowerCase() === owner.toLowerCase()) {
    throw new Error('config.json ens.revokerAddress must differ from the owner: the revoker is the narrow, rate-limited role')
  }

  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) })
  if ((await pub.getChainId()) !== config.chainId) throw new Error(`RPC is not chain ${config.chainId}`)

  let account: Account | Address
  if (impersonate) {
    account = owner
  } else {
    const key = process.env.ENS_OWNER_PRIVATE_KEY?.trim()
    if (!key && yes) throw new Error('config.json operators.ensOwnerPrivateKey is required for the namespace operator to send deployment transactions.')
    if (key && keyDefect(normaliseKey(key))) throw new Error('The namespace operator signing key is invalid. Its value is deliberately withheld.')
    account = key ? privateKeyToAccount(normaliseKey(key) as Hex) : owner
    if (typeof account !== 'string' && account.address.toLowerCase() !== owner.toLowerCase()) {
      throw new Error('The namespace operator signing key does not belong to config.json ens.ownerAddress')
    }
  }
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account })
  const send = async (what: string, tx: { to: Address; data: Hex }) => {
    if (!yes) { console.log(`  would send: ${what}`); return }
    const hash = await wallet.sendTransaction({ ...tx, account, chain: sepolia })
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${what} reverted in ${hash}`)
    console.log(`  ${what}: ${hash}`)
    return receipt
  }

  const duskId = BigInt(keccak256(toHex('dusk')))
  const dusk = await pub.readContract({ address: deployment.ethRegistry, abi: ETHRegistryAbi, functionName: 'getState', args: [duskId] })
  const now = (await pub.getBlock()).timestamp
  if (dusk.status !== 2 || dusk.expiry <= now) throw new Error('dusk.eth is not active. No deployment transactions were sent.')
  if (dusk.latestOwner.toLowerCase() !== owner.toLowerCase()) throw new Error(`dusk is owned by ${dusk.latestOwner}, not ${owner}`)
  console.log(`── dusk.eth on chain ${config.chainId} — owner ${owner}, expires ${new Date(Number(dusk.expiry) * 1000).toISOString()}`)

  const child = await pub.readContract({ address: deployment.verifiableFactory, abi: VerifiableFactoryAbi, functionName: 'predictProxyAddress', args: [owner, CHILD_SALT] })
  const existingChild = await pub.readContract({ address: deployment.ethRegistry, abi: ETHRegistryAbi, functionName: 'getSubregistry', args: ['dusk'] })
  if (existingChild !== zeroAddress && existingChild.toLowerCase() !== child.toLowerCase()) throw new Error('dusk.eth already has a different child registry. A reviewed migration is required; nothing was sent.')
  const childCode = await pub.getCode({ address: child })
  if (childCode && childCode !== '0x') {
    console.log(`1. child registry   ${child} (exists)`)
  } else {
    console.log(`1. child registry   ${child}`)
    const init = encodeFunctionData({ abi: UserRegistryAbi, functionName: 'initialize', args: [[{ account: owner, roleBitmap: GOVERNANCE_ROLES }]] })
    await send('deployProxy(UserRegistry)', {
      to: deployment.verifiableFactory,
      data: encodeFunctionData({ abi: VerifiableFactoryAbi, functionName: 'deployProxy', args: [deployment.userRegistryImpl, CHILD_SALT, init] }),
    })
  }

  const { abi, bytecode, deployedBytecode } = artifact()
  const parameters = {
    registry: child, parentRegistry: deployment.ethRegistry, parentId: duskId, factory: deployment.verifiableFactory,
    resolverImplementation: deployment.permissionedResolverImpl, parentDnsName: PARENT_DNS, governance: owner, revoker,
    term: 365n * DAY, minCommitmentAge: 60n, maxCommitmentAge: DAY, revocationsPerDay: 10n, reservedLabels: [...RESERVED_LABELS],
  }
  const data = encodeDeployData({ abi, bytecode, args: [parameters] })
  const forkSuffix = impersonate ? `-fork-${new URL(rpc).port || '80'}` : ''
  const journalPath = join(arg('--journal-dir') ?? join(here, '..', '.dusk', 'ens-deployments'), `${config.chainId}-${child.toLowerCase()}${forkSuffix}.json`)
  const store = controllerJournalStore(journalPath)
  const pending = store.load()
  const resolved = !config.controller || pending ? await resolveControllerDeployment({
    context: { chainId: config.chainId, owner, child, calldataHash: keccak256(data) }, data, store,
    ...(yes ? { send: () => wallet.sendTransaction({ data, account, chain: sepolia }) } : {}),
    wait: (hash) => pub.waitForTransactionReceipt({ hash, timeout: 120_000 }),
    transaction: (hash) => pub.getTransaction({ hash }),
  }) : undefined
  if (resolved && config.controller && resolved.address.toLowerCase() !== config.controller.toLowerCase()) {
    throw new Error('The recorded controller deployment differs from config.json ens.controllerAddress. Resolve that discrepancy before granting authority.')
  }
  const controller = config.controller ?? resolved?.address
  if (controller) {
    const code = await pub.getCode({ address: controller })
    if (!controllerRuntimeMatches(code, deployedBytecode)) throw new Error('The controller has no code or does not match the compiled controller runtime. No registry authority was granted.')
    const expected = {
      REGISTRY: child, PARENT_REGISTRY: deployment.ethRegistry, PARENT_ID: duskId, FACTORY: deployment.verifiableFactory,
      RESOLVER_IMPLEMENTATION: deployment.permissionedResolverImpl, parentDnsName: PARENT_DNS, governance: owner, revoker,
      TERM: parameters.term, MIN_COMMITMENT_AGE: parameters.minCommitmentAge, MAX_COMMITMENT_AGE: parameters.maxCommitmentAge,
      revocationsPerDay: parameters.revocationsPerDay,
    }
    for (const [functionName, value] of Object.entries(expected)) {
      const actual = await pub.readContract({ address: controller, abi, functionName })
      if (String(actual).toLowerCase() !== String(value).toLowerCase()) throw new Error(`The controller's ${functionName} does not match the planned namespace configuration. No registry authority was granted.`)
    }
    console.log(`2. controller       ${controller}${resolved ? ` (verified transaction ${resolved.transactionHash})` : ' (verified existing deployment)'}`)
  } else {
    console.log('2. controller       (new)')
    console.log('  would send: deploy DuskIdentityController')
  }

  if (controller && await pub.readContract({ address: child, abi: UserRegistryAbi, functionName: 'hasRootRoles', args: [CONTROLLER_ROLES, controller] })) {
    console.log('3. controller roles (granted)')
  } else {
    console.log('3. controller roles')
    if (controller) await send('grantRootRoles(controller)', { to: child, data: encodeFunctionData({ abi: UserRegistryAbi, functionName: 'grantRootRoles', args: [CONTROLLER_ROLES, controller] }) })
    else console.log('  would send: grantRootRoles(controller)')
  }

  const parentCode = await pub.getCode({ address: child })
  const [parent, label] = parentCode && parentCode !== '0x'
    ? await pub.readContract({ address: child, abi: UserRegistryAbi, functionName: 'getParent' })
    : [zeroAddress, '']
  if (parent.toLowerCase() === deployment.ethRegistry.toLowerCase() && label === 'dusk') {
    console.log('4. parent pointer   (set)')
  } else {
    console.log('4. parent pointer')
    await send('setParent(.eth, "dusk")', { to: child, data: encodeFunctionData({ abi: UserRegistryAbi, functionName: 'setParent', args: [deployment.ethRegistry, 'dusk'] }) })
  }

  const current = await pub.readContract({ address: deployment.ethRegistry, abi: ETHRegistryAbi, functionName: 'getSubregistry', args: ['dusk'] })
  if (current.toLowerCase() === child.toLowerCase()) {
    console.log('5. subregistry      (attached)')
  } else {
    if (current !== zeroAddress) throw new Error('dusk.eth changed its child registry during deployment. Refusing to replace it.')
    console.log('5. subregistry')
    await send('setSubregistry(dusk, child)', { to: deployment.ethRegistry, data: encodeFunctionData({ abi: ETHRegistryAbi, functionName: 'setSubregistry', args: [dusk.tokenId, child] }) })
  }

  console.log(yes ? '\n── done. Update config.json ens:' : '\n── dry run; nothing sent. Re-run with --yes. Planned config.json ens values:')
  console.log(JSON.stringify({ childRegistry: child, controllerAddress: controller ?? '<deployed address>', ...(resolved ? { controllerDeployBlock: String(resolved.blockNumber) } : {}) }, null, 2))
  console.log('Keep controllerDeployBlock from the verified creation receipt and rebuild the web app.')
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : 'ENS deployment failed; no URL is repeated here.'
  console.error(message)
  process.exitCode = 1
}
