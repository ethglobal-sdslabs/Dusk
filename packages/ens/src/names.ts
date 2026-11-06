import { keccak256, toHex } from 'viem'
import { namehash, normalize } from 'viem/ens'

export const RESERVED_LABELS = ['admin', 'support', 'security', 'www', 'api', 'root', 'dusk', 'official', 'verification'] as const
const RESERVED = new Set<string>(RESERVED_LABELS)

export class EnsInputError extends Error {
  override name = 'EnsInputError'
}

export function normalizeLabel(input: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/.test(input)) {
    throw new EnsInputError('Use 3–32 letters or digits, with hyphens only inside the name.')
  }
  const label = input.toLowerCase()
  if (label.includes('--') || label.startsWith('xn-')) throw new EnsInputError('Consecutive hyphens and encoded names are not supported.')
  if (RESERVED.has(label)) throw new EnsInputError('This name is reserved for the namespace.')
  return label
}

export function normalizeParent(input: string): string {
  try {
    const parent = normalize(input)
    if (parent !== input || !parent.endsWith('.eth') || parent.split('.').some((p) => !p)) throw new Error()
    return parent
  } catch {
    throw new EnsInputError('ENS_PARENT_NAME must be a canonical .eth name.')
  }
}

export function duskName(input: string, parent: string) {
  const label = normalizeLabel(input)
  const name = normalize(`${label}.${normalizeParent(parent)}`)
  return { label, name, labelhash: keccak256(toHex(label)), namehash: namehash(name) }
}
