import type { Address, Hex } from 'viem'
import type { Expression } from '@arkiv-network/sdk/query'

export type Kind = 'job' | 'worker' | 'claim' | 'grant' | 'receipt' | 'verification' | 'identity_v1' | 'moderation_v1' | 'reputation_v1'

export type Verification = {
  id: string
  owner?: Address
  jobId: string
  escrowId: Hex
  worker: Address
  result: 'pass' | 'bad' | 'illegal'
  check: string
  /** Canary only: claim to delivered receipt, from Arkiv's engine-stamped blocks. */
  latencyMs?: number
}

export type JobStatus = 'open' | 'claimed' | 'delivered' | 'settled' | 'expired'
export type TrustMode = 'verified' | 'private' | 'standard'
export type Visibility = 'public' | 'private'

export type SwarmRef = string

export type CreditsBucket = '<10%' | '10-50%' | '>50%'

export interface ArkivOwned {
  creator?: Address
  creationFlags?: { readonly: boolean; permissionlessExtension: boolean; raw: number }
  owner?: Address
  createdAtBlock?: bigint
}

export interface Job extends ArkivOwned {
  id: string
  model: string
  maxPricePer1kOut: bigint
  maxTokens: number
  trustMode: TrustMode
  visibility: Visibility
  inputRef?: SwarmRef
  inputHash: Hex
  inputChars?: number
  parentId?: Hex
  pieceIndex?: number
  pieceCount?: number
  after?: string
  buyerPubkey: Hex
  escrowId: Hex
  status: JobStatus
  expiresAt: number
}

export interface WorkerAd extends ArkivOwned {
  id: string
  models: string[]
  pricePer1kOut: bigint
  creditsBucket: CreditsBucket
  trustModes: TrustMode[]
  payout: Address
}

export interface Claim extends ArkivOwned {
  id: string
  jobId: string
  workerId: string
  price: bigint
  claimedAt: number
  workerPubkey?: Hex
}

export interface Grant extends ArkivOwned {
  id: string
  jobId: string
  workerId: string
  sealedRef?: Hex
  commitAuth?: Hex
}

export interface Receipt extends ArkivOwned {
  id: string
  jobId: string
  escrowId: Hex
  worker: Address
  modelServed: string
  creditsSpent: string
  tokensIn: number
  tokensOut: number
  outputRef: SwarmRef
  visibility?: Visibility
  proofRef?: SwarmRef
  outputHash: Hex
  latencyMs: number
  trustMode: TrustMode
}

export interface ArkivStore {
  put<T>(kind: Kind, data: T, opts: { ttlSeconds: number }): Promise<string>
  query<T>(kind: Kind, filter?: Expression): Promise<T[]>
  extend(id: string, ttlSeconds: number): Promise<void>
  del(id: string): Promise<void>
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface CompletionRequest {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>
  maxTokens: number
}

export interface CompletionResult {
  text: string
  modelServed: string
  tokensIn: number
  tokensOut: number
  finishReason: string
  latencyMs: number
  teeProof?: TeeProof
}

export interface TeeProof {
  scheme: 'zg-sig-v1/e2ee-ct'
  signedText: string
  signature: Hex
  teeSigner: Address
  provider: Address
  chatId: string
  transcript: {
    request: Record<string, unknown>
    response: Record<string, unknown>
    encPub: string
    skE: string
    ephPriv: string
  }
}

export interface Balance {
  address: Address
  currency: string
  depositBalance: string
  creditBalance: string
  pendingCharge: string
  totalBalance: string
  unsettledCharge?: string
}

export interface ModelInfo {
  id: string
  inputModalities: string[]
  outputModalities: string[]
  pricing?: ModelPricing
  verifiability?: string
}

export interface ModelPricing {
  inNeuronPerToken?: bigint
  outNeuronPerToken?: bigint
  perImageNeuron?: bigint
  inUsdPerToken?: number
  outUsdPerToken?: number
  perImageUsd?: number
}

export interface OgClient {
  models(): Promise<string[]>
  catalog?(): Promise<ModelInfo[]>
  complete(req: CompletionRequest, mode: TrustMode): Promise<CompletionResult>
  balance(): Promise<Balance>
}

export interface ImageRequest {
  model: string
  prompt: string
  n: number
  size: string
}

export interface ImageSubmission {
  jobId: string
  providerAddress?: string
}

export type ImagePoll =
  | { state: 'pending' }
  | { state: 'failed'; reason: string }
  | {
      state: 'completed'
      images: Uint8Array[]
      modelServed: string
      outputImages: number
      billedUnits?: string
    }

export interface OgImageClient {
  submitImage(req: ImageRequest, mode: TrustMode): Promise<ImageSubmission>
  pollImage(sub: ImageSubmission): Promise<ImagePoll>
}

export interface SwarmStore {
  upload(data: Uint8Array, opts?: { encrypt?: boolean; contentType?: string }): Promise<SwarmRef>
  download(ref: SwarmRef): Promise<Uint8Array>
}

export type DealState = 'none' | 'funded' | 'committed' | 'settled' | 'refunded'

export interface Deal {
  buyer: Address
  worker: Address
  amount: bigint
  outputHash: Hex
  commitAtSec: number
  deadlineSec: number
  state: DealState
}

export interface EscrowIdRef {
  escrowId: Hex
  txHash: Hex
  blockNumber: bigint
}

export interface EscrowClient {
  signCommitAuth(jobId: Hex, worker: Address): Promise<Hex>
  deal(jobId: Hex): Promise<Deal>
  fundedBy(buyer: Address, fromBlock?: bigint): Promise<EscrowIdRef[]>
  committedBy(worker: Address, fromBlock?: bigint): Promise<EscrowIdRef[]>
  admitted?(account: Address): Promise<boolean>
  admittedUntil?(account: Address): Promise<number>
  fund(jobId: Hex, deadlineSec: number, amountWei: bigint): Promise<Hex>
  commit(jobId: Hex, outputHash: Hex, buyerAuth: Hex): Promise<Hex>
  commitRefusal(jobId: Hex, buyerAuth: Hex): Promise<string | undefined>
  settle(jobId: Hex): Promise<Hex>
  settleVerified(jobId: Hex, verdict: Hex): Promise<Hex>
  reject(jobId: Hex, verdict: Hex): Promise<Hex>
  signVerdict(jobId: Hex, outputHash: Hex, valid: boolean): Promise<Hex>
  refund(jobId: Hex): Promise<Hex>
}

export interface IdentityMirror extends ArkivOwned {
  id: string
  wallet: Address
  ensChainId: number
  controller: Address
  namespaceRegistry: Address
  ensName: string
  ensNamehash: Hex
  generation: number
  resolver: Address
  sourceTx: Hex
  sourceBlock: number
  sourceLogIndex: number
  schemaVersion: number
}

export interface ModerationMirror extends ArkivOwned {
  id: string
  subjectWallet: Address
  sourceChainId: number
  controller: Address
  namespaceRegistry: Address
  sequence: number
  decisionId: Hex
  action: 'ban' | 'unban'
  policyVersion: number
  reasonCode: number
  evidenceHash: Hex
  sourceTx: Hex
  sourceBlock: number
  sourceBlockHash: Hex
  sourceLogIndex: number
}

export interface ReputationMirror extends ArkivOwned {
  id: string
  wallet: Address
  ensChainId: number
  controller: Address
  identityController: Address
  namespaceRegistry: Address
  ensName: string
  ensNamehash: Hex
  generation: number
  sequence: number
  score: number
  standing: 'banned' | 'new' | 'trusted' | 'good' | 'disputed'
  resolvedJobs: number
  badAnswers: number
  illegal: number
  policyVersion: number
  policyEpoch: number
  evaluatedAt: number
  galileoBlock: number
  arkivBlock: number
  evidenceHash: Hex
  evidenceRef: Hex
  sourceContextHash: Hex
  sourceTx: Hex
  sourceBlock: number
  sourceBlockHash: Hex
  sourceLogIndex: number
}
