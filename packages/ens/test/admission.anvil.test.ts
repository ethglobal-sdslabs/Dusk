import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Abi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { galileoChain } from '@dusk/core'
import { createEscrowClient, EscrowRevertError } from '@dusk/escrow'
import { DuskAdmissionAbi, orderSignatures, signStatus, type AdmissionStatus } from '../src'

const CHAIN_ID = 31337
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const WORKER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const ATTESTER_A = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const ATTESTER_B = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex
const CONTROLLER = '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' as Address

function foundryBin(name: string): string | undefined {
  for (const candidate of [name, join(homedir(), '.foundry', 'bin', name)]) {
    try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return candidate } catch { }
  }
  return undefined
}
const ANVIL = foundryBin('anvil')

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const parsed = JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object }
}

describe.skipIf(!ANVIL)('DuskAdmission + gated DuskEscrow against anvil', () => {
  let anvil: ChildProcess
  let rpc = ''
  let admission: Address
  let escrow: Address

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ['--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => reject(new Error('anvil never listened')), 30_000)
      anvil.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString()
        const found = /Listening on 127\.0\.0\.1:(\d+)/.exec(buffered)
        if (found) { clearTimeout(timer); resolve(Number(found[1])) }
      })
    })
    rpc = `http://127.0.0.1:${port}`
    process.once('exit', () => anvil.kill())
    const chain = galileoChain({ chainId: CHAIN_ID, rpc })
    const pub = createPublicClient({ chain, transport: http(rpc) })
    const wallet = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(DEPLOYER_KEY) })
    const deploy = async (name: string, args: unknown[]) => {
      const { abi, bytecode } = artifact(name)
      const hash = await wallet.deployContract({ abi, bytecode, args })
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!
    }
    const attesters = [privateKeyToAccount(ATTESTER_A).address, privateKeyToAccount(ATTESTER_B).address]
    admission = await deploy('DuskAdmission', [11155111n, CONTROLLER, 86_400n, privateKeyToAccount(DEPLOYER_KEY).address, attesters, 2n])
    escrow = await deploy('DuskEscrow', [admission, 600n, privateKeyToAccount(DEPLOYER_KEY).address])
  }, 60_000)

  afterAll(() => anvil?.kill())

  async function submit(status: AdmissionStatus) {
    const chain = galileoChain({ chainId: CHAIN_ID, rpc })
    const sigs = await Promise.all([ATTESTER_B, ATTESTER_A].map((k) => signStatus(privateKeyToAccount(k), CHAIN_ID, admission, status)))
    const wallet = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(WORKER_KEY) })
    const pub = createPublicClient({ chain, transport: http(rpc) })
    const hash = await wallet.writeContract({ address: admission, abi: DuskAdmissionAbi, functionName: 'submit', args: [status, orderSignatures(sigs)] })
    return pub.waitForTransactionReceipt({ hash })
  }

  it('a TS-signed quorum status is accepted by the contract and opens the escrow gate', async () => {
    const worker = createEscrowClient({ rpc, chainId: CHAIN_ID, address: escrow, privateKey: WORKER_KEY })
    const wallet = privateKeyToAccount(WORKER_KEY).address
    expect(await worker.admitted!(wallet)).toBe(false)
    const now = BigInt(Math.floor(Date.now() / 1000))
    const receipt = await submit({ sourceChainId: 11155111n, controller: CONTROLLER, wallet, admitted: true, sourceBlock: 12_000_000n, validUntil: now + 3_600n, epoch: 1 })
    expect(receipt.status).toBe('success')
    expect(await worker.admitted!(wallet)).toBe(true)
    expect(await worker.admittedUntil!(wallet)).toBe(Number(now + 3_600n))
    expect(await worker.admittedUntil!(CONTROLLER)).toBe(0)
  })

  it('an unadmitted buyer is refused at fund, and the client names the revert', async () => {
    const buyer = createEscrowClient({ rpc, chainId: CHAIN_ID, address: escrow, privateKey: DEPLOYER_KEY })
    const error = await buyer.fund(keccak256(toHex('job-1')), Math.floor(Date.now() / 1000) + 3_600, 1_000n).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EscrowRevertError)
    expect((error as EscrowRevertError).revertName).toBe('NotAdmitted')
  })

  it('a client against an ungated escrow reports everyone admitted', async () => {
    const chain = galileoChain({ chainId: CHAIN_ID, rpc })
    const pub = createPublicClient({ chain, transport: http(rpc) })
    const wallet = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(DEPLOYER_KEY) })
    const { abi, bytecode } = artifact('DuskEscrow')
    const hash = await wallet.deployContract({ abi, bytecode, args: ['0x0000000000000000000000000000000000000000', 600n, privateKeyToAccount(DEPLOYER_KEY).address] })
    const open = (await pub.waitForTransactionReceipt({ hash })).contractAddress!
    expect(await createEscrowClient({ rpc, chainId: CHAIN_ID, address: open, privateKey: WORKER_KEY }).admitted!(CONTROLLER)).toBe(true)
  })

  it('a client against a pre-gate escrow (no ADMISSION function) reports no gate', async () => {
    const legacy = createEscrowClient({ rpc, chainId: CHAIN_ID, address: admission, privateKey: WORKER_KEY })
    expect(await legacy.admitted!(CONTROLLER)).toBe(true)
    expect(await legacy.admittedUntil!(CONTROLLER)).toBe(Number.POSITIVE_INFINITY)
  })

  it('an unreachable chain is an error, never an open gate', async () => {
    const dead = createEscrowClient({ rpc: 'http://127.0.0.1:1', chainId: CHAIN_ID, address: escrow, privateKey: WORKER_KEY })
    await expect(dead.admitted!(CONTROLLER)).rejects.toThrow()
  })
})
