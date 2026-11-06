import { generateKeyPairSync } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createVM, type VM } from '@ethereumjs/vm'
import { createBlock } from '@ethereumjs/block'
import { createAccount, createAddressFromString } from '@ethereumjs/util'
import {
  bytesToHex,
  decodeErrorResult,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { escrowDeadlineSec, type Deal, type EscrowClient, type Job, type OgClient, type Receipt } from '@dusk/core'
import { EscrowRevertError } from '@dusk/escrow'
import { DEAL_STATES } from '../../packages/escrow/src/abi'
import { aadOf, b64url, hpkeSetupReceiver, hpkeSetupSender, signedTextE2EE, x25519Public } from '@dusk/og/e2ee'
import { createSealedOgClient } from '@dusk/og/sealed'
import { judgeCommit } from '@dusk/buyer/verify'
import { compileEscrow } from '../../scripts/build-escrow'
import { claimJob, runJob } from '../src/loop'
import { fakeDeps } from './fakes'

const MODEL = '0gm-1.0-35b-a3b'
const PROMPT = 'summarise this'
const WINDOW = 600n
const PRICE = 10_000n

const buyer = privateKeyToAccount(generatePrivateKey())
const worker = privateKeyToAccount(generatePrivateKey())
const verifier = privateKeyToAccount(generatePrivateKey())

let abi: Abi
let bytecode: Hex
beforeAll(() => {
  ;({ abi, bytecode } = compileEscrow() as { abi: Abi; bytecode: Hex })
}, 60_000)

async function localChain() {
  const vm: VM = await createVM()
  let offset = 0n
  const nowSec = () => BigInt(Math.floor(Date.now() / 1000)) + offset
  for (const a of [buyer, worker, verifier]) {
    await vm.stateManager.putAccount(createAddressFromString(a.address), createAccount({ balance: 10n ** 21n }))
  }
  const run = (from: Address, data: Hex, to?: Address, value = 0n) =>
    vm.evm.runCall({
      caller: createAddressFromString(from),
      origin: createAddressFromString(from),
      ...(to ? { to: createAddressFromString(to) } : {}),
      data: hexToBytes(data),
      value,
      gasLimit: 10_000_000n,
      block: createBlock({ header: { timestamp: nowSec(), number: 1n } }, { common: vm.common }),
    })
  const deployed = await run(buyer.address, encodeDeployData({ abi, bytecode, args: ['0x0000000000000000000000000000000000000000', WINDOW, verifier.address] }))
  const address = deployed.createdAddress!.toString() as Address

  async function call(from: Address, functionName: string, args: unknown[], value = 0n): Promise<unknown> {
    const r = await run(from, encodeFunctionData({ abi, functionName, args } as never), address, value)
    if (r.execResult.exceptionError) {
      const data = bytesToHex(r.execResult.returnValue)
      const name = data === '0x' ? 'Unknown' : decodeErrorResult({ abi, data }).errorName
      throw new EscrowRevertError(`${functionName} reverted: ${name}`, name)
    }
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) } as never)
  }
  const domain = () => ({ name: 'Dusk', version: '1', chainId: Number(vm.common.chainId()), verifyingContract: address })
  const deal = async (jobId: Hex): Promise<Deal> => {
    const [b, w, amount, outputHash, commitAt, deadline, state] = (await call(buyer.address, 'deals', [jobId])) as [
      Address, Address, bigint, Hex, bigint, bigint, number,
    ]
    return { buyer: b, worker: w, amount, outputHash, commitAtSec: Number(commitAt), deadlineSec: Number(deadline), state: DEAL_STATES[state]! }
  }

  function client(acct: PrivateKeyAccount): EscrowClient & { signer: Address } {
    const tx = async (fn: string, args: unknown[], value = 0n) => {
      await call(acct.address, fn, args, value)
      return `0x${'ab'.repeat(32)}` as Hex
    }
    return {
      signer: acct.address,
      deal,
      fundedBy: async () => [],
      committedBy: async () => [],
      fund: (jobId, deadlineSec, amountWei) => tx('fund', [jobId, BigInt(deadlineSec)], amountWei),
      commit: (jobId, outputHash, auth) => tx('commit', [jobId, outputHash, auth]),
      settle: (jobId) => tx('settle', [jobId]),
      settleVerified: (jobId, v) => tx('settleVerified', [jobId, v]),
      reject: (jobId, v) => tx('reject', [jobId, v]),
      refund: (jobId) => tx('refund', [jobId]),
      async commitRefusal(jobId, auth) {
        await vm.stateManager.checkpoint()
        try {
          await call(acct.address, 'commit', [jobId, `0x${'00'.repeat(31)}01`, auth])
          return undefined
        } catch (e) {
          return e instanceof EscrowRevertError ? e.revertName : String(e)
        } finally {
          await vm.stateManager.revert()
        }
      },
      signCommitAuth: (jobId, w) =>
        acct.signTypedData({
          domain: domain(),
          types: { CommitAuth: [{ name: 'jobId', type: 'bytes32' }, { name: 'worker', type: 'address' }] },
          primaryType: 'CommitAuth',
          message: { jobId, worker: w },
        }),
      signVerdict: (jobId, outputHash, valid) =>
        acct.signTypedData({
          domain: domain(),
          types: { Verdict: [{ name: 'jobId', type: 'bytes32' }, { name: 'outputHash', type: 'bytes32' }, { name: 'valid', type: 'bool' }] },
          primaryType: 'Verdict',
          message: { jobId, outputHash, valid },
        }),
    }
  }
  const balance = async (a: Address) => (await vm.stateManager.getAccount(createAddressFromString(a)))?.balance ?? 0n
  return { client, balance, deal, advance: (s: bigint) => (offset += s) }
}

function simulatedZeroG() {
  const encSk = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const tee = privateKeyToAccount(generatePrivateKey())
  const PROVIDER: Address = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
  const sigs = new Map<string, { text: string; signature: Hex }>()
  let n = 0
  const json = (b: unknown, h: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', ...h } })

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/v1/routing/preview')) {
      const { model } = JSON.parse(String(init!.body))
      return json({ providers: [{ address: PROVIDER, canonical_id: model, model_id: String(model).toUpperCase() }] })
    }
    if (url.endsWith('/v1/e2ee/pubkey')) return json({ v: 1, kem_id: '0x0020', enc_pub: b64url(x25519Public(encSk)), signer_address: tee.address })
    if (url.endsWith('/v1/chat/completions')) {
      const env = JSON.parse(String(init!.body))
      const pt = hpkeSetupReceiver(encSk, Buffer.from(env._e2ee.enc, 'base64url'), Buffer.from('0g-pc/v1/seal')).open(
        aadOf(env),
        Buffer.from(env._e2ee.ciphertext, 'base64url'),
      )
      const prompt = JSON.parse(Buffer.from(pt).toString()).messages[0].content as string
      const s = hpkeSetupSender(Buffer.from(env._e2ee.client_eph_pub, 'base64url'), Buffer.from('0g-pc/v1/resp'))
      const frame: Record<string, any> = {
        id: `chatcmpl-${++n}`,
        model: env.model,
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        _e2ee: { v: 1, enc: b64url(s.enc), sealed_fields: ['choices'], unbound_fields: ['model', 'x_0g_trace'], final: true },
      }
      const choices = [{ finish_reason: 'stop', message: { content: `[${env.model}] answer to: ${prompt}` } }]
      frame._e2ee.ciphertext = b64url(s.seal(aadOf(frame), Buffer.from(JSON.stringify({ choices }))))
      const text = signedTextE2EE(env, frame)
      sigs.set(`chat-${n}`, { text, signature: await tee.signMessage({ message: text }) })
      return json(frame, { 'zg-res-key': `chat-${n}` })
    }
    const m = url.match(/\/v1\/proxy\/signature\/([^?]+)/)
    if (m) return json(sigs.get(decodeURIComponent(m[1]!)))
    return new Response('{}', { status: 404 })
  }
  const service = {
    url: 'https://provider.test',
    model: MODEL.toUpperCase(),
    verifiability: 'TeeML',
    additionalInfo: '{"TargetSeparated":false}',
    teeSignerAddress: tee.address,
    teeSignerAcknowledged: true,
  }
  const readService = async () => service
  const og = createSealedOgClient({
    baseUrl: 'https://gateway.test',
    inferKey: 'sk-local-test-key-0000',
    routerUrl: 'https://router.test',
    readService,
    fetch: fetchImpl as typeof fetch,
    signatureRetryMs: 1,
  })
  return { og, readService }
}

type Cheat = 'none' | 'prompt' | 'model' | 'no-proof'

async function scenario(cheat: Cheat) {
  const chain = await localChain()
  const zg = simulatedZeroG()
  const workerEscrow = chain.client(worker)
  const buyerEscrow = chain.client(buyer)
  const verifierEscrow = chain.client(verifier)

  const honest = zg.og
  const og: OgClient =
    cheat === 'prompt'
      ? { ...honest, complete: (req, mode) => honest.complete({ ...req, messages: [{ role: 'user', content: 'something cheaper' }] }, mode) }
      : cheat === 'model'
        ? {
            ...honest,
            complete: async (req, mode) => ({ ...(await honest.complete({ ...req, model: 'cheap-model' }, mode)), modelServed: req.model }),
          }
        : cheat === 'no-proof'
          ? { ...honest, complete: async (req, mode) => { const { teeProof: _p, ...r } = await honest.complete(req, mode); return r } }
          : honest

  const deps = { ...fakeDeps({ escrow: workerEscrow as never, now: () => Date.now(), pricePer1kOut: 1n }), og }

  const inputRef = await deps.swarm.upload(new TextEncoder().encode(PROMPT))
  const escrowId = keccak256(toHex(`job-${cheat}-${Math.random()}`))
  const expiresAt = Date.now() + 600_000
  const jobData = {
    model: MODEL, maxPricePer1kOut: 1000n, maxTokens: 16, trustMode: 'private', visibility: 'public',
    inputRef, inputHash: keccak256(toHex(PROMPT)), buyerPubkey: `0x${'22'.repeat(33)}`, escrowId, status: 'open', expiresAt,
  }
  const id = await deps.arkiv.putAs(buyer.address, 'job', jobData, { ttlSeconds: 600 })
  const job = { ...jobData, id, owner: buyer.address } as unknown as Job
  await buyerEscrow.fund(escrowId, escrowDeadlineSec(expiresAt), PRICE)

  const claim = (await claimJob(deps, job))!
  expect(claim, 'worker should claim a funded job').toBeTruthy()
  await deps.arkiv.putAs(buyer.address, 'grant', {
    jobId: job.id, workerId: deps.workerId, commitAuth: await buyerEscrow.signCommitAuth(escrowId, worker.address),
  }, { ttlSeconds: 300 })
  const receipt = await runJob(deps, job, claim)
  expect((await chain.deal(escrowId)).state).toBe('committed')

  const deal = await chain.deal(escrowId)
  const receipts = deps.arkiv.all<Receipt>('receipt').map((r) => ({ ...r, owner: worker.address }))
  const j = await judgeCommit(deal, receipts, job, { swarm: deps.swarm, readService: zg.readService as never }, {
    nowSec: deal.commitAtSec + 1, graceSec: 300,
  })
  const [buyerBefore, workerBefore] = [await chain.balance(buyer.address), await chain.balance(worker.address)]
  if (j.verdict === 'invalid') await verifierEscrow.reject(escrowId, await verifierEscrow.signVerdict(escrowId, deal.outputHash, false))
  if (j.verdict === 'valid') await verifierEscrow.settleVerified(escrowId, await verifierEscrow.signVerdict(escrowId, deal.outputHash, true))

  chain.advance(WINDOW + 1n)
  const lateSettle = await workerEscrow.settle(escrowId).then(() => 'paid', (e: EscrowRevertError) => e.revertName)

  return {
    verdict: j.verdict,
    reason: j.reason,
    state: (await chain.deal(escrowId)).state,
    buyerGot: (await chain.balance(buyer.address)) - buyerBefore,
    workerGot: (await chain.balance(worker.address)) - workerBefore,
    lateSettle,
    receipt,
  }
}

describe('local end to end — prompt and model verification stops payment', () => {
  it('honest worker: proof verifies, worker is paid at once', async () => {
    const r = await scenario('none')
    expect(r.verdict).toBe('valid')
    expect(r.state).toBe('settled')
    expect(r.workerGot).toBe(PRICE)
    expect(r.buyerGot).toBe(0n)
    expect(r.receipt.proofRef).toBeDefined()
  }, 30_000)

  it('worker swaps the prompt: rejected, buyer refunded, worker gets nothing', async () => {
    const r = await scenario('prompt')
    expect(r).toMatchObject({ verdict: 'invalid', state: 'refunded', buyerGot: PRICE, workerGot: 0n, lateSettle: 'NotCommitted' })
    expect(r.reason).toMatch(/prompt/)
  }, 30_000)

  it('worker swaps the model (and lies about it): rejected, buyer refunded', async () => {
    const r = await scenario('model')
    expect(r).toMatchObject({ verdict: 'invalid', state: 'refunded', buyerGot: PRICE, workerGot: 0n, lateSettle: 'NotCommitted' })
    expect(r.reason).toMatch(/model/)
  }, 30_000)

  it('worker skips the TEE proof: rejected, buyer refunded', async () => {
    const r = await scenario('no-proof')
    expect(r).toMatchObject({ verdict: 'invalid', state: 'refunded', buyerGot: PRICE, workerGot: 0n })
    expect(r.reason).toMatch(/no TEE proof/)
  }, 30_000)
})
