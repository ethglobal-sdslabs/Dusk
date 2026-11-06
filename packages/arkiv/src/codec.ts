import { addr, bytes, key, str, u64, u256 } from '@arkiv-network/sdk/schema'
import { and, eq, gte, or, type Expression } from '@arkiv-network/sdk/query'
import type { Address, Hex } from 'viem'
import type { Kind } from '@dusk/core'
import { schemaFor, UnknownKindError } from './schemas'

export { KIND_PREFIX, kindTag, SCHEMAS, schemaFor, UnknownKindError } from './schemas'

const MAX_STRING_BYTES = 128

export class AttributeTooLongError extends Error {
  constructor(field: string, attribute: string, bytesLen: number) {
    super(
      `${field} is ${bytesLen} bytes as the Arkiv column "${attribute}", over the ` +
        `${MAX_STRING_BYTES}-byte string limit. An encrypted Swarm reference is exactly ` +
        '128 bytes, so this field has no headroom by design.',
    )
    this.name = 'AttributeTooLongError'
  }
}

type FieldSpec = {
  attr: string
  type: 'str' | 'u256' | 'u64' | 'addr' | 'key' | 'bytes' | 'json'
  optional?: boolean
}

const FIELDS: Record<Kind, Record<string, FieldSpec>> = {
  job: {
    status: { attr: 'status', type: 'str' },
    model: { attr: 'model', type: 'str' },
    maxPricePer1kOut: { attr: 'max_price_per_1k_out', type: 'u256' },
    maxTokens: { attr: 'max_tokens', type: 'u64' },
    inputHash: { attr: 'input_hash', type: 'str' },
    escrowId: { attr: 'escrow_id', type: 'str' },
    inputRef: { attr: 'input_ref', type: 'str', optional: true },
    inputChars: { attr: 'input_chars', type: 'u64', optional: true },
    parentId: { attr: 'parent_id', type: 'str', optional: true },
    pieceIndex: { attr: 'piece_index', type: 'u64', optional: true },
    pieceCount: { attr: 'piece_count', type: 'u64', optional: true },
    after: { attr: 'after', type: 'str', optional: true },
    trustMode: { attr: 'trust_mode', type: 'str' },
    visibility: { attr: 'visibility', type: 'str' },
    buyerPubkey: { attr: 'buyer_pubkey', type: 'bytes' },
    expiresAt: { attr: 'expires_at', type: 'u64' },
  },
  worker: {
    pricePer1kOut: { attr: 'price_per_1k_out', type: 'u256' },
    creditsBucket: { attr: 'credits_bucket', type: 'str' },
    payout: { attr: 'payout', type: 'addr' },
    models: { attr: 'models', type: 'json' },
    trustModes: { attr: 'trust_modes', type: 'json' },
  },
  claim: {
    jobId: { attr: 'job_id', type: 'key' },
    workerId: { attr: 'worker_id', type: 'str' },
    price: { attr: 'price', type: 'u256' },
    claimedAt: { attr: 'claimed_at', type: 'u64' },
    workerPubkey: { attr: 'worker_pubkey', type: 'bytes', optional: true },
  },
  grant: {
    jobId: { attr: 'job_id', type: 'key' },
    workerId: { attr: 'worker_id', type: 'str' },
    sealedRef: { attr: 'sealed_ref', type: 'bytes', optional: true },
    commitAuth: { attr: 'commit_auth', type: 'bytes', optional: true },
  },
  receipt: {
    jobId: { attr: 'job_id', type: 'key' },
    worker: { attr: 'worker', type: 'addr' },
    modelServed: { attr: 'model_served', type: 'str' },
    outputHash: { attr: 'output_hash', type: 'str' },
    trustMode: { attr: 'trust_mode', type: 'str' },
    escrowId: { attr: 'escrow_id', type: 'str' },
    creditsSpent: { attr: 'credits_spent', type: 'str' },
    tokensIn: { attr: 'tokens_in', type: 'u64' },
    tokensOut: { attr: 'tokens_out', type: 'u64' },
    outputRef: { attr: 'output_ref', type: 'str', optional: true },
    sealedOutputRef: { attr: 'sealed_output_ref', type: 'bytes', optional: true },
    latencyMs: { attr: 'latency_ms', type: 'u64' },
    visibility: { attr: 'visibility', type: 'str', optional: true },
    proofRef: { attr: 'proof_ref', type: 'str', optional: true },
    sealedProofRef: { attr: 'sealed_proof_ref', type: 'bytes', optional: true },
  },
  verification: {
    jobId: { attr: 'job_id', type: 'key' },
    escrowId: { attr: 'escrow_id', type: 'str' },
    worker: { attr: 'worker', type: 'addr' },
    result: { attr: 'result', type: 'str' },
    check: { attr: 'check', type: 'str' },
    latencyMs: { attr: 'latency_ms', type: 'u64', optional: true },
  },
  identity_v1: {
    wallet: { attr: 'wallet', type: 'addr' },
    ensChainId: { attr: 'ens_chain_id', type: 'u64' },
    controller: { attr: 'controller', type: 'addr' },
    namespaceRegistry: { attr: 'namespace_registry', type: 'addr' },
    ensName: { attr: 'ens_name', type: 'str' },
    ensNamehash: { attr: 'ens_namehash', type: 'str' },
    generation: { attr: 'generation', type: 'u64' },
    sourceTx: { attr: 'source_tx', type: 'str' },
    resolver: { attr: 'resolver', type: 'addr' },
    sourceBlock: { attr: 'source_block', type: 'u64' },
    sourceLogIndex: { attr: 'source_log_index', type: 'u64' },
    schemaVersion: { attr: 'schema_version', type: 'u64' },
  },
  moderation_v1: {
    subjectWallet: { attr: 'subject_wallet', type: 'addr' },
    sourceChainId: { attr: 'source_chain_id', type: 'u64' },
    controller: { attr: 'controller', type: 'addr' },
    namespaceRegistry: { attr: 'namespace_registry', type: 'addr' },
    sequence: { attr: 'sequence', type: 'u64' },
    decisionId: { attr: 'decision_id', type: 'str' },
    action: { attr: 'action', type: 'str' },
    policyVersion: { attr: 'policy_version', type: 'u64' },
    sourceTx: { attr: 'source_tx', type: 'str' },
    reasonCode: { attr: 'reason_code', type: 'u64' },
    evidenceHash: { attr: 'evidence_hash', type: 'str' },
    sourceBlock: { attr: 'source_block', type: 'u64' },
    sourceBlockHash: { attr: 'source_block_hash', type: 'str' },
    sourceLogIndex: { attr: 'source_log_index', type: 'u64' },
  },
  reputation_v1: {
    wallet: { attr: 'wallet', type: 'addr' }, ensChainId: { attr: 'ens_chain_id', type: 'u64' },
    controller: { attr: 'controller', type: 'addr' }, identityController: { attr: 'identity_controller', type: 'addr' },
    namespaceRegistry: { attr: 'namespace_registry', type: 'addr' }, ensName: { attr: 'ens_name', type: 'str' },
    ensNamehash: { attr: 'ens_namehash', type: 'str' }, generation: { attr: 'generation', type: 'u64' },
    sequence: { attr: 'sequence', type: 'u64' }, score: { attr: 'score', type: 'u64' }, standing: { attr: 'standing', type: 'str' },
    resolvedJobs: { attr: 'resolved_jobs', type: 'u64' }, badAnswers: { attr: 'bad_answers', type: 'u64' }, illegal: { attr: 'illegal', type: 'u64' },
    policyVersion: { attr: 'policy_version', type: 'u64' }, policyEpoch: { attr: 'policy_epoch', type: 'u64' }, evaluatedAt: { attr: 'evaluated_at', type: 'u64' },
    galileoBlock: { attr: 'galileo_block', type: 'u64' }, arkivBlock: { attr: 'arkiv_block', type: 'u64' },
    evidenceHash: { attr: 'evidence_hash', type: 'str' }, evidenceRef: { attr: 'evidence_ref', type: 'str' },
    sourceContextHash: { attr: 'source_context_hash', type: 'str' }, sourceTx: { attr: 'source_tx', type: 'str' },
    sourceBlock: { attr: 'source_block', type: 'u64' }, sourceBlockHash: { attr: 'source_block_hash', type: 'str' }, sourceLogIndex: { attr: 'source_log_index', type: 'u64' },
  },
}

export function fieldsFor(kind: Kind): Record<string, FieldSpec> {
  const specs = FIELDS[kind]
  if (!specs) throw new UnknownKindError(kind)
  return specs
}

export function attributeTypesFor(kind: Kind): Record<string, FieldSpec['type']> {
  const types: Record<string, FieldSpec['type']> = {}
  for (const spec of Object.values(fieldsFor(kind))) types[spec.attr] = spec.type
  return types
}

function jsonToBytes(value: unknown): Hex {
  const text = JSON.stringify(value ?? null)
  let out = '0x'
  for (const b of new TextEncoder().encode(text)) out += b.toString(16).padStart(2, '0')
  return out as Hex
}

function bytesToJson(hex: string): unknown {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  const arr = new Uint8Array(body.length / 2)
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  const text = new TextDecoder().decode(arr)
  return text.length === 0 ? undefined : JSON.parse(text)
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error('malformed array column')
  return value
}

export function toColumn(field: string, spec: FieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'str': {
      const s = String(value)
      const len = new TextEncoder().encode(s).length
      if (len > MAX_STRING_BYTES) throw new AttributeTooLongError(field, spec.attr, len)
      return str(s)
    }
    case 'u256':
      return u256(BigInt(value as string | number | bigint))
    case 'u64':
      return u64(BigInt(value as string | number | bigint))
    case 'addr':
      return addr(value as Address)
    case 'key':
      return key(value as Hex)
    case 'bytes':
      return bytes(value as Hex)
    case 'json':
      return bytes(jsonToBytes(value))
  }
}

function fromColumn(spec: FieldSpec, raw: unknown): unknown {
  const value = (raw as { value?: unknown })?.value ?? raw
  switch (spec.type) {
    case 'u256':
      return BigInt(value as string | bigint)
    case 'u64':
      return Number(value)
    case 'json':
      return stringArray(bytesToJson(String(value)))
    default:
      return value
  }
}

const RECEIPT_REF = { plain: 'outputRef', sealed: 'sealedOutputRef' } as const
/** The TEE proof's ref, split the same way and for the same reason. */
const PROOF_REF = { plain: 'proofRef', sealed: 'sealedProofRef' } as const

function receiptToStorage(record: Record<string, unknown>): Record<string, unknown> {
  const ref = record[RECEIPT_REF.plain]
  if (ref === undefined || ref === null) {
    throw new Error(
      'receipt is missing required field "outputRef". A receipt without one names a ' +
        'delivery nobody can fetch.',
    )
  }
  if (record.visibility !== 'private') return record
  const { [RECEIPT_REF.plain]: _plain, [PROOF_REF.plain]: proof, ...rest } = record
  return {
    ...rest,
    [RECEIPT_REF.sealed]: ref,
    ...(proof !== undefined && proof !== null ? { [PROOF_REF.sealed]: proof } : {}),
  }
}

export function encode(kind: Kind, data: unknown): Record<string, unknown> {
  const specs = fieldsFor(kind)
  const given = (data ?? {}) as Record<string, unknown>
  const record = kind === 'receipt' ? receiptToStorage(given) : given
  const values: Record<string, unknown> = {}

  for (const [field, spec] of Object.entries(specs)) {
    const value = record[field]
    if (value === undefined || value === null) {
      if (spec.optional) continue
      throw new Error(
        `${kind} is missing required field "${field}" (column "${spec.attr}"). An entity ` +
          'written without it reaches the chain incomplete and decodes back missing the ' +
          'field, with nothing thrown along the way.',
      )
    }
    values[spec.attr] = toColumn(field, spec, value)
  }
  return values
}

export const ENGINE_ASSIGNED: ReadonlySet<string> = new Set(['id', 'owner', 'creator', 'creationFlags', 'createdAtBlock'])

export type SchemaRow = Record<string, unknown> & {
  $key?: Hex
  $owner?: Hex
  $creator?: Hex
  $creationFlags?: { readonly: boolean; permissionlessExtension: boolean; raw: number }
  $createdAt?: bigint
}

export function decode<T>(kind: Kind, row: SchemaRow): T {
  const specs = fieldsFor(kind)
  const out: Record<string, unknown> = {}

  for (const [field, spec] of Object.entries(specs)) {
    const raw = row[spec.attr]
    if (raw === undefined || raw === null) continue
    out[field] = fromColumn(spec, raw)
  }

  if (kind === 'receipt') {
    for (const pair of [RECEIPT_REF, PROOF_REF]) {
      if (out[pair.sealed] === undefined) continue
      out[pair.plain] = out[pair.sealed]
      delete out[pair.sealed]
    }
  }

  out.id = row.$key
  if (row.$owner !== undefined) out.owner = row.$owner
  if (row.$creator !== undefined) out.creator = row.$creator
  if (row.$creationFlags !== undefined) out.creationFlags = row.$creationFlags
  if (row.$createdAt !== undefined) out.createdAtBlock = row.$createdAt

  return out as T
}

export function attrEq(kind: Kind, field: string, value: unknown): Expression {
  return attrCmp(kind, field, eq, value)
}

type CmpOp = typeof eq | typeof gte

export function attrCmp(kind: Kind, field: string, op: CmpOp, value: unknown): Expression {
  const specs = fieldsFor(kind)
  const spec = specs[field]
  if (!spec) {
    throw new Error(
      `${kind} has no field "${field}". Fields: ${Object.keys(specs).join(', ')}.`,
    )
  }
  if (spec.type === 'bytes' || spec.type === 'json') {
    throw new Error(
      `${kind}.${field} is a bytes column ("${spec.attr}"), which Arkiv stores but never ` +
        'indexes — a filter on it can never match. Filter on a hash of it held in a str ' +
        `column instead. Filterable on ${kind}: ` +
        `${Object.entries(specs).filter(([, sp]) => sp.type !== 'bytes' && sp.type !== 'json').map(([f]) => f).join(', ')}.`,
    )
  }
  return op(spec.attr, toColumn(field, spec, value) as never)
}

export function openJobsFilter(models: string[], maxPricePer1kOut: bigint): Expression {
  return and(
    attrEq('job', 'status', 'open'),
    attrCmp('job', 'maxPricePer1kOut', gte, maxPricePer1kOut),
    or(...models.map((m) => attrEq('job', 'model', m))),
  )
}
