import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Job, Receipt, TeeProof } from '@dusk/core'
import { seal } from '@dusk/crypto'
import { aadOf, b64url, hpkeSetupSender, sealChatRequest, signedTextE2EE, x25519Public } from '@dusk/og/e2ee'
import { judgeCommit, verifyReceiptProof } from '@dusk/buyer/verify'

const PROVIDER: Address = '0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9'
const PROMPT = 'what is 2+2?'
const ANSWER = 'four'

async function genuineProof(over: { prompt?: string; model?: string; maxTokens?: number; answer?: string } = {}) {
  const encSk = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  const teeKey = generatePrivateKey()
  const tee = privateKeyToAccount(teeKey)
  const sealed = sealChatRequest(
    {
      model: over.model ?? '0GM-1.0-35B-A3B',
      max_tokens: over.maxTokens ?? 8,
      messages: [{ role: 'user', content: over.prompt ?? PROMPT }],
    },
    { encPub: x25519Public(encSk), signerAddr: tee.address },
  )
  const s = hpkeSetupSender(Buffer.from(sealed.envelope._e2ee.client_eph_pub, 'base64url'), Buffer.from('0g-pc/v1/resp'))
  const frame: Record<string, any> = {
    id: 'chatcmpl-1',
    model: '0GM-1.0-35B-A3B',
    _e2ee: { v: 1, enc: b64url(s.enc), sealed_fields: ['choices'], unbound_fields: ['model', 'x_0g_trace'], final: true },
  }
  const choices = [{ message: { content: over.answer ?? ANSWER } }]
  frame._e2ee.ciphertext = b64url(s.seal(aadOf(frame), Buffer.from(JSON.stringify({ choices }))))
  const text = signedTextE2EE(sealed.envelope, frame)
  const proof: TeeProof = {
    scheme: 'zg-sig-v1/e2ee-ct',
    signedText: text,
    signature: await tee.signMessage({ message: text }),
    teeSigner: tee.address,
    provider: PROVIDER,
    chatId: 'chat-1',
    transcript: {
      request: sealed.envelope,
      response: frame,
      encPub: b64url(x25519Public(encSk)),
      skE: b64url(sealed.skE),
      ephPriv: b64url(sealed.ephPriv),
    },
  }
  return { proof, tee: tee.address }
}

const JOB = {
  id: 'job-1',
  model: '0gm-1.0-35b-a3b',
  maxTokens: 8,
  inputHash: keccak256(toHex(PROMPT)),
  visibility: 'public',
  // A job that asked for a TEE proof: only a TeeML provider may serve it.
  trustMode: 'private',
} as unknown as Job

function world(proof: TeeProof, onChainSigner: Address, opts: { visibility?: 'private'; buyerKey?: Hex } = {}) {
  const blobs = new Map<string, Uint8Array>()
  const plainRef = 'ab'.repeat(opts.visibility === 'private' ? 64 : 32)
  blobs.set(plainRef, new TextEncoder().encode(JSON.stringify(proof)))
  const buyerKey = opts.buyerKey ?? generatePrivateKey()
  const proofRef = opts.visibility === 'private' ? seal(plainRef, privateKeyToAccount(buyerKey).publicKey) : plainRef
  const receipt = { proofRef, outputHash: keccak256(toHex(ANSWER)), visibility: opts.visibility ?? 'public' } as unknown as Receipt
  const deps = {
    swarm: { download: async (ref: string) => blobs.get(ref) ?? Promise.reject(new Error('no such ref')) },
    readService: async (p: Address) => {
      if (p !== PROVIDER) throw new Error('unknown provider')
      return { teeSignerAddress: onChainSigner, teeSignerAcknowledged: true }
    },
    buyerKey,
  }
  return { receipt, deps }
}

describe('verifyReceiptProof', () => {
  it('confirms the prompt, model, budget and output of a genuine public proof', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const v = await verifyReceiptProof(JOB, receipt, deps)
    expect(v).toMatchObject({ prompt: PROMPT, model: '0GM-1.0-35B-A3B', output: ANSWER, teeSigner: tee, provider: PROVIDER })
  })

  it('opens a private proof with the buyer key', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee, { visibility: 'private' })
    expect((await verifyReceiptProof({ ...JOB, visibility: 'private' } as Job, receipt, deps)).prompt).toBe(PROMPT)
  })

  it('rejects a different prompt than the job committed to', async () => {
    const { proof, tee } = await genuineProof({ prompt: 'something else' })
    const { receipt, deps } = world(proof, tee)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/prompt/i)
  })

  it('rejects a different model than the job asked for', async () => {
    const { proof, tee } = await genuineProof({ model: 'cheaper-model' })
    const { receipt, deps } = world(proof, tee)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/model/i)
  })

  it('rejects a different token budget', async () => {
    const { proof, tee } = await genuineProof({ maxTokens: 1 })
    const { receipt, deps } = world(proof, tee)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/max_tokens/i)
  })

  it('rejects an output that is not the one committed on the receipt', async () => {
    const { proof, tee } = await genuineProof({ answer: 'five' })
    const { receipt, deps } = world(proof, tee)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/output/i)
  })

  it('anchors the signer on chain, not on the proof’s own claim', async () => {
    const { proof } = await genuineProof()
    const { receipt, deps } = world(proof, privateKeyToAccount(generatePrivateKey()).address)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/signer/i)
  })

  it('rejects a signature over a different exchange', async () => {
    const { proof, tee } = await genuineProof()
    const other = (await genuineProof({ prompt: 'x' })).proof
    const { receipt, deps } = world({ ...proof, signature: other.signature }, tee)
    await expect(verifyReceiptProof(JOB, receipt, deps)).rejects.toThrow(/signer/i)
  })

  it('reports a receipt with no proof plainly', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    await expect(verifyReceiptProof(JOB, { ...receipt, proofRef: undefined }, deps)).rejects.toThrow(/no TEE proof/i)
  })
})

describe('judgeCommit — what the verifier bot signs', () => {
  const WORKER: Address = '0x1111111111111111111111111111111111111111'
  const deal = (over = {}) => ({ worker: WORKER, outputHash: keccak256(toHex(ANSWER)), commitAtSec: 1000, ...over })

  it('valid when the worker’s own receipt carries a proof that verifies', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const r = await judgeCommit(deal(), [{ ...receipt, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('valid')
  })

  it('invalid when the proof shows a different prompt', async () => {
    const { proof, tee } = await genuineProof({ prompt: 'not what the buyer asked' })
    const { receipt, deps } = world(proof, tee)
    const r = await judgeCommit(deal(), [{ ...receipt, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r).toMatchObject({ verdict: 'invalid', reason: expect.stringMatching(/prompt/) })
  })

  it('invalid when the worker’s receipt has no TEE proof at all', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const r = await judgeCommit(deal(), [{ ...receipt, proofRef: undefined, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('invalid')
  })

  it('does not reject an honest image delivery for lacking a text-only proof format', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const imageJob = { ...JOB, model: 'z-image-turbo' }
    const result = await judgeCommit(deal(), [{ ...receipt, proofRef: undefined, owner: WORKER }], imageJob, deps, { nowSec: 1010, graceSec: 60 })
    expect(result).toMatchObject({ verdict: 'abstain', reason: expect.stringMatching(/image inference/) })
    const mismatch = await judgeCommit(deal({ outputHash: keccak256(toHex('other')) }), [{ ...receipt, owner: WORKER }], imageJob, deps, { nowSec: 1010, graceSec: 60 })
    expect(mismatch.verdict).toBe('invalid')
  })

  it('ignores receipts written by anyone but the committed worker — a griefer cannot get honest work rejected', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const forged = { ...receipt, proofRef: undefined, owner: '0x2222222222222222222222222222222222222222' as Address }
    const r = await judgeCommit(deal(), [forged, { ...receipt, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('valid')
  })

  it('invalid when the worker’s receipt names a different output than it committed', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const r = await judgeCommit(deal({ outputHash: keccak256(toHex('x')) }), [{ ...receipt, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('invalid')
  })

  it('waits for a receipt during the grace period, then calls a missing one invalid', async () => {
    const { proof, tee } = await genuineProof()
    const { deps } = world(proof, tee)
    expect((await judgeCommit(deal(), [], JOB, deps, { nowSec: 1030, graceSec: 60 })).verdict).toBe('abstain')
    expect((await judgeCommit(deal(), [], JOB, deps, { nowSec: 1061, graceSec: 60 })).verdict).toBe('invalid')
  })

  it('abstains when it cannot see what the job asked for (job entity expired)', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const r = await judgeCommit(deal(), [{ ...receipt, owner: WORKER }], undefined, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('abstain')
  })

  it('abstains on a private job — its proof is sealed to the buyer', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee, { visibility: 'private' })
    const { buyerKey: _k, ...noKey } = deps
    const r = await judgeCommit(deal(), [{ ...receipt, owner: WORKER }], { ...JOB, visibility: 'private' } as Job, noKey, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('abstain')
  })

  it('abstains, not rejects, when the check itself cannot run (network)', async () => {
    const { proof, tee } = await genuineProof()
    const { receipt, deps } = world(proof, tee)
    const flaky = { ...deps, readService: async () => Promise.reject(new Error('fetch failed')) }
    const r = await judgeCommit(deal(), [{ ...receipt, owner: WORKER }], JOB, flaky, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('abstain')
  })
})

// A proof is only possible from a TeeML provider, so only a job that asked for one
// (`trustMode: 'private'`) is held to it. Rejecting the rest would refund every job on a
// non-TEE model, taking honest work for nothing.
describe('judgeCommit — only jobs that asked for a TEE proof are held to one', () => {
  const WORKER: Address = '0x1111111111111111111111111111111111111111'
  const deal = (over = {}) => ({ worker: WORKER, outputHash: keccak256(toHex(ANSWER)), commitAtSec: 1000, ...over })
  const setup = async () => {
    const { proof, tee } = await genuineProof()
    return world(proof, tee)
  }
  for (const trustMode of ['standard', 'verified'] as const) {
    it(`abstains on a ${trustMode} job with no proof, so it settles normally`, async () => {
      const { receipt, deps } = await setup()
      const r = await judgeCommit(deal(), [{ ...receipt, proofRef: undefined, owner: WORKER }], { ...JOB, trustMode } as Job, deps, { nowSec: 1010, graceSec: 60 })
      expect(r.verdict).toBe('abstain')
    })
  }

  it('still rejects a TEE job with no proof', async () => {
    const { receipt, deps } = await setup()
    const r = await judgeCommit(deal(), [{ ...receipt, proofRef: undefined, owner: WORKER }], JOB, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('invalid')
  })

  it('still rejects any job whose receipt names a different output than was committed', async () => {
    const { receipt, deps } = await setup()
    const r = await judgeCommit(deal({ outputHash: keccak256(toHex('other')) }), [{ ...receipt, owner: WORKER }], { ...JOB, trustMode: 'standard' } as Job, deps, { nowSec: 1010, graceSec: 60 })
    expect(r.verdict).toBe('invalid')
  })
})
