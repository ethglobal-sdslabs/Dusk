import '@dusk/core/env'
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, getAddress, http, isAddress, keccak256, toHex, zeroHash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { DuskIdentityControllerAbi, describeEnsError, loadEnsConfig } from '@dusk/ens'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1] }
const STATUS = ['none', 'active', 'expired', 'lost'] as const

async function main(): Promise<void> {
  const target = process.argv[2]
  if (!target || !isAddress(target, { strict: false })) throw new Error('usage: pnpm ens:revoke <wallet> --decision <id-text> [--reason <code>] [--evidence <text> | --evidence-file <path>] [--yes]')
  const wallet = getAddress(target.toLowerCase())
  const decision = arg('--decision')
  if (!decision) throw new Error('--decision is required: a unique, human-readable id for this decision (e.g. "2026-11-06-spam-1")')
  const unban = process.argv.includes('--unban')
  const yes = process.argv.includes('--yes')
  const reason = Number(arg('--reason') ?? '0')
  if (!Number.isInteger(reason) || reason < 0 || reason > 65_535) throw new Error('--reason is a uint16 code')
  const evidenceFile = arg('--evidence-file')
  const evidence = evidenceFile ? readFileSync(evidenceFile, 'utf8') : arg('--evidence')
  const evidenceHash: Hex = evidence ? keccak256(toHex(evidence)) : zeroHash
  const decisionId = keccak256(toHex(decision))

  const rpc = arg('--rpc')
  const config = loadEnsConfig({ ...process.env, ...(rpc ? { ENS_RPC: rpc } : {}), ENS_MODE: 'enrollment' })
  const controller = config.controller!
  const pub = createPublicClient({ chain: sepolia, transport: http(config.rpc) })
  if ((await pub.getChainId()) !== config.chainId) throw new Error(`ENS RPC is not chain ${config.chainId}`)

  const [label, generation, , expiry, status] = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'membershipOf', args: [wallet] })
  const [banned, sequence] = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'banOf', args: [wallet] })
  const used = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'consumedDecisions', args: [decisionId] })
  console.log(`── ${unban ? 'unban' : 'revoke and ban'} · MANUAL POLICY DECISION`)
  console.log(`  wallet      ${wallet}`)
  console.log(`  name        ${label ? `${label}.${config.parentName}` : '—'} (${STATUS[status] ?? status}, generation ${generation}${expiry ? `, expires ${new Date(Number(expiry) * 1000).toISOString()}` : ''})`)
  console.log(`  banned      ${banned ? `yes (sequence ${sequence})` : 'no'}`)
  console.log(`  decision    ${decision} → ${decisionId}${used ? '  ALREADY USED' : ''}`)
  if (!unban) console.log(`  reason      ${reason} · evidence ${evidenceHash}`)
  if (used) throw new Error('That decision id was already used; every decision needs its own.')
  if (unban && !banned) throw new Error('This wallet is not banned.')
  if (!unban && banned) throw new Error('This wallet is already banned.')

  const activeName = STATUS[status] === 'active' || STATUS[status] === 'expired'
  if (!yes) {
    console.log(`\n  preview only — would call ${unban ? 'unban' : activeName ? `revokeAndBan(…, generation ${generation})` : 'banWallet'}. Re-run with --yes.`)
    return
  }
  const keyName = unban ? 'ENS_UNBANNER_PRIVATE_KEY' : 'ENS_REVOKER_PRIVATE_KEY'
  const raw = process.env[keyName]?.trim()
  if (!raw) throw new Error(`config.json operators.${unban ? 'ensUnbannerPrivateKey' : 'ensRevokerPrivateKey'} is required to send`)
  const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex)
  const walletClient = createWalletClient({ chain: sepolia, transport: http(config.rpc), account })
  const hash = unban
    ? await walletClient.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'unban', args: [wallet, decisionId, reason, evidenceHash] })
    : activeName
      ? await walletClient.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'revokeAndBan', args: [wallet, generation, decisionId, reason, evidenceHash] })
      : await walletClient.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'banWallet', args: [wallet, decisionId, reason, evidenceHash] })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`reverted in ${hash}`)
  const [after] = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'banOf', args: [wallet] })
  console.log(`\n  sent ${hash} · banned now: ${after ? 'yes' : 'no'}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) && !(error as { shortMessage?: string }).shortMessage ? error.message : describeEnsError(error))
  process.exitCode = 1
}
