import type { Address, Hex, LocalAccount } from 'viem'
import type { VerifiedIdentity } from './read'

export type AdmissionStatus = {
  sourceChainId: bigint
  controller: Address
  wallet: Address
  admitted: boolean
  sourceBlock: bigint
  validUntil: bigint
  epoch: number
}

export const ADMISSION_TYPES = {
  Status: [
    { name: 'sourceChainId', type: 'uint256' },
    { name: 'controller', type: 'address' },
    { name: 'wallet', type: 'address' },
    { name: 'admitted', type: 'bool' },
    { name: 'sourceBlock', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'epoch', type: 'uint32' },
  ],
} as const

export function admissionDomain(destinationChainId: number, admission: Address) {
  return { name: 'DuskAdmission', version: '1', chainId: destinationChainId, verifyingContract: admission } as const
}

export function statusFor(identity: VerifiedIdentity, args: { controller: Address; nowSec: number; validitySec: number; epoch: number }): AdmissionStatus | null {
  if (identity.status === 'unknown' || identity.blockNumber === undefined) return null
  return {
    sourceChainId: BigInt(identity.chainId),
    controller: args.controller,
    wallet: identity.wallet,
    admitted: identity.status === 'active',
    sourceBlock: identity.blockNumber,
    validUntil: BigInt(args.nowSec + args.validitySec),
    epoch: args.epoch,
  }
}

export async function signStatus(account: LocalAccount, destinationChainId: number, admission: Address, status: AdmissionStatus): Promise<{ signer: Address; signature: Hex }> {
  const signature = await account.signTypedData({ domain: admissionDomain(destinationChainId, admission), types: ADMISSION_TYPES, primaryType: 'Status', message: status })
  return { signer: account.address, signature }
}

export function orderSignatures(sigs: Array<{ signer: Address; signature: Hex }>): Hex[] {
  const seen = new Set<string>()
  return [...sigs]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
    .filter((s) => { const k = s.signer.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .map((s) => s.signature)
}

export const MAX_SOURCE_LAG_BLOCKS = 300n
const VALIDITY_SLACK_SEC = 300

export function coSignRefusal(
  status: AdmissionStatus,
  identity: VerifiedIdentity,
  args: { controller: Address; nowSec: number; validitySec: number; epoch: number },
): string | null {
  if (identity.status === 'unknown' || identity.blockNumber === undefined) return 'this attester reads the identity as unknown'
  if (status.wallet.toLowerCase() !== identity.wallet.toLowerCase()) return 'the status is for another wallet'
  if (status.sourceChainId !== BigInt(identity.chainId) || status.controller.toLowerCase() !== args.controller.toLowerCase() || status.epoch !== args.epoch) {
    return 'the status names another chain, controller or epoch'
  }
  if (status.admitted !== (identity.status === 'active')) return `admitted=${status.admitted}, but this attester reads ${identity.status}`
  if (status.sourceBlock > identity.blockNumber || identity.blockNumber - status.sourceBlock > MAX_SOURCE_LAG_BLOCKS) {
    return `sourceBlock ${status.sourceBlock} is not within ${MAX_SOURCE_LAG_BLOCKS} blocks at or before this attester's read (${identity.blockNumber})`
  }
  if (status.validUntil > BigInt(args.nowSec + args.validitySec + VALIDITY_SLACK_SEC)) return `validUntil ${status.validUntil} exceeds this attester's policy`
  return null
}
