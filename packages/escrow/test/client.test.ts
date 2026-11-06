import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { galileoChain } from '@dusk/core'
import { localSigner, type DuskSigner, type WalletChainRequest } from '@dusk/signer'
import { createEscrowClient, EscrowReceiptTimeoutError, type DuskEscrowClient } from '../src/index'

const here = dirname(fileURLToPath(import.meta.url))
const CHAIN_ID = 31337

let RPC = ''

const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const WORKER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const OTHER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex

function resolveFoundryBin(name: string): string | undefined {
  for (const candidate of [name, join(homedir(), '.foundry', 'bin', name)]) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

const ANVIL_BIN = resolveFoundryBin('anvil')
if (!ANVIL_BIN) {
  console.warn('anvil not found on PATH or at ~/.foundry/bin — skipping packages/escrow tests')
}

function randomJobId(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex
}

async function spawnAnvil(bin: string): Promise<{ proc: ChildProcess; rpc: string }> {
  const proc = spawn(bin, ['--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      buffered = ''
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('anvil never reported a listening port'))),
      30_000,
    )
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      buffered += chunk.toString()
      const found = /Listening on 127\.0\.0\.1:(\d+)/.exec(buffered)
      if (found?.[1]) {
        const matched = Number(found[1])
        finish(() => resolve(matched))
      }
    })
    proc.once('error', (e) => finish(() => reject(e)))
    proc.once('exit', (code) =>
      finish(() => reject(new Error(`anvil exited with code ${code} before listening`))),
    )
  })
  return { proc, rpc: `http://127.0.0.1:${port}` }
}

async function rpcResult<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await res.json()) as { result: T }).result
}

async function rpcCall(method: string, params: unknown[]): Promise<void> {
  await rpcResult(method, params)
}

async function setAutomine(enabled: boolean): Promise<void> {
  await rpcCall('evm_setAutomine', [enabled])
}

async function waitForPendingTxs(count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const block = await rpcResult<{ transactions: string[] }>('eth_getBlockByNumber', [
      'pending',
      false,
    ])
    if (block.transactions.length >= count) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`the mempool never reached ${count} pending transaction(s)`)
}

async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      })
      if (res.ok) return
    } catch {
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`anvil did not come up on ${url}`)
}

function readArtifact(): { abi: Abi; bytecode: Hex } {
  const path = join(here, '..', '..', '..', 'contracts', 'out', 'DuskEscrow.sol', 'DuskEscrow.json')
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
  return { abi: parsed.abi, bytecode: parsed.bytecode.object }
}

function farDeadlineSec(): number {
  return Math.floor(Date.now() / 1000) + 3600
}


async function startProxy(failFirst: number): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let count = 0
  const server: Server = createServer((req, res) => {
    count += 1
    if (count <= failFirst) {
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        try {
          const upstream = await fetch(RPC, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.concat(chunks),
          })
          const body = Buffer.from(await upstream.arrayBuffer())
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
          })
          res.end(body)
        } catch (e) {
          res.writeHead(502)
          res.end(String(e))
        }
      })()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe.skipIf(!ANVIL_BIN)('createEscrowClient against anvil', () => {
  let anvil: ChildProcess
  let contractAddress: Address
  let buyerClient: DuskEscrowClient
  let workerClient: DuskEscrowClient
  let otherClient: DuskEscrowClient
  let rivalWallet: WalletClient<Transport, Chain, PrivateKeyAccount>
  let escrowAbi: Abi

  function auth(jobId: Hex, worker: Address): Promise<Hex> {
    return buyerClient.signCommitAuth(jobId, worker)
  }

  function reapAnvil(): void {
    anvil?.kill()
  }
  function reapAnvilAndExit(): void {
    reapAnvil()
    process.exit(1)
  }

  beforeAll(async () => {
    const spawned = await spawnAnvil(ANVIL_BIN as string)
    anvil = spawned.proc
    RPC = spawned.rpc
    process.once('exit', reapAnvil)
    process.once('SIGINT', reapAnvilAndExit)
    process.once('SIGTERM', reapAnvilAndExit)
    await waitForRpc(RPC)

    const chain = galileoChain({ chainId: CHAIN_ID, rpc: RPC })
    const deployer = privateKeyToAccount(DEPLOYER_KEY)
    const deployWallet = createWalletClient({ chain, transport: http(RPC), account: deployer })
    const deployPub = createPublicClient({ chain, transport: http(RPC) })
    const { abi, bytecode } = readArtifact()
    escrowAbi = abi

    const hash = await deployWallet.deployContract({ abi, bytecode, args: ['0x0000000000000000000000000000000000000000', 600n, deployer.address] })
    const receipt = await deployPub.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error('deployContract did not return a contract address')
    contractAddress = receipt.contractAddress

    rivalWallet = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(WORKER_KEY) })

    buyerClient = createEscrowClient({ rpc: RPC, chainId: CHAIN_ID, address: contractAddress, privateKey: DEPLOYER_KEY })
    workerClient = createEscrowClient({ rpc: RPC, chainId: CHAIN_ID, address: contractAddress, privateKey: WORKER_KEY })
    otherClient = createEscrowClient({ rpc: RPC, chainId: CHAIN_ID, address: contractAddress, privateKey: OTHER_KEY })
  }, 30_000)

  afterAll(() => {
    process.off('exit', reapAnvil)
    process.off('SIGINT', reapAnvilAndExit)
    process.off('SIGTERM', reapAnvilAndExit)
    anvil?.kill()
  })

  it(
    'funds a deal and reads it back with the state as a string',
    async () => {
      const jobId = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 8_000n)

      const deal = await buyerClient.deal(jobId)
      expect(deal.state).toBe('funded')
      expect(deal.amount).toBe(8_000n)
      expect(deal.buyer).toBe(buyerClient.signer)
    },
    20_000,
  )

  it('reports state none for a jobId nobody funded, rather than throwing', async () => {
    const deal = await buyerClient.deal(randomJobId())
    expect(deal.state).toBe('none')
  })

  it(
    'commits, waits for the challenge window, then settles to the worker',
    async () => {
      const jobId = randomJobId()
      const outputHash = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 10_000n)

      await workerClient.commit(jobId, outputHash, await auth(jobId, workerClient.signer))
      expect((await buyerClient.deal(jobId)).state).toBe('committed')

      await createPublicClient({ transport: http(RPC) }).request({ method: 'evm_increaseTime' as never, params: [601] as never })
      await createPublicClient({ transport: http(RPC) }).request({ method: 'evm_mine' as never })
      const hash = await workerClient.settle(jobId)
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect((await buyerClient.deal(jobId)).state).toBe('settled')
    },
    20_000,
  )

  it(
    'surfaces a revert by name so the loop can tell NotFunded from a real failure',
    async () => {
      const jobId = randomJobId()
      const outputHash = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 5_000n)
      await workerClient.commit(jobId, outputHash, await auth(jobId, workerClient.signer))

      const losingAuth = await auth(jobId, otherClient.signer)
      await expect(otherClient.commit(jobId, outputHash, losingAuth)).rejects.toThrow(
        expect.objectContaining({ revertName: 'NotFunded' }),
      )
    },
    20_000,
  )

  it(
    'surfaces a revert by name even when the race is lost between simulate and mining',
    async () => {
      const jobId = randomJobId()
      const outputHash = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 5_000n)

      const losingAuth = await auth(jobId, otherClient.signer)
      const rivalAuth = await auth(jobId, workerClient.signer)

      await setAutomine(false)
      try {
        const losing = otherClient.commit(jobId, outputHash, losingAuth).then(
          (hash) => ({ rejected: false as const, hash }),
          (error: Error) => ({ rejected: true as const, error }),
        )
        await waitForPendingTxs(1)

        await rivalWallet.writeContract({
          address: contractAddress,
          abi: escrowAbi,
          functionName: 'commit',
          args: [jobId, outputHash, rivalAuth],
          gas: 200_000n,
          maxFeePerGas: 500_000_000_000n,
          maxPriorityFeePerGas: 400_000_000_000n,
        })
        await waitForPendingTxs(2)
        await rpcCall('evm_mine', [])

        const deal = await buyerClient.deal(jobId)
        expect(deal.state).toBe('committed')
        expect(deal.worker).toBe(workerClient.signer)

        const outcome = await losing
        if (!outcome.rejected) throw new Error('the losing commit should not have succeeded')
        expect(outcome.error).toMatchObject({ name: 'EscrowRevertError', revertName: 'NotFunded' })
        expect(outcome.error.message).toMatch(/mined but reverted/)
      } finally {
        await setAutomine(true)
      }
    },
    20_000,
  )

  it(
    'gives up on a transaction that never mines instead of waiting forever, carrying its hash',
    async () => {
      const jobId = randomJobId()
      const outputHash = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 3_000n)

      const impatient = createEscrowClient({
        rpc: RPC,
        chainId: CHAIN_ID,
        address: contractAddress,
        privateKey: WORKER_KEY,
        receiptTimeoutMs: 1_000,
      })

      await setAutomine(false)
      try {
        const started = Date.now()
        let caught: unknown
        try {
          await impatient.commit(jobId, outputHash, await auth(jobId, impatient.signer))
          throw new Error('commit should not have resolved while automine is off')
        } catch (e) {
          caught = e
        }
        expect(Date.now() - started).toBeLessThan(15_000)

        expect(caught).toBeInstanceOf(EscrowReceiptTimeoutError)
        expect((caught as EscrowReceiptTimeoutError).name).toBe('EscrowReceiptTimeoutError')
        expect((caught as EscrowReceiptTimeoutError).hash).toMatch(/^0x[0-9a-f]{64}$/)
        expect(caught).not.toMatchObject({ revertName: expect.anything() })
      } finally {
        await setAutomine(true)
        await rpcCall('evm_mine', [])
      }
    },
    20_000,
  )

  it(
    'serializes nonces when one signer issues two writes at once',
    async () => {
      const first = randomJobId()
      const second = randomJobId()

      const results = await Promise.allSettled([
        buyerClient.fund(first, farDeadlineSec(), 1_000n),
        buyerClient.fund(second, farDeadlineSec(), 2_000n),
      ])

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect((await buyerClient.deal(first)).amount).toBe(1_000n)
      expect((await buyerClient.deal(second)).amount).toBe(2_000n)
    },
    20_000,
  )

  it(
    'refuses a zero output hash by name',
    async () => {
      const jobId = randomJobId()
      await buyerClient.fund(jobId, farDeadlineSec(), 5_000n)

      const zeroAuth = await auth(jobId, workerClient.signer)
      await expect(
        workerClient.commit(jobId, `0x${'00'.repeat(32)}` as Hex, zeroAuth),
      ).rejects.toThrow(expect.objectContaining({ revertName: 'EmptyOutputHash' }))
    },
    20_000,
  )

  describe('retry policy', () => {
    it(
      'retries a commit through a dropped connection and succeeds',
      async () => {
        const proxy = await startProxy(1)
        try {
          const flaky = createEscrowClient({
            rpc: proxy.url,
            chainId: CHAIN_ID,
            address: contractAddress,
            privateKey: WORKER_KEY,
          })
          const jobId = randomJobId()
          const outputHash = randomJobId()
          await buyerClient.fund(jobId, farDeadlineSec(), 4_000n)

          const flakyAuth = await auth(jobId, flaky.signer)
          await expect(flaky.commit(jobId, outputHash, flakyAuth)).resolves.toMatch(/^0x/)
          expect((await buyerClient.deal(jobId)).state).toBe('committed')
          expect(proxy.count()).toBeGreaterThan(1)
        } finally {
          await proxy.close()
        }
      },
      20_000,
    )

    it(
      'without retries, the same dropped connection fails the call',
      async () => {
        const proxy = await startProxy(1)
        try {
          const noRetry = createEscrowClient({
            rpc: proxy.url,
            chainId: CHAIN_ID,
            address: contractAddress,
            privateKey: WORKER_KEY,
            attempts: 1,
          })
          const jobId = randomJobId()
          const outputHash = randomJobId()
          await buyerClient.fund(jobId, farDeadlineSec(), 4_000n)

          const noRetryAuth = await auth(jobId, noRetry.signer)
          await expect(noRetry.commit(jobId, outputHash, noRetryAuth)).rejects.toThrow()
          expect(proxy.count()).toBe(1)
        } finally {
          await proxy.close()
        }
      },
      20_000,
    )

    it(
      'does not retry a revert, because a revert is an answer and not a blip',
      async () => {
        const proxy = await startProxy(0)
        try {
          const viaProxy = createEscrowClient({
            rpc: proxy.url,
            chainId: CHAIN_ID,
            address: contractAddress,
            privateKey: OTHER_KEY,
          })
          const jobId = randomJobId()
          const outputHash = randomJobId()
          await buyerClient.fund(jobId, farDeadlineSec(), 4_000n)
          await workerClient.commit(jobId, outputHash, await auth(jobId, workerClient.signer))

          const proxyAuth = await auth(jobId, viaProxy.signer)
          await expect(viaProxy.commit(jobId, outputHash, proxyAuth)).rejects.toThrow(
            expect.objectContaining({ revertName: 'NotFunded' }),
          )
          expect(proxy.count()).toBe(1)
        } finally {
          await proxy.close()
        }
      },
      20_000,
    )
  })

  describe('recovering escrow ids from the chain', () => {
    it(
      'finds every escrow id a buyer funded, and none another buyer funded',
      async () => {
        const mine = [randomJobId(), randomJobId(), randomJobId()]
        for (const id of mine) await buyerClient.fund(id, farDeadlineSec(), 1_000n)
        const theirs = randomJobId()
        await otherClient.fund(theirs, farDeadlineSec(), 1_000n)

        const found = await buyerClient.fundedBy(buyerClient.signer)
        const ids = found.map((r) => r.escrowId)

        for (const id of mine) expect(ids).toContain(id)
        expect(ids).not.toContain(theirs)
      },
      30_000,
    )

    it(
      'carries the transaction hash, so a run can be traced after the fact',
      async () => {
        const jobId = randomJobId()
        const tx = await buyerClient.fund(jobId, farDeadlineSec(), 1_000n)

        const found = await buyerClient.fundedBy(buyerClient.signer)
        expect(found.find((r) => r.escrowId === jobId)?.txHash).toBe(tx)
      },
      30_000,
    )

    it(
      'finds a committed deal whose receipt was never written — the stranded case',
      async () => {
        const jobId = randomJobId()
        await buyerClient.fund(jobId, farDeadlineSec(), 2_000n)
        const strandedHash = randomJobId()
        await workerClient.commit(jobId, strandedHash, await auth(jobId, workerClient.signer))

        const stranded = await workerClient.committedBy(workerClient.signer)
        const ids = stranded.map((r) => r.escrowId)

        expect(ids).toContain(jobId)
        expect((await workerClient.deal(jobId)).state).toBe('committed')
      },
      30_000,
    )

    it(
      'returns nothing for an address that funded nothing',
      async () => {
        const unused: Address = `0x${'5c'.repeat(20)}`
        expect(await buyerClient.fundedBy(unused)).toEqual([])
      },
      30_000,
    )
  })

  describe('moving a wallet to Galileo before it is used', () => {
    function spyClient() {
      const switched: WalletChainRequest[] = []
      const signer: DuskSigner = {
        ...localSigner(DEPLOYER_KEY),
        switchChain: async (req) => {
          switched.push(req)
        },
      }
      return {
        switched,
        client: createEscrowClient({ rpc: RPC, chainId: CHAIN_ID, address: contractAddress, signer }),
      }
    }

    it(
      'switches to Galileo before a write',
      async () => {
        const { client, switched } = spyClient()

        await client.fund(randomJobId(), farDeadlineSec(), 1_000n)

        expect(switched.map((r) => r.chainId)).toContain(CHAIN_ID)
      },
      30_000,
    )

    it(
      'switches to Galileo before signing a CommitAuth',
      async () => {
        const { client, switched } = spyClient()

        await client.signCommitAuth(randomJobId(), client.signer)

        expect(switched.map((r) => r.chainId)).toContain(CHAIN_ID)
      },
      30_000,
    )

    it(
      'names Galileo and its RPC, so a wallet that does not know the chain can add it',
      async () => {
        const { client, switched } = spyClient()

        await client.signCommitAuth(randomJobId(), client.signer)

        expect(switched[0]?.rpcUrl).toBe(RPC)
        expect(switched[0]?.name).toMatch(/galileo/i)
      },
      30_000,
    )
  })
})
