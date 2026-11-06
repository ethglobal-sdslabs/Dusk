import '@dusk/core/env'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, isAddress, keccak256, namehash, type Account, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, sepolia } from 'viem/chains'
import { DuskIdentityControllerAbi, DuskReputationAbi, commitmentOf, dnsEncode, newRegistration, type RegistrationOp } from '@dusk/ens'
import { keyDefect, normaliseKey } from '../packages/core/src/config'
import { controllerJournalStore, controllerRuntimeMatches, resolveControllerDeployment } from './ens-controller-deployment'
import { reputationSetup } from './reputation-config'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

async function main() {
  const yes = process.argv.includes('--yes')
  const impersonate = process.argv.includes('--impersonate')
  const setup = reputationSetup({ ...process.env, ...(arg('--rpc') ? { ENS_RPC: arg('--rpc') } : {}) })
  const { ens, sourceHash, policy, workflowOwner } = setup
  const controller = ens.controller!
  if (!ens.expectedOwner || !ens.childRegistry) throw new Error('config.json needs the verified namespace owner and child registry before reputation setup.')
  const owner = ens.expectedOwner
  if (impersonate && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(ens.rpc)) throw new Error('Impersonation is permitted only on a local fork.')
  const chain = ens.chainId === 1 ? mainnet : sepolia
  const client = createPublicClient({ chain, transport: http(ens.rpc) })
  if (await client.getChainId() !== ens.chainId) throw new Error('The ENS RPC is on another chain.')
  const [governance, registry, parent] = await Promise.all([
    client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'governance' }),
    client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY' }),
    client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'parentDnsName' }),
  ])
  if (!same(governance, owner) || !same(registry, ens.childRegistry) || parent !== dnsEncode(ens.parentName)) throw new Error('Controller governance or namespace differs from the verified configuration; nothing was sent.')
  let account: Address | Account = owner
  if (!impersonate && process.env.ENS_OWNER_PRIVATE_KEY?.trim()) {
    const key = normaliseKey(process.env.ENS_OWNER_PRIVATE_KEY.trim())
    if (keyDefect(key)) throw new Error('The company setup signing key is invalid; its value is withheld.')
    account = privateKeyToAccount(key as Hex)
    if (!same(account.address, owner)) throw new Error('The company setup signing key does not match namespace governance.')
  }
  if (yes && !impersonate && typeof account === 'string') throw new Error('Namespace governance must sign setup. Configure its signer locally; no key belongs in the browser or CRE workflow.')
  const wallet = createWalletClient({ chain, transport: http(ens.rpc), account })
  const artifact = JSON.parse(readFileSync(resolve('contracts/out/DuskReputation.sol/DuskReputation.json'), 'utf8')) as {
    bytecode: { object: Hex }; deployedBytecode: { object: Hex; immutableReferences: Record<string, Array<{ start: number; length: number }>> }
  }
  const data = encodeDeployData({ abi: DuskReputationAbi, bytecode: artifact.bytecode.object, args: [controller, sourceHash] })
  const suffix = impersonate ? `-fork-${new URL(ens.rpc).port}` : ''
  const journalRoot = arg('--journal-dir') ?? '.dusk/ens-deployments'
  const store = controllerJournalStore(resolve(journalRoot, `reputation-${ens.chainId}-${controller.toLowerCase()}${suffix}.json`))
  const recovered = !ens.reputation || store.load() ? await resolveControllerDeployment({
    context: { chainId: ens.chainId, owner, child: registry, calldataHash: keccak256(data) }, data, store,
    ...(yes ? { send: () => wallet.sendTransaction({ data, account, chain }) } : {}),
    wait: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }), transaction: (hash) => client.getTransaction({ hash }),
  }) : undefined
  if (ens.reputation && recovered && !same(ens.reputation, recovered.address)) throw new Error('The journal and configured reputation address disagree; reconcile them before granting authority.')
  const reputation = ens.reputation ?? recovered?.address
  if (!reputation) {
    console.log(`Dry run: deploy DuskReputation, configure score < ${policy.below} with >= ${policy.minimumResolved} resolved jobs, assign its revoker role and claim revoker.${ens.parentName}.`)
    console.log(`Approved workflow owner: ${workflowOwner}; source context: ${sourceHash}`)
    console.log('Workflow identity/forwarder must be configured before activation. Nothing was sent.')
    return
  }
  if (!controllerRuntimeMatches(await client.getCode({ address: reputation }), artifact.deployedBytecode)) throw new Error('The deployed reputation runtime differs from the compiled artifact; no authority was granted.')
  const [boundController, company, parentNode] = await Promise.all([
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'CONTROLLER' }),
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'company' }),
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'PARENT_NODE' }),
  ])
  if (!same(boundController, controller) || !same(company, owner) || parentNode !== namehash(ens.parentName)) throw new Error('Reputation company/controller/namespace binding does not match; no authority was granted.')
  const send = async (description: string, to: Address, encoded: Hex) => {
    if (!yes) { console.log(`Would send: ${description}`); return }
    const hash = await wallet.sendTransaction({ to, data: encoded, account, chain })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== 'success') throw new Error(`${description} reverted; reconcile the transaction before retrying.`)
    console.log(`${description}: ${hash}`)
  }
  const [below, minimum, age, sources] = await Promise.all([
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'revokeBelow' }),
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'minimumResolved' }),
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'maxReportAge' }),
    client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'sourceContextHash' }),
  ])
  if (below !== policy.below || minimum !== policy.minimumResolved || age !== BigInt(policy.maxReportAge) || sources !== sourceHash) await send('configure company policy', reputation,
    encodeFunctionData({ abi: DuskReputationAbi, functionName: 'configurePolicy', args: [policy.below, policy.minimumResolved, BigInt(policy.maxReportAge), sourceHash] }))
  const currentRevoker = await client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'revoker' })
  if (!same(currentRevoker, reputation)) {
    const expected = process.env.ENS_REVOKER_ADDRESS?.trim()
    if (!expected || !same(expected, currentRevoker)) throw new Error('The current revoker differs from the configured migration source; no replacement role was assigned.')
    await send('assign revoker contract', controller, encodeFunctionData({ abi: DuskIdentityControllerAbi, functionName: 'setRevoker', args: [reputation] }))
  }
  const workflowId = process.env.DUSK_REPUTATION_WORKFLOW_ID?.trim()
  const forwarderRaw = process.env.DUSK_REPUTATION_FORWARDER?.trim()
  if (workflowId && /^0x[0-9a-f]{64}$/i.test(workflowId) && forwarderRaw && isAddress(forwarderRaw, { strict: false })) {
    const forwarder = getAddress(forwarderRaw.toLowerCase())
    const [actualForwarder, actualOwner, actualId] = await Promise.all([
      client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'forwarder' }),
      client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'workflowOwner' }),
      client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'workflowId' }),
    ])
    if (!same(forwarder, actualForwarder) || !same(workflowOwner, actualOwner) || workflowId !== actualId) await send('approve decentralized workflow', reputation,
      encodeFunctionData({ abi: DuskReputationAbi, functionName: 'configureWorkflow', args: [forwarder, workflowOwner, workflowId as Hex] }))
  } else if (process.argv.includes('--activate')) throw new Error('Set the verified CRE forwarder and registered company workflow ID in config.json before activation.')
  if (yes && !process.argv.includes('--skip-name')) {
    const membership = await client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'membershipOf', args: [reputation] })
    if (membership[0] !== 'revoker' || membership[4] !== 1) {
      if (membership[1] !== 0n) throw new Error('The operator name needs reviewed renewal or recovery; it was not replaced.')
      if (!(await client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'availableTo', args: ['revoker', reputation] }))) throw new Error('The operator name is already held or tombstoned; a reviewed migration is required.')
      const operationPath = resolve(journalRoot, `operator-name-${ens.chainId}-${reputation.toLowerCase()}${suffix}.json`)
      let operation: RegistrationOp
      if (existsSync(operationPath)) {
        try { operation = JSON.parse(readFileSync(operationPath, 'utf8')) as RegistrationOp } catch { throw new Error('The operator-name recovery file is unreadable; no new reservation was sent.') }
        if (operation.chainId !== ens.chainId || !same(operation.controller, controller) || !same(operation.wallet, reputation) || operation.label !== 'revoker' || !/^0x[0-9a-f]{64}$/i.test(operation.secret)) throw new Error('The operator-name recovery file belongs to another operation; reconcile it before retrying.')
      } else operation = newRegistration({ chainId: ens.chainId, controller, wallet: reputation, parentName: ens.parentName, label: 'revoker', now: Date.now() })
      const save = () => { mkdirSync(dirname(operationPath), { recursive: true }); writeFileSync(operationPath, JSON.stringify(operation), { mode: 0o600 }) }
      save()
      if (!operation.commitTx) {
        operation.commitTx = await wallet.writeContract({ address: reputation, abi: DuskReputationAbi, functionName: 'commitOperatorName', args: [commitmentOf(operation)] }); save()
      }
      const commitReceipt = await client.waitForTransactionReceipt({ hash: operation.commitTx, timeout: 120_000 })
      if (commitReceipt.status !== 'success') throw new Error('Operator-name commitment reverted; reconcile its saved operation before retrying.')
      const committedAt = (await client.getBlock({ blockNumber: commitReceipt.blockNumber })).timestamp
      const minimumAge = await client.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'MIN_COMMITMENT_AGE' })
      if (impersonate) {
        await client.request({ method: 'evm_increaseTime' as never, params: [Number(minimumAge) + 1] as never })
        await client.request({ method: 'evm_mine' as never })
      }
      while ((await client.getBlock()).timestamp <= committedAt + minimumAge) await new Promise((done) => setTimeout(done, 5000))
      if (!operation.registerTx) {
        operation.registerTx = await wallet.writeContract({ address: reputation, abi: DuskReputationAbi, functionName: 'registerOperatorName', args: [operation.secret] }); save()
      }
      const receipt = await client.waitForTransactionReceipt({ hash: operation.registerTx, timeout: 120_000 })
      if (receipt.status !== 'success') throw new Error('Operator-name reveal reverted; reconcile its saved operation before retrying.')
      operation.registeredAt = Date.now(); save()
      console.log(`Operator name registered: revoker.${ens.parentName} -> ${reputation}`)
    }
  }
  if (process.argv.includes('--activate') && await client.readContract({ address: reputation, abi: DuskReputationAbi, functionName: 'paused' })) await send('activate approved workflow reports', reputation,
    encodeFunctionData({ abi: DuskReputationAbi, functionName: 'setPaused', args: [false] }))
  console.log(JSON.stringify({ ens: { reputationAddress: reputation, revokerAddress: reputation }, reputation: { ...(recovered ? { deployBlock: String(recovered.blockNumber) } : {}), workflowOwner } }, null, 2))
  console.log(yes ? 'Record these public values in config.json. CRE deployment/activation is a separate signed company operation.' : 'Dry run; nothing sent.')
}

try { await main() } catch (error) {
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) && !(error as { shortMessage?: string }).shortMessage ? error.message : 'Reputation setup failed; no signing value or RPC URL is repeated.')
  process.exitCode = 1
}
