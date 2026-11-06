import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  b64url,
  frameBindingHash,
  hpkeSetupReceiver,
  hpkeSetupSender,
  jcs,
  openChatResponse,
  sealChatRequest,
  signedTextE2EE,
  verifyTranscript,
  x25519Public,
} from '../src/e2ee'

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex')

describe('HPKE base mode — RFC 9180 §A.2.1', () => {
  const info = hex('4f6465206f6e2061204772656369616e2055726e')
  const skEm = hex('f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600')
  const pkRm = hex('4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a')
  const skRm = hex('8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb')
  const pt = hex('4265617574792069732074727574682c20747275746820626561757479')

  it('derives the published enc, key and base_nonce', () => {
    const s = hpkeSetupSender(pkRm, info, skEm)
    expect(Buffer.from(s.enc).toString('hex')).toBe('1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a')
    expect(Buffer.from(s.key).toString('hex')).toBe('ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91')
    expect(Buffer.from(s.baseNonce).toString('hex')).toBe('5c4d98150661b848853b547f')
  })

  it('seals sequence 0 and 1 to the published ciphertexts', () => {
    const s = hpkeSetupSender(pkRm, info, skEm)
    expect(Buffer.from(s.seal(hex('436f756e742d30'), pt)).toString('hex')).toBe(
      '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
    )
    expect(Buffer.from(s.seal(hex('436f756e742d31'), pt)).toString('hex')).toBe(
      '6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c',
    )
  })

  it('opens what it sealed, and refuses a tampered AAD', () => {
    const s = hpkeSetupSender(pkRm, info, skEm)
    const ct = s.seal(hex('436f756e742d30'), pt)
    expect(Buffer.from(hpkeSetupReceiver(skRm, s.enc, info).open(hex('436f756e742d30'), ct))).toEqual(pt)
    expect(() => hpkeSetupReceiver(skRm, s.enc, info).open(hex('436f756e742d31'), ct)).toThrow()
  })
})

describe('§8 binding — 0g-pc-e2ee proof/kat_test.go', () => {
  const katReqEnv = `{"model":"gpt-4o","_e2ee":{"v":1,"kem_id":"X25519","key_id":"AAAAAAAAAAA","client_eph_pub":"Y2xpZW50ZXBo","enc":"ZW5jYXBz","sealed_fields":["messages"],"ciphertext":"AAECAwQF"}}`
  const katRespEnv = `{"model":"gpt-4o","usage":{"total_tokens":3},"_e2ee":{"v":1,"enc":"cmVzcGVuYw","sealed_fields":["choices"],"unbound_fields":["model","x_0g_trace"],"final":true,"ciphertext":"BgcICQoL"}}`
  const katReqH = '7142bf93edca74323dd450689f4e087fea152d0b811ed5c89ad3c7668f349b8e'
  const katRespH = 'b45f993cafa582df20c1ebb03ce421cccd00f54aa2664ac6658a98f26ec55ff7'

  it('matches the request and response binding hashes', () => {
    expect(frameBindingHash(JSON.parse(katReqEnv))).toBe(katReqH)
    expect(frameBindingHash(JSON.parse(katRespEnv))).toBe(katRespH)
  })

  it('matches the non-stream signed text', () => {
    expect(signedTextE2EE(JSON.parse(katReqEnv), JSON.parse(katRespEnv))).toBe(
      `zg-sig-v1/e2ee-ct:${katReqH}:${katRespH}`,
    )
  })

  it('JCS sorts keys at every depth and keeps array order', () => {
    expect(jcs({ b: 1, a: [{ d: 'x', c: true }], c: null })).toBe('{"a":[{"c":true,"d":"x"}],"b":1,"c":null}')
  })
})

function enclaveKeys() {
  const { privateKey } = generateKeyPairSync('x25519')
  const sk = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)
  return { sk, pk: x25519Public(sk) }
}

const REQUEST = { model: '0gm-1.0-35b-a3b', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
const SIGNER = '0x0F40b5CA39F7cdD98c67e0E159A24315dBF8F77c'

function enclaveRespond(reqEnv: any, choices: unknown, model = REQUEST.model) {
  const ephPub = Buffer.from(reqEnv._e2ee.client_eph_pub, 'base64url')
  const s = hpkeSetupSender(ephPub, Buffer.from('0g-pc/v1/resp'))
  const frame: any = {
    id: 'chatcmpl-1',
    model,
    usage: { total_tokens: 3 },
    _e2ee: { v: 1, enc: b64url(s.enc), sealed_fields: ['choices'], unbound_fields: ['model', 'x_0g_trace'], final: true },
  }
  const { ciphertext: _c, ...meta } = frame._e2ee
  const aad = Buffer.from(jcs({ ...frame, model: undefined, _e2ee: meta }))
  frame._e2ee.ciphertext = b64url(s.seal(aad, Buffer.from(JSON.stringify({ choices }))))
  frame.x_0g_trace = { provider: '0xrouter-injected' }
  return frame
}

describe('sealChatRequest', () => {
  it('builds a v1 envelope: model in clear, messages sealed, key_id from enc_pub', () => {
    const enclave = enclaveKeys()
    const { envelope } = sealChatRequest(REQUEST, { encPub: enclave.pk, signerAddr: SIGNER })
    expect(envelope.model).toBe(REQUEST.model)
    expect(envelope.max_tokens).toBe(8)
    expect(envelope).not.toHaveProperty('messages')
    expect(envelope._e2ee).toMatchObject({ v: 1, kem_id: '0x0020', signer_addr: SIGNER, sealed_fields: ['messages'] })
    expect(Buffer.from(envelope._e2ee.key_id, 'base64url')).toHaveLength(8)
  })

  it('opens to exactly the sealed messages inside the enclave', () => {
    const enclave = enclaveKeys()
    const { envelope } = sealChatRequest(REQUEST, { encPub: enclave.pk, signerAddr: SIGNER })
    const { ciphertext, ...meta } = envelope._e2ee
    const aad = Buffer.from(jcs({ ...envelope, _e2ee: meta }))
    const pt = hpkeSetupReceiver(enclave.sk, Buffer.from(envelope._e2ee.enc, 'base64url'), Buffer.from('0g-pc/v1/seal'))
      .open(aad, Buffer.from(ciphertext, 'base64url'))
    expect(JSON.parse(Buffer.from(pt).toString())).toEqual({ messages: REQUEST.messages })
  })

  it('cannot be opened if anyone downgrades the cleartext model', () => {
    const enclave = enclaveKeys()
    const { envelope } = sealChatRequest(REQUEST, { encPub: enclave.pk, signerAddr: SIGNER })
    const { ciphertext, ...meta } = envelope._e2ee
    const aad = Buffer.from(jcs({ ...envelope, model: 'cheaper-model', _e2ee: meta }))
    const r = hpkeSetupReceiver(enclave.sk, Buffer.from(envelope._e2ee.enc, 'base64url'), Buffer.from('0g-pc/v1/seal'))
    expect(() => r.open(aad, Buffer.from(ciphertext, 'base64url'))).toThrow()
  })
})

describe('openChatResponse', () => {
  it('recovers the enclave-sealed choices, ignoring router-injected unbound fields', () => {
    const enclave = enclaveKeys()
    const sealed = sealChatRequest(REQUEST, { encPub: enclave.pk, signerAddr: SIGNER })
    const frame = enclaveRespond(sealed.envelope, [{ message: { content: 'hello' } }])
    expect(openChatResponse(frame, sealed.ephPriv).choices).toEqual([{ message: { content: 'hello' } }])
  })
})

describe('verifyTranscript — what a buyer or verifier bot checks', () => {
  function transcript() {
    const enclave = enclaveKeys()
    const sealed = sealChatRequest(REQUEST, { encPub: enclave.pk, signerAddr: SIGNER })
    const frame = enclaveRespond(sealed.envelope, [{ message: { content: 'hello' } }])
    return {
      enclave,
      t: {
        request: sealed.envelope,
        response: frame,
        encPub: b64url(enclave.pk),
        skE: b64url(sealed.skE),
        ephPriv: b64url(sealed.ephPriv),
      },
    }
  }

  it('reveals the exact model, prompt and output that the signed text binds', () => {
    const { t } = transcript()
    const v = verifyTranscript(t)
    expect(v.model).toBe(REQUEST.model)
    expect(v.messages).toEqual(REQUEST.messages)
    expect(v.choices).toEqual([{ message: { content: 'hello' } }])
    expect(v.signedText).toBe(signedTextE2EE(t.request, t.response))
  })

  it('refuses a revealed skE that does not produce the envelope enc', () => {
    const { t } = transcript()
    const other = enclaveKeys()
    expect(() => verifyTranscript({ ...t, skE: b64url(other.sk) })).toThrow(/enc/)
  })

  it('changes the signed text when the request model is swapped', () => {
    const { t } = transcript()
    const swapped = { ...t, request: { ...t.request, model: 'other-model' } }
    expect(signedTextE2EE(swapped.request, t.response)).not.toBe(signedTextE2EE(t.request, t.response))
  })
})

// The `/earn` tab seals with this same file: a browser has no `node:crypto` (WebCrypto
// lacks ChaCha20-Poly1305) and no `Buffer`. Reintroducing either breaks browser proofs
// while every Node test here still passes, so it is checked directly.
describe('browser-safe', () => {
  it('uses neither node:crypto nor Buffer, in the sealer or the client that drives it', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['../src/e2ee.ts', '../src/sealed.ts']) {
      const code = readFileSync(new URL(f, import.meta.url), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      expect(code, f).not.toMatch(/node:crypto|\bBuffer\b|require\(/)
    }
  })
})
