import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  stringToBytes,
  type Account,
  type Address,
  type Hex,
  type TypedDataDomain,
  zeroAddress,
} from 'viem'
import { nonceManager } from 'viem/nonce'
import { privateKeyToAccount } from 'viem/accounts'
import {
  galileoChain,
  type Deal,
  type DealState,
  type EscrowClient,
  type EscrowIdRef,
} from '@dusk/core'
import { DEAL_STATES, DUSK_ADMISSION_GATE_ABI, DUSK_ESCROW_ABI } from './abi'
import { signerTransport, type DuskSigner } from '@dusk/signer'
import { overallTimeoutMs, retryingFetch, walkLogs } from './logs'

export type EscrowClientConfig = {
  rpc: string
  chainId: number
  address: Address
  signer?: DuskSigner
  privateKey?: Hex
  attempts?: number
  receiptTimeoutMs?: number
}

export type DuskEscrowClient = EscrowClient & { address: Address; signer: Address }

const COMMIT_AUTH_TYPE = 'CommitAuth(bytes32 jobId,address worker)'

const PROBE_OUTPUT_HASH: Hex = `0x${'00'.repeat(31)}01`

const EIP712_DOMAIN_TYPE =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
const DOMAIN_NAME = 'Dusk'
const DOMAIN_VERSION = '1'

export class EscrowDomainMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EscrowDomainMismatchError'
  }
}

export class EscrowRevertError extends Error {
  constructor(
    message: string,
    readonly revertName: string,
  ) {
    super(message)
    this.name = 'EscrowRevertError'
  }
}

export class EscrowReceiptTimeoutError extends Error {
  constructor(
    functionName: string,
    readonly hash: Hex,
    cause: unknown,
  ) {
    super(
      `${functionName} transaction ${hash} did not mine before the receipt timeout — it may ` +
        `still land. Check ${hash} on a Galileo block explorer, or with an ` +
        `eth_getTransactionReceipt call against your own RPC, before assuming it failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'EscrowReceiptTimeoutError'
  }
}

const DEFAULT_ATTEMPTS = 4

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000

function toRevertError(e: unknown, functionName: string): EscrowRevertError | undefined {
  if (!(e instanceof BaseError)) return undefined
  const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | null
  if (!reverted) return undefined
  const name = reverted.data?.errorName ?? 'Unknown'
  return new EscrowRevertError(`${functionName} reverted: ${name}`, name)
}

function toDeal(raw: readonly [Address, Address, bigint, Hex, bigint, bigint, number]): Deal {
  const [buyer, worker, amount, outputHash, commitAt, deadline, state] = raw
  return {
    buyer,
    worker,
    amount,
    outputHash,
    commitAtSec: Number(commitAt),
    deadlineSec: Number(deadline),
    state: DEAL_STATES[state] as DealState,
  }
}

export function createEscrowClient(cfg: EscrowClientConfig): DuskEscrowClient {
  const attempts = Math.max(1, cfg.attempts ?? DEFAULT_ATTEMPTS)
  const receiptTimeoutMs = cfg.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS
  const chain = galileoChain({ chainId: cfg.chainId, rpc: cfg.rpc })
  const transport = http(cfg.rpc, { fetchFn: retryingFetch(attempts), retryCount: 0, timeout: overallTimeoutMs(attempts) })
  const signer = (cfg.signer ??
    privateKeyToAccount(cfg.privateKey as Hex, { nonceManager })) as DuskSigner
  const account = signer
  const pub = createPublicClient({ chain, transport })
  let gate: Promise<Address> | undefined
  const gateAddress = (): Promise<Address> => {
    gate ??= pub.readContract({ address: cfg.address, abi: DUSK_ESCROW_ABI, functionName: 'ADMISSION' }).catch((e: unknown) => {
      if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return zeroAddress
      gate = undefined
      throw e
    })
    return gate
  }
  const wallet = createWalletClient({
    chain,
    transport: signerTransport(signer, transport),
    account: account as Account,
  })

  const ensureChain = async (): Promise<void> => {
    await signer.switchChain?.({
      chainId: cfg.chainId,
      name: '0G Galileo',
      rpcUrl: cfg.rpc,
      nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
    })
  }

  let domainPromise: Promise<TypedDataDomain> | undefined
  function cachedDomain(): Promise<TypedDataDomain> {
    domainPromise ??= (async () => {
      const domain: TypedDataDomain = {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: cfg.chainId,
        verifyingContract: cfg.address,
      }
      const [onChainSeparator, onChainTypehash] = await Promise.all([
        pub.readContract({ address: cfg.address, abi: DUSK_ESCROW_ABI, functionName: 'DOMAIN_SEPARATOR' }),
        pub.readContract({ address: cfg.address, abi: DUSK_ESCROW_ABI, functionName: 'AUTH_TYPEHASH' }),
      ])
      const localSeparator = keccak256(
        encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
          [
            keccak256(stringToBytes(EIP712_DOMAIN_TYPE)),
            keccak256(stringToBytes(DOMAIN_NAME)),
            keccak256(stringToBytes(DOMAIN_VERSION)),
            BigInt(cfg.chainId),
            cfg.address,
          ],
        ),
      )
      if (localSeparator !== onChainSeparator) {
        throw new EscrowDomainMismatchError(
          `EIP-712 domain separator disagrees with ${cfg.address} on chain ${cfg.chainId}: ` +
            `this client computes ${localSeparator}, the contract reports ` +
            `${onChainSeparator}. Every CommitAuth signed against the wrong domain is ` +
            'refused as NotAuthorised, which looks identical to naming the wrong worker.',
        )
      }
      const localTypehash = keccak256(stringToBytes(COMMIT_AUTH_TYPE))
      if (localTypehash !== onChainTypehash) {
        throw new EscrowDomainMismatchError(
          `CommitAuth typehash disagrees with ${cfg.address}: this client signs ` +
            `"${COMMIT_AUTH_TYPE}" (${localTypehash}), the contract expects ` +
            `${onChainTypehash}. The deployed contract is a different version of Dusk.`,
        )
      }
      return domain
    })()
    return domainPromise
  }

  async function write(functionName: string, args: readonly unknown[], value?: bigint): Promise<Hex> {
    await ensureChain()
    let hash: Hex | undefined
    try {
      const { request } = await pub.simulateContract({
        address: cfg.address,
        abi: DUSK_ESCROW_ABI,
        functionName,
        args,
        account,
        value,
      } as never)
      hash = await wallet.writeContract(request as never)
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs })
      if (receipt.status !== 'success') {
        throw await minedRevertError(functionName, args, value, receipt.blockNumber, hash)
      }
      return hash
    } catch (e) {
      if (e instanceof EscrowRevertError) throw e
      if (hash) throw new EscrowReceiptTimeoutError(functionName, hash, e)
      throw toRevertError(e, functionName) ?? e
    }
  }

  async function minedRevertError(
    functionName: string,
    args: readonly unknown[],
    value: bigint | undefined,
    blockNumber: bigint,
    hash: Hex,
  ): Promise<EscrowRevertError> {
    try {
      await pub.simulateContract({
        address: cfg.address,
        abi: DUSK_ESCROW_ABI,
        functionName,
        args,
        account,
        value,
        blockNumber,
      } as never)
    } catch (replayError) {
      const revertError = toRevertError(replayError, functionName)
      if (revertError) {
        return new EscrowRevertError(
          `${functionName} mined but reverted (tx ${hash}): ${revertError.revertName}`,
          revertError.revertName,
        )
      }
    }
    return new EscrowRevertError(
      `${functionName} mined but reverted (tx ${hash}): reason could not be recovered`,
      'Unknown',
    )
  }

  async function idsFromLogs(
    eventName: 'Funded' | 'Committed',
    args: Record<string, Address>,
    fromBlock = 0n,
  ): Promise<EscrowIdRef[]> {
    const logs = await walkLogs(pub, cfg.address, eventName, args, fromBlock)
    return logs.flatMap((log) => {
      const jobId = log.args?.jobId
      return jobId ? [{ escrowId: jobId, txHash: log.transactionHash, blockNumber: log.blockNumber }] : []
    })
  }

  return {
    address: cfg.address,
    signer: account.address,

    async admittedUntil(account: Address): Promise<number> {
      const address = await gateAddress()
      if (address === zeroAddress) return Number.POSITIVE_INFINITY
      if (!(await pub.readContract({ address, abi: DUSK_ADMISSION_GATE_ABI, functionName: 'isAdmitted', args: [account] }))) return 0
      try {
        const [, , validUntil] = await pub.readContract({ address, abi: DUSK_ADMISSION_GATE_ABI, functionName: 'records', args: [account] })
        return Number(validUntil)
      } catch (e) {
        if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return Number.POSITIVE_INFINITY
        throw e
      }
    },

    async admitted(account: Address): Promise<boolean> {
      const address = await gateAddress()
      if (address === zeroAddress) return true
      return pub.readContract({ address, abi: DUSK_ADMISSION_GATE_ABI, functionName: 'isAdmitted', args: [account] })
    },

    async deal(jobId: Hex): Promise<Deal> {
      const raw = await pub.readContract({
        address: cfg.address,
        abi: DUSK_ESCROW_ABI,
        functionName: 'deals',
        args: [jobId],
      })
      return toDeal(raw as never)
    },

    fundedBy: (buyer, fromBlock) => idsFromLogs('Funded', { buyer }, fromBlock),
    committedBy: (worker, fromBlock) => idsFromLogs('Committed', { worker }, fromBlock),

    async signCommitAuth(jobId: Hex, worker: Address): Promise<Hex> {
      await ensureChain()
      const domain = await cachedDomain()
      return account.signTypedData({
        domain,
        types: {
          CommitAuth: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'worker', type: 'address' },
          ],
        },
        primaryType: 'CommitAuth',
        message: { jobId, worker },
      })
    },

    fund: (jobId, deadlineSec, amountWei) => write('fund', [jobId, BigInt(deadlineSec)], amountWei),
    commit: (jobId, outputHash, buyerAuth) => write('commit', [jobId, outputHash, buyerAuth]),

    async commitRefusal(jobId, buyerAuth) {
      try {
        await pub.simulateContract({
          address: cfg.address,
          abi: DUSK_ESCROW_ABI,
          functionName: 'commit',
          args: [jobId, PROBE_OUTPUT_HASH, buyerAuth],
          account,
        } as never)
        return undefined
      } catch (e) {
        const revert = toRevertError(e, 'commit')
        if (revert) return revert.revertName
        throw e
      }
    },
    settle: (jobId) => write('settle', [jobId]),
    settleVerified: (jobId, verdict) => write('settleVerified', [jobId, verdict]),
    reject: (jobId, verdict) => write('reject', [jobId, verdict]),

    async signVerdict(jobId, outputHash, valid) {
      const domain = await cachedDomain()
      return account.signTypedData({
        domain,
        types: {
          Verdict: [
            { name: 'jobId', type: 'bytes32' },
            { name: 'outputHash', type: 'bytes32' },
            { name: 'valid', type: 'bool' },
          ],
        },
        primaryType: 'Verdict',
        message: { jobId, outputHash, valid },
      })
    },
    refund: (jobId) => write('refund', [jobId]),
  }
}
