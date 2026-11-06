import { fromHex, toHex, type Hex } from 'viem'
import { decrypt, encrypt, PublicKey } from 'eciesjs'

export class UnsealError extends Error {
  constructor(cause?: unknown) {
    super('could not unseal: the value is not ciphertext, or not sealed to this key')
    this.name = 'UnsealError'
    if (cause !== undefined) this.cause = cause
  }
}

export class SealError extends Error {
  constructor(cause?: unknown) {
    super('could not seal: the recipient public key is not a valid secp256k1 point')
    this.name = 'SealError'
    if (cause !== undefined) this.cause = cause
  }
}

export function isSealablePubkey(recipientPubkey: string): boolean {
  try {
    PublicKey.fromHex(recipientPubkey)
    return true
  } catch {
    return false
  }
}

export function seal(plaintext: string, recipientPubkey: Hex): Hex {
  try {
    return toHex(encrypt(recipientPubkey, new TextEncoder().encode(plaintext)))
  } catch (e) {
    throw new SealError(e)
  }
}

export function unseal(sealed: Hex, recipientPrivateKey: Hex): string {
  try {
    return new TextDecoder().decode(decrypt(recipientPrivateKey, fromHex(sealed, 'bytes')))
  } catch (e) {
    throw new UnsealError(e)
  }
}
