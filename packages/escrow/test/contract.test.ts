import { beforeAll, describe, expect, it } from 'vitest'
import { createVM, type VM } from '@ethereumjs/vm'
import { createBlock } from '@ethereumjs/block'
import { createAccount, createAddressFromString } from '@ethereumjs/util'
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,

  hexToBytes,
  bytesToHex,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { compileEscrow } from '../../../scripts/build-escrow'

const WINDOW = 600n
const AMOUNT = 8000n
const JOB = keccak256(toHex('job-1'))
const OUT = keccak256(toHex('the answer'))

const buyer = privateKeyToAccount(generatePrivateKey())
const worker = privateKeyToAccount(generatePrivateKey())
const verifier = privateKeyToAccount(generatePrivateKey())
const deployer = privateKeyToAccount(generatePrivateKey())

let abi: Abi
let bytecode: Hex
beforeAll(() => {
  ;({ abi, bytecode } = compileEscrow() as { abi: Abi; bytecode: Hex })
}, 60_000)

async function chain(window = WINDOW, verifierAddr: Address = verifier.address) {
  const vm: VM = await createVM()
  let now = 1_700_000_000n
  for (const a of [buyer, worker, verifier, deployer]) {
    await vm.stateManager.putAccount(createAddressFromString(a.address), createAccount({ balance: 10n ** 21n }))
  }
  const block = () => createBlock({ header: { timestamp: now, number: 1n } }, { common: vm.common })

  async function raw(from: Address, data: Hex, to?: Address, value = 0n) {
    const r = await vm.evm.runCall({
      caller: createAddressFromString(from),
      origin: createAddressFromString(from),
      ...(to ? { to: createAddressFromString(to) } : {}),
      data: hexToBytes(data),
      value,
      gasLimit: 10_000_000n,
      block: block(),
    })
    return r
  }
  const deploy = await raw(deployer.address, encodeDeployData({ abi, bytecode, args: ['0x0000000000000000000000000000000000000000', window, verifierAddr] }))
  const deployErr = deploy.execResult.exceptionError
    ? decodeErrorResult({ abi, data: bytesToHex(deploy.execResult.returnValue) }).errorName
    : undefined
  const address = deploy.createdAddress ? (deploy.createdAddress.toString() as Address) : undefined

  async function call(from: Address, functionName: string, args: unknown[] = [], value = 0n) {
    const r = await raw(from, encodeFunctionData({ abi, functionName, args } as never), address!, value)
    if (r.execResult.exceptionError) {
      const data = bytesToHex(r.execResult.returnValue)
      throw new Error(data === '0x' ? r.execResult.exceptionError.error : decodeErrorResult({ abi, data }).errorName)
    }
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(r.execResult.returnValue) } as never)
  }
  const balance = async (a: Address) => (await vm.stateManager.getAccount(createAddressFromString(a)))?.balance ?? 0n
  const state = async () => ((await call(buyer.address, 'deals', [JOB])) as unknown[])[6] as number
  const domain = () => ({ name: 'Dusk', version: '1', chainId: Number(vm.common.chainId()), verifyingContract: address! })

  const commitAuth = (forWorker: Address) =>
    buyer.signTypedData({
      domain: domain(),
      types: { CommitAuth: [{ name: 'jobId', type: 'bytes32' }, { name: 'worker', type: 'address' }] },
      primaryType: 'CommitAuth',
      message: { jobId: JOB, worker: forWorker },
    })
  const verdict = (valid: boolean, signer = verifier, outputHash: Hex = OUT) =>
    signer.signTypedData({
      domain: domain(),
      types: {
        Verdict: [
          { name: 'jobId', type: 'bytes32' },
          { name: 'outputHash', type: 'bytes32' },
          { name: 'valid', type: 'bool' },
        ],
      },
      primaryType: 'Verdict',
      message: { jobId: JOB, outputHash, valid },
    })

  async function fundAndCommit() {
    await call(buyer.address, 'fund', [JOB, now + 3600n], AMOUNT)
    await call(worker.address, 'commit', [JOB, OUT, await commitAuth(worker.address)])
  }
  return {
    address, deployErr, call, balance, state, verdict, commitAuth, fundAndCommit,
    advance: (s: bigint) => (now += s),
  }
}

const STATE = { Funded: 1, Committed: 2, Settled: 3, Refunded: 4 }

describe('DuskEscrow — constructor', () => {
  it('deploys with a sane window and a verifier', async () => {
    const c = await chain()
    expect(c.deployErr).toBeUndefined()
    expect(await c.call(buyer.address, 'CHALLENGE_WINDOW')).toBe(WINDOW)
    expect((await c.call(buyer.address, 'VERIFIER')) as string).toBe(verifier.address)
  })
  it.each([
    ['a zero window (L9)', 0n, verifier.address],
    ['a window over a week (L8)', 7n * 86400n + 1n, verifier.address],
    ['a zero verifier', WINDOW, '0x0000000000000000000000000000000000000000'],
  ])('refuses %s', async (_l, w, v) => {
    expect((await chain(w as bigint, v as Address)).deployErr).toBe('BadConfig')
  })
})

describe('DuskEscrow — payment waits for the challenge window', () => {
  it('can settle without a verifier service when verification was explicitly disabled', async () => {
    const c = await chain(0n, '0x0000000000000000000000000000000000000000')
    expect(c.deployErr).toBeUndefined()
    await c.fundAndCommit()
    await c.call(buyer.address, 'settle', [JOB])
    expect(await c.state()).toBe(STATE.Settled)
  })
  it('a commit does not pay at once', async () => {
    const c = await chain()
    await c.fundAndCommit()
    await expect(c.call(worker.address, 'settle', [JOB])).rejects.toThrow('ChallengeWindowOpen')
    c.advance(WINDOW)
    await expect(c.call(worker.address, 'settle', [JOB])).rejects.toThrow('ChallengeWindowOpen')
  })

  it('pays the worker once the window has passed, whoever calls', async () => {
    const c = await chain()
    await c.fundAndCommit()
    c.advance(WINDOW + 1n)
    const before = await c.balance(worker.address)
    await c.call(buyer.address, 'settle', [JOB])
    expect((await c.balance(worker.address)) - before).toBe(AMOUNT)
    expect(await c.state()).toBe(STATE.Settled)
  })
})

describe('DuskEscrow — stopping payment', () => {
  it('refunds the buyer on the verifier’s "invalid" verdict, and the worker gets nothing', async () => {
    const c = await chain()
    await c.fundAndCommit()
    const before = await c.balance(buyer.address)
    await c.call(worker.address, 'reject', [JOB, await c.verdict(false)])
    expect((await c.balance(buyer.address)) - before).toBe(AMOUNT)
    expect(await c.state()).toBe(STATE.Refunded)
    c.advance(WINDOW + 1n)
    await expect(c.call(worker.address, 'settle', [JOB])).rejects.toThrow('NotCommitted')
  })

  it('works up to the last second of the window, and not after', async () => {
    const c = await chain()
    await c.fundAndCommit()
    c.advance(WINDOW)
    await c.call(buyer.address, 'reject', [JOB, await c.verdict(false)])
    expect(await c.state()).toBe(STATE.Refunded)

    const d = await chain()
    await d.fundAndCommit()
    d.advance(WINDOW + 1n)
    await expect(d.call(buyer.address, 'reject', [JOB, await d.verdict(false)])).rejects.toThrow('ChallengeWindowClosed')
  })

  it('a buyer cannot reject on its own say-so — the old free-work hole (L5)', async () => {
    const c = await chain()
    await c.fundAndCommit()
    await expect(c.call(buyer.address, 'reject', [JOB, await c.verdict(false, buyer)])).rejects.toThrow('NotVerifier')
  })

  it('a "valid" verdict cannot be used to reject', async () => {
    const c = await chain()
    await c.fundAndCommit()
    await expect(c.call(buyer.address, 'reject', [JOB, await c.verdict(true)])).rejects.toThrow('NotVerifier')
  })

  it('a verdict about a different output cannot reject this commit', async () => {
    const c = await chain()
    await c.fundAndCommit()
    const other = await c.verdict(false, verifier, keccak256(toHex('other')))
    await expect(c.call(buyer.address, 'reject', [JOB, other])).rejects.toThrow('NotVerifier')
  })

  it('cannot reject a deal that was never committed', async () => {
    const c = await chain()
    await c.call(buyer.address, 'fund', [JOB, 1_700_003_600n], AMOUNT)
    await expect(c.call(buyer.address, 'reject', [JOB, await c.verdict(false)])).rejects.toThrow('NotCommitted')
  })
})

describe('DuskEscrow — early payment on a verified proof', () => {
  it('pays at once on the verifier’s "valid" verdict', async () => {
    const c = await chain()
    await c.fundAndCommit()
    const before = await c.balance(worker.address)
    await c.call(buyer.address, 'settleVerified', [JOB, await c.verdict(true)])
    expect((await c.balance(worker.address)) - before).toBe(AMOUNT)
    await expect(c.call(buyer.address, 'reject', [JOB, await c.verdict(false)])).rejects.toThrow('NotCommitted')
  })

  it('an "invalid" verdict or a non-verifier signature cannot release it', async () => {
    const c = await chain()
    await c.fundAndCommit()
    await expect(c.call(worker.address, 'settleVerified', [JOB, await c.verdict(false)])).rejects.toThrow('NotVerifier')
    await expect(c.call(worker.address, 'settleVerified', [JOB, await c.verdict(true, worker)])).rejects.toThrow('NotVerifier')
  })
})

describe('DuskEscrow — unchanged guarantees still hold', () => {
  it('commit still needs the buyer’s CommitAuth', async () => {
    const c = await chain()
    await c.call(buyer.address, 'fund', [JOB, 1_700_003_600n], AMOUNT)
    await expect(c.call(worker.address, 'commit', [JOB, OUT, await c.commitAuth(deployer.address)])).rejects.toThrow('NotAuthorised')
  })
  it('refund after the deadline still works for an uncommitted deal', async () => {
    const c = await chain()
    await c.call(buyer.address, 'fund', [JOB, 1_700_000_100n], AMOUNT)
    c.advance(101n)
    await c.call(buyer.address, 'refund', [JOB])
    expect(await c.state()).toBe(STATE.Refunded)
  })
})


describe('DUSK_ESCROW_ABI matches the compiled contract', () => {
  it('names every function, event and error the contract has', async () => {
    const { DUSK_ESCROW_ABI } = await import('../src/abi')
    const names = (a: readonly { type: string; name?: string }[]) =>
      a.filter((x) => x.type !== 'constructor').map((x) => `${x.type}:${x.name}`).sort()
    expect(names(DUSK_ESCROW_ABI as never)).toEqual(names(abi as never))
  })
})
