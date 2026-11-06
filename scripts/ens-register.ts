import '@dusk/core/env'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseEventLogs, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { partyKey, type Party } from '@dusk/core'
import {
  DuskIdentityControllerAbi, PermissionedResolverAbi, commitmentOf, createEnsReader, describeEnsError, dnsEncode,
  loadEnsConfig, newRegistration, registrationStage, type RegistrationOp,
} from '@dusk/ens'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1] }
const here = dirname(fileURLToPath(import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const label = process.argv[2]
  if (!label || label.startsWith('--')) throw new Error('usage: pnpm ens:register <label> [--party buyer|worker] [--description <text>]')
  const party = (arg('--party') ?? 'worker') as Party
  if (party !== 'buyer' && party !== 'worker') throw new Error('--party is buyer or worker')
  const rpc = arg('--rpc')
  const config = loadEnsConfig({ ...process.env, ...(rpc ? { ENS_RPC: rpc } : {}), ENS_MODE: 'enrollment' })
  const controller = config.controller!
  const account = privateKeyToAccount(partyKey(process.env, party))
  const pub = createPublicClient({ chain: sepolia, transport: http(config.rpc) })
  const wallet = createWalletClient({ chain: sepolia, transport: http(config.rpc), account })
  if ((await pub.getChainId()) !== config.chainId) throw new Error(`ENS RPC is not chain ${config.chainId}`)

  const reader = createEnsReader(config, pub)
  const before = await reader.identityOf(account.address)
  if (before.status === 'active') { console.log(`${account.address} already holds ${before.name}`); return }
  if (before.status === 'banned') throw new Error('This wallet is banned from registering a Dusk name.')

  const path = join(here, '..', '.dusk', 'ens', `${config.chainId}-${controller.toLowerCase()}-${account.address.toLowerCase()}.json`)
  const [minAge, maxAge] = await Promise.all([
    pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'MIN_COMMITMENT_AGE' }),
    pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'MAX_COMMITMENT_AGE' }),
  ])
  const timing = { minAgeSec: Number(minAge), maxAgeSec: Number(maxAge) }
  const save = (o: RegistrationOp) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(o, null, 2), { mode: 0o600 }) }
  let op: RegistrationOp = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as RegistrationOp : undefined as never
  const chainNow = async () => Number((await pub.getBlock()).timestamp) * 1000
  if (!op || registrationStage(op, await chainNow(), timing) === 'expired' || op.label !== label.toLowerCase()) {
    op = newRegistration({ chainId: config.chainId, controller, wallet: account.address, label, parentName: config.parentName, now: Date.now() })
    save(op)
  }
  console.log(`── ${op.name} for ${account.address} (${party})`)

  const commitment = commitmentOf(op)
  const onChain = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'makeCommitment', args: [op.label, op.wallet, op.secret] })
  if (onChain !== commitment) throw new Error('Local commitment disagrees with the controller — refusing to send.')

  if (!op.commitTx) {
    const available = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'availableTo', args: [op.label, account.address] })
    if (!available) throw new Error(`${op.name} is not available.`)
    op.commitTx = await wallet.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'commit', args: [commitment] })
    save(op)
    console.log(`  commit   ${op.commitTx}`)
  }
  if (op.committedAt === undefined) {
    const receipt = await pub.waitForTransactionReceipt({ hash: op.commitTx })
    if (receipt.status !== 'success') { save({ ...op, commitTx: undefined }); throw new Error('The commit transaction reverted.') }
    op.committedAt = Number((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp) * 1000
    save(op)
  }
  while (registrationStage(op, await chainNow(), timing) === 'waiting') {
    console.log(`  waiting for the commitment to age (${timing.minAgeSec}s, chain time)…`)
    await sleep(10_000)
  }
  if (!op.registerTx) {
    op.registerTx = await wallet.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'register', args: [op.label, op.secret] })
    save(op)
    console.log(`  register ${op.registerTx}`)
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: op.registerTx })
  if (receipt.status !== 'success') { save({ ...op, registerTx: undefined }); throw new Error('The register transaction reverted; re-run to retry the reveal.') }
  const [event] = parseEventLogs({ abi: DuskIdentityControllerAbi, eventName: 'Registered', logs: receipt.logs })
  op.registeredAt = Date.now()
  save(op)
  console.log(`  resolver ${event?.args.resolver} · generation ${event?.args.generation}`)

  const description = arg('--description')
  if (description && event) {
    const hash = await wallet.writeContract({ address: event.args.resolver, abi: PermissionedResolverAbi, functionName: 'setText', args: [dnsEncode(op.name), 'description', description] })
    await pub.waitForTransactionReceipt({ hash })
    console.log(`  setText  ${hash}`)
  }

  const after = await reader.identityOf(account.address)
  console.log(`── verified: ${after.status}${after.name ? ` · ${after.name}` : ''}${after.reason ? ` · ${after.reason}` : ''}`)
  const profile = await reader.profileOf(after)
  if (profile.description) console.log(`  description: ${profile.description}`)
  if (after.status !== 'active') process.exitCode = 1
}

try {
  await main()
} catch (error) {
  if (process.env.DEBUG_ENS) console.error(String(error instanceof Error ? error.stack ?? error.message : error).replace(/https?:\/\/\S+/g, '<url redacted>'))
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) && !(error as { shortMessage?: string }).shortMessage ? error.message : describeEnsError(error))
  process.exitCode = 1
}
