import type { Address, Hex } from 'viem'
import type { Receipt, SwarmRef, Visibility } from '@dusk/core'
import type { PostedJob } from '@dusk/buyer'

const KEY_PREFIX = 'dusk.buy.v1'

const LEGACY_KEY = KEY_PREFIX

export function ledgerKey(address: string): string {
  return `${KEY_PREFIX}:${address.toLowerCase()}`
}

export const REFUND_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export type SavedReceipt = {
  modelServed: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  worker: Address
}

export type LedgerRow = {
  escrowId: Hex
  jobId: string
  fundTx?: Hex
  amountWei: bigint
  model: string
  maxTokens: number
  visibility: Visibility
  inputHash?: Hex
  prompt: string
  attachmentNames?: string[]
  expiresAt: number
  postedAt: number
  outputRef?: SwarmRef
  outputHash?: Hex
  outputText?: string
  receipt?: SavedReceipt
  deliveredAt?: number
  parentId?: Hex
  pieceIndex?: number
  pieceCount?: number
}

export type LedgerPatch = Partial<Omit<LedgerRow, 'escrowId'>>

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

function encodeReceipt(r: SavedReceipt): Record<string, unknown> {
  return {
    modelServed: r.modelServed,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    latencyMs: r.latencyMs,
    worker: r.worker,
  }
}

function decodeReceipt(value: unknown): SavedReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (
    typeof v['modelServed'] !== 'string' ||
    typeof v['tokensIn'] !== 'number' ||
    typeof v['tokensOut'] !== 'number' ||
    typeof v['latencyMs'] !== 'number' ||
    typeof v['worker'] !== 'string'
  ) {
    return undefined
  }
  return {
    modelServed: v['modelServed'],
    tokensIn: v['tokensIn'],
    tokensOut: v['tokensOut'],
    latencyMs: v['latencyMs'],
    worker: v['worker'] as Address,
  }
}

function encodeRow(row: LedgerRow): Record<string, unknown> {
  return {
    escrowId: row.escrowId,
    jobId: row.jobId,
    ...(row.fundTx ? { fundTx: row.fundTx } : {}),
    amountWei: `${row.amountWei}n`,
    model: row.model,
    maxTokens: row.maxTokens,
    visibility: row.visibility,
    ...(row.inputHash ? { inputHash: row.inputHash } : {}),
    prompt: row.prompt,
    ...(row.attachmentNames && row.attachmentNames.length > 0 ? { attachmentNames: row.attachmentNames } : {}),
    expiresAt: row.expiresAt,
    postedAt: row.postedAt,
    ...(row.outputRef ? { outputRef: row.outputRef } : {}),
    ...(row.outputHash ? { outputHash: row.outputHash } : {}),
    ...(row.outputText !== undefined ? { outputText: row.outputText } : {}),
    ...(row.receipt ? { receipt: encodeReceipt(row.receipt) } : {}),
    ...(row.deliveredAt !== undefined ? { deliveredAt: row.deliveredAt } : {}),
    ...(row.parentId ? { parentId: row.parentId, pieceIndex: row.pieceIndex, pieceCount: row.pieceCount } : {}),
  }
}

function decodeRow(value: unknown): LedgerRow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const amount = v['amountWei']
  if (
    typeof v['escrowId'] !== 'string' ||
    typeof v['jobId'] !== 'string' ||
    typeof v['prompt'] !== 'string' ||
    typeof v['model'] !== 'string' ||
    typeof v['maxTokens'] !== 'number' ||
    typeof v['expiresAt'] !== 'number' ||
    typeof v['postedAt'] !== 'number' ||
    typeof amount !== 'string' ||
    !/^\d+n$/.test(amount)
  ) {
    return undefined
  }
  const receipt = decodeReceipt(v['receipt'])
  const names = v['attachmentNames']
  const attachmentNames =
    Array.isArray(names) && names.length > 0 && names.every((n) => typeof n === 'string') ? (names as string[]) : undefined
  return {
    escrowId: v['escrowId'] as Hex,
    jobId: v['jobId'],
    ...(typeof v['fundTx'] === 'string' ? { fundTx: v['fundTx'] as Hex } : {}),
    amountWei: BigInt(amount.slice(0, -1)),
    model: v['model'],
    maxTokens: v['maxTokens'],
    visibility: v['visibility'] === 'private' ? 'private' : 'public',
    ...(typeof v['inputHash'] === 'string' ? { inputHash: v['inputHash'] as Hex } : {}),
    prompt: v['prompt'],
    ...(attachmentNames ? { attachmentNames } : {}),
    expiresAt: v['expiresAt'],
    postedAt: v['postedAt'],
    ...(typeof v['parentId'] === 'string' && typeof v['pieceIndex'] === 'number' && typeof v['pieceCount'] === 'number'
      ? { parentId: v['parentId'] as Hex, pieceIndex: v['pieceIndex'], pieceCount: v['pieceCount'] }
      : {}),
    ...(typeof v['outputRef'] === 'string' ? { outputRef: v['outputRef'] } : {}),
    ...(typeof v['outputHash'] === 'string' ? { outputHash: v['outputHash'] as Hex } : {}),
    ...(typeof v['outputText'] === 'string' ? { outputText: v['outputText'] } : {}),
    ...(receipt ? { receipt } : {}),
    ...(typeof v['deliveredAt'] === 'number' ? { deliveredAt: v['deliveredAt'] } : {}),
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function worthKeeping(row: LedgerRow, now: number): boolean {
  if (row.outputRef !== undefined || row.outputText !== undefined) return true
  return row.expiresAt + REFUND_GRACE_MS >= now
}

function readRaw(storage: Storage, key: string): LedgerRow[] {
  try {
    const raw = storage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(decodeRow).filter((r): r is LedgerRow => r !== undefined)
  } catch {
    return []
  }
}

function adoptLegacy(address: string, storage: Storage, mine: LedgerRow[], now: number): LedgerRow[] {
  let present = false
  try {
    present = storage.getItem(LEGACY_KEY) !== null
  } catch {
    return mine
  }
  if (!present) return mine
  const have = new Set(mine.map((r) => r.escrowId.toLowerCase()))
  const merged = [...mine, ...readRaw(storage, LEGACY_KEY).filter((r) => !have.has(r.escrowId.toLowerCase()))]
  writeAll(address, merged.filter((r) => worthKeeping(r, now)), storage)
  try {
    storage.removeItem(LEGACY_KEY)
  } catch {
  }
  return merged
}

function readAll(address: string, storage: Storage | undefined, now = Date.now()): LedgerRow[] {
  if (!storage) return []
  const mine = adoptLegacy(address, storage, readRaw(storage, ledgerKey(address)), now)
  return mine.filter((r) => worthKeeping(r, now))
}

function writeAll(address: string, rows: LedgerRow[], storage: Storage | undefined): void {
  if (!storage) return
  try {
    storage.setItem(ledgerKey(address), JSON.stringify(rows.map(encodeRow)))
  } catch {
  }
}

export function loadLedger(
  address: string,
  storage: Storage | undefined = defaultStorage(),
  now = Date.now(),
): LedgerRow[] {
  return readAll(address, storage, now).sort((a, b) => b.postedAt - a.postedAt)
}

export function saveRow(
  address: string,
  row: LedgerRow,
  storage: Storage | undefined = defaultStorage(),
  now = Date.now(),
): void {
  const rows = readAll(address, storage, now).filter((r) => !sameId(r.escrowId, row.escrowId))
  writeAll(address, [...rows, row], storage)
}

export function patchRow(
  address: string,
  escrowId: Hex,
  patch: LedgerPatch,
  storage: Storage | undefined = defaultStorage(),
  now = Date.now(),
): void {
  const rows = readAll(address, storage, now)
  const index = rows.findIndex((r) => sameId(r.escrowId, escrowId))
  if (index === -1) return
  const next = [...rows]
  next[index] = { ...rows[index]!, ...patch }
  writeAll(address, next, storage)
}

export function dropRow(
  address: string,
  escrowId: Hex,
  storage: Storage | undefined = defaultStorage(),
  now = Date.now(),
): void {
  writeAll(
    address,
    readAll(address, storage, now).filter((r) => !sameId(r.escrowId, escrowId)),
    storage,
  )
}

export function rowFromPosted(
  job: PostedJob,
  prompt: string,
  now = Date.now(),
  attachmentNames?: readonly string[],
): LedgerRow {
  return {
    escrowId: job.escrowId,
    jobId: job.id,
    ...(job.fundTx ? { fundTx: job.fundTx } : {}),
    amountWei: job.amountWei,
    model: job.model,
    maxTokens: job.maxTokens,
    visibility: job.visibility,
    inputHash: job.inputHash,
    prompt,
    ...(attachmentNames && attachmentNames.length > 0 ? { attachmentNames: [...attachmentNames] } : {}),
    expiresAt: job.expiresAt,
    postedAt: now,
    ...(job.parentId !== undefined && job.pieceIndex !== undefined && job.pieceCount !== undefined
      ? { parentId: job.parentId, pieceIndex: job.pieceIndex, pieceCount: job.pieceCount }
      : {}),
  }
}

export function inFlightRows(rows: readonly LedgerRow[], now: number): LedgerRow[] {
  return rows.filter(
    (r) => r.jobId !== '' && r.receipt === undefined && r.outputHash === undefined && r.expiresAt > now,
  )
}

export function deliveryPatch(receipt: Receipt, now = Date.now()): LedgerPatch {
  const isPrivate = (receipt.visibility ?? 'public') === 'private'
  return {
    ...(isPrivate ? {} : { outputRef: receipt.outputRef }),
    outputHash: receipt.outputHash,
    deliveredAt: now,
    receipt: {
      modelServed: receipt.modelServed,
      tokensIn: receipt.tokensIn,
      tokensOut: receipt.tokensOut,
      latencyMs: receipt.latencyMs,
      worker: receipt.worker,
    },
  }
}

export type ResumeNeeds = { prompt: string; encryptedRef?: SwarmRef }
