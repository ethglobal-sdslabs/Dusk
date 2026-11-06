import { addr, bytes, defineSchema, key, str, u64, u256 } from '@arkiv-network/sdk/schema'
import type { Kind } from '@dusk/core'

export const KIND_PREFIX = 'dusk.'

export function kindTag(kind: Kind): string {
  return `${KIND_PREFIX}${kind}`
}

export const JobSchema = defineSchema(kindTag('job'), {
  status: str().indexed(),
  model: str().indexed(),
  max_price_per_1k_out: u256().indexed(),
  max_tokens: u64().indexed(),
  input_hash: str().indexed(),
  escrow_id: str().indexed(),
  input_ref: str().optional(),
  input_chars: u64().optional(),
  parent_id: str().indexed().optional(),
  piece_index: u64().optional(),
  piece_count: u64().optional(),
  after: str().optional(),
  trust_mode: str(),
  visibility: str(),
  buyer_pubkey: bytes(),
  expires_at: u64(),
})

export const WorkerSchema = defineSchema(kindTag('worker'), {
  price_per_1k_out: u256().indexed(),
  credits_bucket: str().indexed(),
  payout: addr().indexed(),
  models: bytes(),
  trust_modes: bytes(),
})

export const ClaimSchema = defineSchema(kindTag('claim'), {
  job_id: key().indexed(),
  worker_id: str().indexed(),
  price: u256().indexed(),
  claimed_at: u64().indexed(),
  worker_pubkey: bytes().optional(),
})

export const GrantSchema = defineSchema(kindTag('grant'), {
  job_id: key().indexed(),
  worker_id: str().indexed(),
  sealed_ref: bytes().optional(),
  commit_auth: bytes().optional(),
})

export const ReceiptSchema = defineSchema(kindTag('receipt'), {
  job_id: key().indexed(),
  worker: addr().indexed(),
  model_served: str().indexed(),
  output_hash: str().indexed(),
  trust_mode: str().indexed(),
  escrow_id: str().indexed(),
  credits_spent: str(),
  tokens_in: u64(),
  tokens_out: u64(),
  output_ref: str().optional(),
  sealed_output_ref: bytes().optional(),
  latency_ms: u64(),
  visibility: str().optional(),
  // The TEE proof (`@dusk/og/sealed`), stored like the output ref: a public job's bare
  // Swarm ref in `str`, a private job's ref sealed to the buyer in `bytes`. Optional, so
  // receipts without a proof — and every receipt already on chain — still match.
  proof_ref: str().optional(),
  sealed_proof_ref: bytes().optional(),
})

export const VerificationSchema = defineSchema(kindTag('verification'), {
  job_id: key().indexed(),
  escrow_id: str().indexed(),
  worker: addr().indexed(),
  result: str().indexed(),
  check: str(),
  latency_ms: u64().optional(),
})

export const IdentitySchema = defineSchema(kindTag('identity_v1'), {
  wallet: addr().indexed(),
  ens_chain_id: u64().indexed(),
  controller: addr().indexed(),
  namespace_registry: addr().indexed(),
  ens_name: str().indexed(),
  ens_namehash: str().indexed(),
  generation: u64().indexed(),
  source_tx: str().indexed(),
  resolver: addr(),
  source_block: u64(),
  source_log_index: u64(),
  schema_version: u64(),
})

export const ModerationSchema = defineSchema(kindTag('moderation_v1'), {
  subject_wallet: addr().indexed(),
  source_chain_id: u64().indexed(),
  controller: addr().indexed(),
  namespace_registry: addr().indexed(),
  sequence: u64().indexed(),
  decision_id: str().indexed(),
  action: str().indexed(),
  policy_version: u64().indexed(),
  source_tx: str().indexed(),
  reason_code: u64(),
  evidence_hash: str(),
  source_block: u64(),
  source_block_hash: str(),
  source_log_index: u64(),
})

export const ReputationSchema = defineSchema(kindTag('reputation_v1'), {
  wallet: addr().indexed(), ens_chain_id: u64().indexed(), controller: addr().indexed(),
  identity_controller: addr().indexed(), namespace_registry: addr().indexed(),
  ens_name: str().indexed(), ens_namehash: str().indexed(), generation: u64().indexed(), sequence: u64().indexed(),
  score: u64().indexed(), standing: str().indexed(), policy_version: u64().indexed(), policy_epoch: u64().indexed(),
  resolved_jobs: u64(), bad_answers: u64(), illegal: u64(), evaluated_at: u64(), galileo_block: u64(), arkiv_block: u64(),
  evidence_hash: str(), evidence_ref: str(), source_context_hash: str(), source_tx: str(),
  source_block: u64(), source_block_hash: str(), source_log_index: u64(),
  late: u64().optional(), passed: u64().optional(),
})

export const SCHEMAS = {
  job: JobSchema,
  worker: WorkerSchema,
  claim: ClaimSchema,
  grant: GrantSchema,
  receipt: ReceiptSchema,
  verification: VerificationSchema,
  identity_v1: IdentitySchema,
  moderation_v1: ModerationSchema,
  reputation_v1: ReputationSchema,
} as const

export class UnknownKindError extends Error {
  constructor(kind: string) {
    super(`unknown Dusk entity kind ${JSON.stringify(kind)}`)
    this.name = 'UnknownKindError'
  }
}

export function schemaFor(kind: Kind): (typeof SCHEMAS)[Kind] {
  const s = SCHEMAS[kind]
  if (!s) throw new UnknownKindError(kind)
  return s
}
