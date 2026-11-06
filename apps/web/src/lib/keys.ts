import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

const INFERENCE_KEY = /\b(sk|mk)-/

const SIGNING_KEY = /^(0x)?[0-9a-fA-F]{64}$/

export type ParsedSigningKey =
  | {
      ok: true
      key: Hex
      address: Address
      publicKey: Hex
    }
  | { ok: false; error: string }

export function parseSigningKey(raw: string): ParsedSigningKey {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Paste the key this tab should post with. It stays in this tab.' }
  }
  if (INFERENCE_KEY.test(trimmed)) {
    return {
      ok: false,
      error:
        'That is a 0G API key, not a signing key. Dusk never asks for your inference key — ' +
        'it has no spend cap, and nothing here needs it. This field signs Arkiv and escrow ' +
        'transactions, so it wants the throwaway testnet key that pays their gas.',
    }
  }
  if (!SIGNING_KEY.test(trimmed)) {
    return {
      ok: false,
      error: `A signing key is 64 hexadecimal characters, with or without a 0x prefix. That is ${trimmed.length}.`,
    }
  }
  const key = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
  try {
    const account = privateKeyToAccount(key)
    return { ok: true, key, address: account.address, publicKey: account.publicKey }
  } catch {
    return { ok: false, error: 'That is 64 hexadecimal characters but no account owns it. Check the paste.' }
  }
}
