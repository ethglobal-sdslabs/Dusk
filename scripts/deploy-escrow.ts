import 'dotenv/config'
import '@dusk/core/env'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  zeroAddress,
  type Abi,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { galileoChain, loadConfig, partyKey, type Party } from '@dusk/core'

const WORKER_GAS_TOPUP = parseEther('0.1')

const here = dirname(fileURLToPath(import.meta.url))
const artifactPath = join(here, '..', 'contracts', 'out', 'DuskEscrow.sol', 'DuskEscrow.json')

function readArtifact(): { abi: Abi; bytecode: Hex } {
  let raw: string
  try {
    raw = readFileSync(artifactPath, 'utf8')
  } catch {
    throw new Error(
      `${artifactPath} is missing — run "cd contracts && forge build" first (no network needed)`,
    )
  }
  const parsed = JSON.parse(raw) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const chain = galileoChain(config.escrow)
  const pub = createPublicClient({ chain, transport: http() })

  const force = process.argv.slice(2).includes('--force')

  if (config.escrow.address) {
    const code = await pub.getCode({ address: config.escrow.address })
    if (code && code !== '0x' && force) {
      console.warn(
        `--force: DUSK_ESCROW_ADDRESS=${config.escrow.address} has code on chain ` +
          `${config.escrow.chainId} and will be abandoned, not upgraded. Any deal still ` +
          `funded or committed there stays there — reclaim it before moving on.`,
      )
    } else if (code && code !== '0x') {
      console.log(
        `DUSK_ESCROW_ADDRESS already deployed at ${config.escrow.address} on chain ` +
          `${config.escrow.chainId} — nothing to do`,
      )
      return
    }
    console.warn(
      `DUSK_ESCROW_ADDRESS=${config.escrow.address} is set but has no code on chain ` +
        `${config.escrow.chainId} — deploying a fresh one`,
    )
  }

  const { abi, bytecode } = readArtifact()

  const verifier = config.escrow.verifier ?? zeroAddress
  const challengeWindowSec = verifier === zeroAddress ? 0n : BigInt(config.escrow.challengeWindowSec)

  const from: Party = process.argv.slice(2).includes('--from-worker') ? 'worker' : 'buyer'
  const other: Party = from === 'buyer' ? 'worker' : 'buyer'
  const deployer = privateKeyToAccount(partyKey(process.env, from))
  const counterparty = privateKeyToAccount(partyKey(process.env, other))
  const wallet = createWalletClient({ chain, transport: http(), account: deployer })

  console.log(`── deploying DuskEscrow to ${chain.name} (chain ${chain.id}) ──`)
  console.log(`  deployer (${from})${' '.repeat(Math.max(0, 8 - from.length))}: ${deployer.address}`)
  console.log(`  ${other}${' '.repeat(Math.max(0, 17 - other.length))}: ${counterparty.address}`)

  const deployerBalance = await pub.getBalance({ address: deployer.address })
  console.log(`  deployer balance: ${formatEther(deployerBalance)} 0G`)
  if (deployerBalance < WORKER_GAS_TOPUP) {
    throw new Error(
      `deployer ${deployer.address} holds only ${formatEther(deployerBalance)} 0G, which is ` +
        `less than the ${formatEther(WORKER_GAS_TOPUP)} 0G top-up alone — top up before retrying`,
    )
  }

  const otherBalance = await pub.getBalance({ address: counterparty.address })
  if (otherBalance < WORKER_GAS_TOPUP) {
    console.log(`  funding ${other} with ${formatEther(WORKER_GAS_TOPUP)} 0G for gas...`)
    const fundHash = await wallet.sendTransaction({
      to: counterparty.address,
      value: WORKER_GAS_TOPUP,
    })
    await pub.waitForTransactionReceipt({ hash: fundHash })
    console.log(`  funded: ${fundHash}`)
  } else {
    console.log(`  ${other} already has ${formatEther(otherBalance)} 0G — skipping top-up`)
  }

  const admission = process.env.DUSK_ADMISSION_ADDRESS?.trim() || '0x0000000000000000000000000000000000000000'
  if (!/^0x[0-9a-fA-F]{40}$/.test(admission)) throw new Error('DUSK_ADMISSION_ADDRESS must be an address')
  console.log(`  admission gate   : ${/^0x0{40}$/.test(admission) ? 'none' : admission}`)
  const deployHash = await wallet.deployContract({ abi, bytecode, args: [admission as Hex, challengeWindowSec, verifier] })
  const receipt = await pub.waitForTransactionReceipt({ hash: deployHash })
  const address = receipt.contractAddress
  if (!address) {
    throw new Error(`deployment tx ${deployHash} mined but produced no contract address`)
  }

  const code = await pub.getCode({ address })
  const chainId = await pub.getChainId()
  const probe = (await pub.readContract({
    address,
    abi,
    functionName: 'deals',
    args: [`0x${'00'.repeat(32)}`],
  })) as readonly unknown[]
  const stateOfUnusedId = Number(probe[6])
  const onChainWindow = await pub.readContract({ address, abi, functionName: 'CHALLENGE_WINDOW' })
  const onChainVerifier = await pub.readContract({ address, abi, functionName: 'VERIFIER' })

  console.log('── deployed ──')
  console.log(`  address            : ${address}`)
  console.log(`  chain id           : ${chainId}`)
  console.log(`  code present       : ${Boolean(code) && code !== '0x'}`)
  console.log(`  deals(0x00…) state : ${stateOfUnusedId} (0 = none, as it must be)`)
  const gate = (await pub.readContract({ address, abi, functionName: 'ADMISSION' })) as string
  if (gate.toLowerCase() !== admission.toLowerCase()) throw new Error(`ADMISSION() reads ${gate}, not ${admission}`)
  console.log(`  ADMISSION()        : ${gate}`)
  console.log(`  CHALLENGE_WINDOW   : ${String(onChainWindow)}s`)
  console.log(`  VERIFIER           : ${String(onChainVerifier)}`)
  console.log(`\nSet config.json escrow.address to ${address}, then rebuild the web app.`)
}

await main()
