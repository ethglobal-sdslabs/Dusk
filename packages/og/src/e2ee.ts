import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 as X25519 } from '@noble/curves/ed25519'
import { hmac } from '@noble/hashes/hmac'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'


type Bytes = Uint8Array

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const b64url = (b: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    if (i + 1 < b.length) out += B64[(n >> 6) & 63]!
    if (i + 2 < b.length) out += B64[n & 63]!
  }
  return out
}
export const unb64 = (s: string): Bytes => {
  const clean = String(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buf >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}
const sha256 = (b: Uint8Array): Bytes => nobleSha256(b)
const utf8 = (s: string): Bytes => new TextEncoder().encode(s)
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b)

export function jcs(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('jcs: non-finite number')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : jcs(x))).join(',')}]`
  const keys = Object.keys(v as object)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(',')}}`
}


export function x25519Public(sk: Uint8Array): Bytes {
  return X25519.getPublicKey(sk)
}
function x25519(sk: Uint8Array, pk: Uint8Array): Bytes {
  return X25519.getSharedSecret(sk, pk)
}
function x25519Generate(): Bytes {
  return X25519.utils.randomPrivateKey()
}


const i2osp = (n: number, len: number): Bytes => {
  const b = new Uint8Array(len)
  for (let i = len - 1, v = n; i >= 0 && v > 0; i--, v = Math.floor(v / 256)) b[i] = v % 256
  return b
}
const KEM_SUITE = concat(utf8('KEM'), i2osp(0x0020, 2))
const HPKE_SUITE = concat(utf8('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0003, 2))
const V1 = utf8('HPKE-v1')
const EMPTY = new Uint8Array(0)

const hkdfExtract = (salt: Uint8Array, ikm: Uint8Array): Bytes => hmac(nobleSha256, salt, ikm)
function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Bytes {
  const out: Uint8Array[] = []
  let total = 0
  let t: Uint8Array = EMPTY
  for (let i = 1; total < len; i++) {
    t = hmac(nobleSha256, prk, concat(t, info, Uint8Array.of(i)))
    out.push(t)
    total += t.length
  }
  return concat(...out).subarray(0, len)
}
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  hkdfExtract(salt, concat(V1, suite, utf8(label), ikm))
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  hkdfExpand(prk, concat(i2osp(len, 2), V1, suite, utf8(label), info), len)

function kemSharedSecret(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Bytes {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh)
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', concat(enc, pkR), 32)
}

function keySchedule(sharedSecret: Uint8Array, info: Uint8Array) {
  const ctx = concat(
    Uint8Array.of(0x00),
    labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY),
    labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info),
  )
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY)
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', ctx, 32),
    baseNonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', ctx, 12),
  }
}

function nonceFor(baseNonce: Uint8Array, seq: number): Bytes {
  const n = Uint8Array.from(baseNonce)
  const s = i2osp(seq, 12)
  for (let i = 0; i < 12; i++) n[i]! ^= s[i]!
  return n
}

function aeadSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Bytes {
  return chacha20poly1305(key, nonce, aad).encrypt(pt)
}
function aeadOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Bytes {
  if (ct.length < 16) throw new Error('hpke: ciphertext shorter than its tag')
  return chacha20poly1305(key, nonce, aad).decrypt(ct)
}

export function hpkeSetupSender(pkR: Uint8Array, info: Uint8Array, skE: Uint8Array = x25519Generate()) {
  const enc = x25519Public(skE)
  const { key, baseNonce } = keySchedule(kemSharedSecret(x25519(skE, pkR), enc, pkR), info)
  let seq = 0
  return { enc, skE: Uint8Array.from(skE), key, baseNonce, seal: (aad: Uint8Array, pt: Uint8Array) => aeadSeal(key, nonceFor(baseNonce, seq++), aad, pt) }
}

export function hpkeSetupReceiver(skR: Uint8Array, enc: Uint8Array, info: Uint8Array) {
  const { key, baseNonce } = keySchedule(kemSharedSecret(x25519(skR, enc), enc, x25519Public(skR)), info)
  let seq = 0
  return { open: (aad: Uint8Array, ct: Uint8Array) => aeadOpen(key, nonceFor(baseNonce, seq++), aad, ct) }
}

type Json = Record<string, any>
const INFO_SEAL = utf8('0g-pc/v1/seal')
const INFO_RESP = utf8('0g-pc/v1/resp')

export function aadOf(env: Json): Bytes {
  const e2ee = env._e2ee as Json | undefined
  if (!e2ee || typeof e2ee !== 'object') throw new Error('envelope has no _e2ee')
  const unbound = e2ee.unbound_fields ?? []
  if (!Array.isArray(unbound) || unbound.some((f) => typeof f !== 'string')) {
    throw new Error('unbound_fields must be an array of strings')
  }
  const out: Json = { ...env }
  for (const f of unbound) if (f !== '_e2ee') delete out[f]
  const { ciphertext: _ct, ...meta } = e2ee
  out._e2ee = meta
  return utf8(jcs(out))
}

export function frameBindingHash(env: Json): string {
  const ct = env._e2ee?.ciphertext
  if (typeof ct !== 'string' || ct === '') throw new Error('envelope carries no ciphertext to bind')
  return toHex(sha256(concat(sha256(aadOf(env)), sha256(unb64(ct)))))
}

export function signedTextE2EE(requestEnv: Json, responseEnv: Json): string {
  return `zg-sig-v1/e2ee-ct:${frameBindingHash(requestEnv)}:${frameBindingHash(responseEnv)}`
}

export interface SealedChatRequest {
  envelope: Json
  skE: Bytes
  ephPriv: Bytes
}

export function sealChatRequest(
  request: Json,
  provider: { encPub: Uint8Array; signerAddr: string },
): SealedChatRequest {
  const sealedFields = ['messages', 'tools', 'tool_choice'].filter((f) => request[f] !== undefined)
  if (!sealedFields.includes('messages')) throw new Error('a chat request must carry messages to seal')
  if ('_e2ee' in request || '_bind' in request) throw new Error('request already carries protocol fields')

  const ephPriv = x25519Generate()
  const sender = hpkeSetupSender(provider.encPub, INFO_SEAL)
  const cleartext: Json = {}
  const sealedObj: Json = {}
  for (const [k, v] of Object.entries(request)) (sealedFields.includes(k) ? sealedObj : cleartext)[k] = v

  const envelope: Json = {
    ...cleartext,
    _e2ee: {
      v: 1,
      kem_id: '0x0020',
      key_id: b64url(sha256(provider.encPub).subarray(0, 8)),
      signer_addr: provider.signerAddr,
      client_eph_pub: b64url(x25519Public(ephPriv)),
      enc: b64url(sender.enc),
      sealed_fields: sealedFields,
    },
  }
  envelope._e2ee.ciphertext = b64url(sender.seal(aadOf(envelope), utf8(JSON.stringify(sealedObj))))
  return { envelope, skE: sender.skE, ephPriv }
}

export function openChatResponse(frame: Json, ephPriv: Uint8Array): Json {
  const e2ee = frame._e2ee as Json | undefined
  if (!e2ee?.enc || !e2ee.ciphertext) throw new Error('response is not a sealed v1 frame')
  if (e2ee.final !== true) throw new Error('response frame is not final')
  const pt = hpkeSetupReceiver(ephPriv, unb64(e2ee.enc), INFO_RESP).open(aadOf(frame), unb64(e2ee.ciphertext))
  const opened = JSON.parse(fromUtf8(pt)) as Json
  const want = [...(e2ee.sealed_fields ?? [])].sort().join(',')
  if (Object.keys(opened).sort().join(',') !== want) throw new Error('opened fields do not equal sealed_fields')
  return opened
}

export interface Transcript {
  request: Json
  response: Json
  encPub: string
  skE: string
  ephPriv: string
}

export function verifyTranscript(t: Transcript) {
  const encPub = unb64(t.encPub)
  const skE = unb64(t.skE)
  const ephPriv = unb64(t.ephPriv)
  const e = t.request._e2ee as Json
  if (!equal(x25519Public(skE), unb64(e.enc))) throw new Error('revealed skE does not produce the request enc')
  if (!equal(x25519Public(ephPriv), unb64(e.client_eph_pub))) throw new Error('revealed ephPriv does not produce client_eph_pub')
  if (e.key_id !== b64url(sha256(encPub).subarray(0, 8))) throw new Error('encPub does not match the request key_id')

  const { key, baseNonce } = keySchedule(kemSharedSecret(x25519(skE, encPub), unb64(e.enc), encPub), INFO_SEAL)
  const reqPt = JSON.parse(fromUtf8(aeadOpen(key, nonceFor(baseNonce, 0), aadOf(t.request), unb64(e.ciphertext)))) as Json
  const resp = openChatResponse(t.response, ephPriv)
  return {
    model: t.request.model as string,
    maxTokens: t.request.max_tokens as number | undefined,
    messages: reqPt.messages,
    choices: resp.choices,
    signedText: signedTextE2EE(t.request, t.response),
  }
}
