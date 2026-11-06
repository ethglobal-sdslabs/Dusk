import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isAddress, isHex, keccak256, type Address, type Hex } from 'viem'

export type ControllerDeploymentContext = {
  chainId: number
  owner: Address
  child: Address
  calldataHash: Hex
}

export type ControllerDeploymentJournal = ControllerDeploymentContext & { transactionHash: Hex }

export type ControllerJournalStore = {
  load(): ControllerDeploymentJournal | undefined
  save(value: ControllerDeploymentJournal): void
  clear(): void
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)

export function controllerJournalStore(path: string): ControllerJournalStore {
  const write = (value: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  }
  return {
    load() {
      if (!existsSync(path)) return undefined
      let value: unknown
      try { value = JSON.parse(readFileSync(path, 'utf8')) } catch {
        throw new Error('The ENS deployment journal is unreadable. Reconcile its pending transaction before retrying; no new controller will be deployed.')
      }
      if (value === null) return undefined
      const row = value as Partial<ControllerDeploymentJournal>
      if (!Number.isSafeInteger(row.chainId) || typeof row.owner !== 'string' || !isAddress(row.owner, { strict: false }) ||
          typeof row.child !== 'string' || !isAddress(row.child, { strict: false }) || !hash(row.calldataHash) || !hash(row.transactionHash)) {
        throw new Error('The ENS deployment journal is invalid. Reconcile it before retrying; no new controller will be deployed.')
      }
      return row as ControllerDeploymentJournal
    },
    save: write,
    clear: () => write(null),
  }
}

type DeploymentReceipt = { status: 'success' | 'reverted'; contractAddress?: Address | null; blockNumber: bigint }

export async function resolveControllerDeployment(args: {
  context: ControllerDeploymentContext
  data: Hex
  store: ControllerJournalStore
  send?: () => Promise<Hex>
  wait(hash: Hex): Promise<DeploymentReceipt>
  transaction(hash: Hex): Promise<{ from: Address; to: Address | null; input: Hex }>
}): Promise<{ address: Address; blockNumber: bigint; transactionHash: Hex } | undefined> {
  if (keccak256(args.data) !== args.context.calldataHash) throw new Error('Controller deployment calldata does not match its context.')
  let journal = args.store.load()
  if (journal && (journal.chainId !== args.context.chainId || !same(journal.owner, args.context.owner) ||
      !same(journal.child, args.context.child) || journal.calldataHash !== args.context.calldataHash)) {
    throw new Error('An ENS controller deployment is already recorded for different settings. Reconcile that transaction before changing the deployment configuration.')
  }
  if (!journal) {
    if (!args.send) return undefined
    const transactionHash = await args.send()
    journal = { ...args.context, transactionHash }
    args.store.save(journal)
  }
  const receipt = await args.wait(journal.transactionHash)
  const transaction = await args.transaction(journal.transactionHash)
  if (!same(transaction.from, args.context.owner) || transaction.to !== null || transaction.input.toLowerCase() !== args.data.toLowerCase()) {
    throw new Error('The journal transaction is not this owner\'s expected controller creation. Refusing to grant it any registry authority.')
  }
  if (receipt.status !== 'success') {
    args.store.clear()
    throw new Error(`Controller deployment ${journal.transactionHash} reverted. No replacement was sent; rerun to retry.`)
  }
  if (!receipt.contractAddress) throw new Error('The controller creation receipt has no deployed address. No replacement was sent.')
  return { address: receipt.contractAddress, blockNumber: receipt.blockNumber, transactionHash: journal.transactionHash }
}

export function controllerRuntimeMatches(code: Hex | undefined, artifact: {
  object: Hex
  immutableReferences: Record<string, Array<{ start: number; length: number }>>
}): boolean {
  if (!code || code === '0x' || !isHex(code) || !isHex(artifact.object) || code.length !== artifact.object.length) return false
  let actual = code.slice(2).toLowerCase()
  let expected = artifact.object.slice(2).toLowerCase()
  for (const { start, length } of Object.values(artifact.immutableReferences).flat()) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || (start + length) * 2 > actual.length) return false
    const from = start * 2
    const end = (start + length) * 2
    actual = actual.slice(0, from) + '0'.repeat(length * 2) + actual.slice(end)
    expected = expected.slice(0, from) + '0'.repeat(length * 2) + expected.slice(end)
  }
  return actual === expected
}
