import type { Job, Receipt, SwarmStore, TeeProof } from '@dusk/core'
import { DEFAULT_IMAGE_MODELS, isImageModel } from '@dusk/core'
import { unseal } from '@dusk/crypto'
import { parseCompletion } from '@dusk/og'
import { verifyTranscript } from '@dusk/og/e2ee'
import { keccak256, recoverMessageAddress, toHex, type Address, type Hex } from 'viem'

export class ProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProofError'
  }
}

export class ProofUnreadableError extends ProofError {
  constructor(message: string) {
    super(message)
    this.name = 'ProofUnreadableError'
  }
}

export interface VerifyDeps {
  imageModels?: readonly string[]
  swarm: Pick<SwarmStore, 'download'>
  readService: (provider: Address) => Promise<{ teeSignerAddress: Address; teeSignerAcknowledged: boolean }>
  buyerKey?: Hex
}

export interface VerifiedRun {
  prompt: string
  model: string
  maxTokens: number
  output: string
  provider: Address
  teeSigner: Address
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function verifyReceiptProof(
  job: Pick<Job, 'id' | 'model' | 'maxTokens' | 'inputHash' | 'visibility'>,
  receipt: Pick<Receipt, 'proofRef' | 'outputHash' | 'visibility'>,
  deps: VerifyDeps,
): Promise<VerifiedRun> {
  if (!receipt.proofRef) throw new ProofError(`job ${job.id}: the receipt carries no TEE proof, so what ran cannot be checked`)

  let ref: string = receipt.proofRef
  if ((receipt.visibility ?? job.visibility) === 'private') {
    if (!deps.buyerKey) throw new ProofError(`job ${job.id} is private: its proof is sealed to the buyer and needs the buyer key`)
    ref = unseal(receipt.proofRef as Hex, deps.buyerKey)
  }
  let proof: TeeProof
  try {
    proof = JSON.parse(new TextDecoder().decode(await deps.swarm.download(ref))) as TeeProof
  } catch (e) {
    throw new ProofUnreadableError(`job ${job.id}: the proof could not be read from Swarm (${e instanceof Error ? e.message : String(e)})`)
  }
  if (proof.scheme !== 'zg-sig-v1/e2ee-ct') throw new ProofError(`job ${job.id}: unknown proof scheme ${String(proof.scheme)}`)

  let v: ReturnType<typeof verifyTranscript>
  try {
    v = verifyTranscript(proof.transcript as never)
  } catch (e) {
    throw new ProofError(`job ${job.id}: the transcript does not open (${e instanceof Error ? e.message : String(e)})`)
  }
  if (v.signedText !== proof.signedText) throw new ProofError(`job ${job.id}: the signed text does not bind this transcript`)

  const svc = await deps.readService(proof.provider)
  if (!svc.teeSignerAcknowledged) throw new ProofError(`job ${job.id}: provider ${proof.provider}'s TEE signer is not acknowledged on chain`)
  const recovered = await recoverMessageAddress({ message: proof.signedText, signature: proof.signature })
  if (!same(recovered, svc.teeSignerAddress)) {
    throw new ProofError(`job ${job.id}: signature recovers to ${recovered}, not the on-chain TEE signer ${svc.teeSignerAddress}`)
  }

  const msgs = v.messages as Array<{ role?: string; content?: unknown }> | undefined
  const only = msgs?.length === 1 ? msgs[0] : undefined
  if (!only || only.role !== 'user' || typeof only.content !== 'string' || keccak256(toHex(only.content)) !== job.inputHash) {
    throw new ProofError(`job ${job.id}: the prompt that ran is not the one the job committed to (inputHash ${job.inputHash})`)
  }
  if (!same(v.model, job.model)) throw new ProofError(`job ${job.id}: the model that ran is ${v.model}, the job asked for ${job.model}`)
  if (v.maxTokens !== job.maxTokens) throw new ProofError(`job ${job.id}: ran with max_tokens ${String(v.maxTokens)}, the job asked for ${job.maxTokens}`)

  const output = parseCompletion({ choices: v.choices }, job.model, 0).text
  if (keccak256(toHex(output)) !== receipt.outputHash) {
    throw new ProofError(`job ${job.id}: the enclave's output does not hash to the receipt's outputHash`)
  }

  return { prompt: only.content, model: v.model, maxTokens: v.maxTokens, output, provider: proof.provider, teeSigner: recovered }
}

export type Judgement = { verdict: 'valid' | 'invalid' | 'abstain'; reason: string }

export async function judgeCommit(
  deal: { worker: Address; outputHash: Hex; commitAtSec: number },
  receipts: ReadonlyArray<Pick<Receipt, 'proofRef' | 'outputHash' | 'visibility' | 'owner'>>,
  job: Pick<Job, 'id' | 'model' | 'maxTokens' | 'inputHash' | 'visibility' | 'trustMode'> | undefined,
  deps: VerifyDeps,
  opts: { nowSec: number; graceSec: number },
): Promise<Judgement> {
  const graceOver = opts.nowSec > deal.commitAtSec + opts.graceSec
  const mine = receipts.filter((r) => r.owner !== undefined && same(r.owner, deal.worker))
  if (mine.length === 0) {
    return graceOver
      ? { verdict: 'invalid', reason: 'the worker committed but wrote no receipt' }
      : { verdict: 'abstain', reason: 'waiting for the worker\'s receipt' }
  }
  if (!job) return { verdict: 'abstain', reason: 'the job entity has expired, so what was asked for is unknown' }
  if ((job.visibility === 'private' || mine.some((r) => r.visibility === 'private')) && !deps.buyerKey) {
    return { verdict: 'abstain', reason: 'private job: its proof is sealed to the buyer' }
  }

  let last: Judgement = { verdict: 'abstain', reason: 'no receipt checked' }
  for (const r of mine) {
    if (r.outputHash !== deal.outputHash) {
      last = { verdict: 'invalid', reason: 'the worker\'s receipt names a different output than it committed' }
      continue
    }
    // Only a TeeML provider can produce a proof, and only a job posted `private` (0G's
    // TeeML tier) is routed to one. Any other job never asked for a proof, so holding it
    // to one would refund honest work on every non-TEE model. Checked after the output
    // match above, which binds every job whatever its tier.
    if (job.trustMode !== 'private') {
      return { verdict: 'abstain', reason: `a ${job.trustMode} job did not ask for a TEE proof; it settles normally` }
    }
    if (isImageModel(job.model, deps.imageModels ?? DEFAULT_IMAGE_MODELS)) {
      return { verdict: 'abstain', reason: 'image inference has no supported text TEE transcript; normal escrow settlement remains available' }
    }
    try {
      await verifyReceiptProof(job, r, deps)
      return { verdict: 'valid', reason: 'TEE proof matches the job\'s prompt, model, budget and output' }
    } catch (e) {
      if (e instanceof ProofUnreadableError) {
        last = graceOver ? { verdict: 'invalid', reason: e.message } : { verdict: 'abstain', reason: e.message }
      } else if (e instanceof ProofError) {
        last = { verdict: 'invalid', reason: e.message }
      } else {
        return { verdict: 'abstain', reason: `the check could not run: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
  }
  return last
}
