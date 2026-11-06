import {
  DuskIdentityControllerAbi, PermissionedResolverAbi, UserRegistryAbi, commitmentOf, createEnsReader, dnsEncode, duskName, sanitizeProfileText,
  type EnsConfig, type RegistrationOp, type VerifiedIdentity,
} from '@dusk/ens'
import { createPublicClient, createWalletClient, http, isAddress, type Account, type Address, type Hex } from 'viem'
import { localSigner, signerTransport, type DuskSigner } from '@dusk/signer'
import { sepolia, mainnet } from 'viem/chains'

const PREFIX = 'dusk.ens.v1'

export function enrollDraftKey(chainId: number, parentName: string, wallet: Address): string {
  return `${PREFIX}:draft:${chainId}:${parentName}:${wallet.toLowerCase()}`
}

export function loadNameDraft(storage: Storage | undefined, key: string | null): string {
  try { const value = key ? storage?.getItem(key) : null; return typeof value === 'string' && value.length <= 32 ? value : '' } catch { return '' }
}

export function saveNameDraft(storage: Storage | undefined, key: string | null, value: string): void {
  if (!key) return
  try { if (value) storage?.setItem(key, value.slice(0, 32)); else storage?.removeItem(key) } catch { }
}

export function enrollStorageKey(chainId: number, controller: Address, wallet: Address): string {
  return `${PREFIX}:${chainId}:${controller.toLowerCase()}:${wallet.toLowerCase()}`
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

export function loadOp(storage: Storage | undefined, key: string, parentName?: string): RegistrationOp | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const op = JSON.parse(raw) as Partial<RegistrationOp> | null
    if (!op || !Number.isSafeInteger(op.chainId) || !op.chainId || op.chainId < 1 ||
        typeof op.controller !== 'string' || !isAddress(op.controller, { strict: false }) ||
        typeof op.wallet !== 'string' || !isAddress(op.wallet, { strict: false }) ||
        typeof op.label !== 'string' || typeof op.name !== 'string' ||
        typeof op.secret !== 'string' || !/^0x[0-9a-f]{64}$/i.test(op.secret) ||
        !Number.isSafeInteger(op.createdAt) || op.createdAt! < 0) return null
    if (enrollStorageKey(op.chainId, op.controller, op.wallet) !== key) return null
    const expected = duskName(op.label, parentName ?? op.name.slice(op.label.length + 1))
    if (expected.label !== op.label || expected.name !== op.name) return null
    for (const tx of [op.commitTx, op.registerTx]) if (tx !== undefined && !/^0x[0-9a-f]{64}$/i.test(tx)) return null
    for (const time of [op.committedAt, op.registeredAt]) if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) return null
    if ((op.committedAt !== undefined && !op.commitTx) || (op.registerTx && !op.commitTx) || (op.registeredAt !== undefined && !op.registerTx)) return null
    return op as RegistrationOp
  } catch {
    return null
  }
}

export function saveOp(storage: Storage | undefined, key: string, op: RegistrationOp | null): void {
  try {
    if (op) storage?.setItem(key, JSON.stringify(op))
    else storage?.removeItem(key)
  } catch {
  }
}

export function latestOnly<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<{ stale: true } | { stale: false; value: T }> {
  let seq = 0
  return async (...args) => {
    const mine = ++seq
    const value = await fn(...args)
    return mine === seq ? { stale: false, value } : { stale: true }
  }
}

export type IdentityLine = { tone: 'ok' | 'muted' | 'warn' | 'bad'; text: string }

export function identityLine(identity: VerifiedIdentity | undefined): IdentityLine {
  if (!identity) return { tone: 'muted', text: 'Checking for a Dusk name…' }
  switch (identity.status) {
    case 'active': return { tone: 'ok', text: `${identity.name} · verified on Sepolia` }
    case 'unnamed': return { tone: 'muted', text: 'This wallet has no Dusk name yet.' }
    case 'expired': return { tone: 'warn', text: `${identity.name} has expired. Renew it to keep it.` }
    case 'mismatch': return { tone: 'warn', text: `${identity.name} no longer resolves to this wallet. New work that requires a name is paused until it does.` }
    case 'banned':
    case 'revoked': return { tone: 'bad', text: 'This wallet is banned from new work. Refunds, history and earnings already owed are unaffected.' }
    default: return { tone: 'warn', text: identity.reason ?? 'Name status could not be checked. Retry later.' }
  }
}

export type EnrollClient = ReturnType<typeof createEnrollClient>

const RECEIPT_TIMEOUT_MS = 120_000

export function createEnrollClient(config: EnsConfig, key: Hex | DuskSigner) {
  if (!config.controller) throw new Error('ENS enrollment needs config.json ens.controllerAddress and a rebuilt app.')
  const controller = config.controller
  const chain = config.chainId === 1 ? mainnet : sepolia
  const account = typeof key === 'string' ? localSigner(key) : key
  const pub = createPublicClient({ chain, transport: http(config.rpc) })
  const wallet = createWalletClient({ chain, transport: signerTransport(account, http(config.rpc)), account: account as Account })
  const ensureChain = () => account.switchChain?.({ chainId: config.chainId, name: chain.name, rpcUrl: config.rpc, nativeCurrency: chain.nativeCurrency })
  const assertOperation = (op: RegistrationOp) => {
    if (op.wallet.toLowerCase() !== account.address.toLowerCase() || op.chainId !== config.chainId || op.controller.toLowerCase() !== controller.toLowerCase()) {
      throw new Error('This reservation belongs to another wallet or namespace. Reconnect its wallet to continue.')
    }
  }

  return {
    address: account.address,
    controller,
    async timing() {
      const [min, max] = await Promise.all([
        pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'MIN_COMMITMENT_AGE' }),
        pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'MAX_COMMITMENT_AGE' }),
      ])
      return { minAgeSec: Number(min), maxAgeSec: Number(max) }
    },
    async chainNowMs() {
      return Number((await pub.getBlock()).timestamp) * 1000
    },
    available: (label: string) => pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'availableTo', args: [label, account.address] }),
    registrationPaused: () => pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'registrationsPaused' }),
    async commit(op: RegistrationOp, onSent: (op: RegistrationOp) => void): Promise<RegistrationOp> {
      assertOperation(op)
      const onChain = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'makeCommitment', args: [op.label, op.wallet, op.secret] })
      const local = commitmentOf(op)
      if (onChain !== local) throw new Error('The local commitment disagrees with the controller; nothing was sent.')
      if (!op.commitTx) await ensureChain()
      const commitTx = op.commitTx ?? await wallet.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'commit', args: [local] })
      const sent = { ...op, commitTx }
      onSent(sent)
      const receipt = await pub.waitForTransactionReceipt({ hash: commitTx, timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw Object.assign(new Error('The reservation transaction reverted.'), { reverted: true })
      const block = await pub.getBlock({ blockNumber: receipt.blockNumber })
      return { ...sent, committedAt: Number(block.timestamp) * 1000 }
    },
    async register(op: RegistrationOp, onSent: (op: RegistrationOp) => void): Promise<RegistrationOp> {
      assertOperation(op)
      if (!op.registerTx) await ensureChain()
      const registerTx = op.registerTx ?? await wallet.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'register', args: [op.label, op.secret] })
      const sent = { ...op, registerTx }
      onSent(sent)
      const receipt = await pub.waitForTransactionReceipt({ hash: registerTx, timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw Object.assign(new Error('The registration transaction reverted.'), { reverted: true })
      return { ...sent, registeredAt: Date.now() }
    },
    async resolverOf(label: string): Promise<Address> {
      const registry = await pub.readContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'REGISTRY' }) as Address
      return pub.readContract({ address: registry, abi: UserRegistryAbi, functionName: 'getResolver', args: [label] })
    },
    async setDescription(name: string, text: string): Promise<{ hash: Hex; verified: boolean }> {
      const identity = await createEnsReader(config, pub).identityOf(account.address)
      if (identity.status !== 'active' || identity.name !== name) throw new Error('This wallet no longer owns that verified Dusk name. Refresh before editing its profile.')
      const resolver = await this.resolverOf(name.split('.')[0]!)
      const description = sanitizeProfileText(text, 280)
      await ensureChain()
      const hash = await wallet.writeContract({ address: resolver, abi: PermissionedResolverAbi, functionName: 'setText', args: [dnsEncode(name), 'description', description] })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Saving the description reverted.')
      const readback = config.universalResolver ? await pub.getEnsText({
        name, key: 'description', universalResolverAddress: config.universalResolver, blockNumber: receipt.blockNumber,
      }).catch(() => undefined) : undefined
      return { hash, verified: readback === description || (readback === null && description === '') }
    },
    async renew(): Promise<Hex> {
      await ensureChain()
      const hash = await wallet.writeContract({ address: controller, abi: DuskIdentityControllerAbi, functionName: 'renew' })
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw new Error('Renewing the name reverted.')
      return hash
    },
    balance: () => pub.getBalance({ address: account.address }),
  }
}
