import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, encodeAbiParameters, keccak256, toHex,
  type Address, type Hex,
} from 'viem'
import { UserRegistryAbi } from './abi'
import { DuskIdentityControllerAbi } from './controller-abi'
import { duskName } from './names'

export const POLICY_VERSION = 3

export function commitmentOf(args: { chainId: number; controller: Address; label: string; wallet: Address; secret: Hex }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint32' }, { type: 'string' }, { type: 'address' }, { type: 'bytes32' }],
    [BigInt(args.chainId), args.controller, POLICY_VERSION, args.label, args.wallet, args.secret],
  ))
}

export function dnsEncode(name: string): Hex {
  const bytes: number[] = []
  for (const label of name.split('.')) {
    const encoded = new TextEncoder().encode(label)
    if (encoded.length === 0 || encoded.length > 63) throw new Error('Not a DNS-encodable name.')
    bytes.push(encoded.length, ...encoded)
  }
  bytes.push(0)
  return toHex(new Uint8Array(bytes))
}

export type RegistrationOp = {
  chainId: number
  controller: Address
  wallet: Address
  label: string
  name: string
  secret: Hex
  createdAt: number
  commitTx?: Hex
  committedAt?: number
  registerTx?: Hex
  registeredAt?: number
}

export function newRegistration(args: { chainId: number; controller: Address; wallet: Address; label: string; parentName: string; now: number }): RegistrationOp {
  const { label, name } = duskName(args.label, args.parentName)
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  return { chainId: args.chainId, controller: args.controller, wallet: args.wallet, label, name, secret: toHex(random), createdAt: args.now }
}

export type RegistrationStage = 'choosing' | 'committing' | 'waiting' | 'reveal-ready' | 'registering' | 'registered' | 'expired'

export function registrationStage(op: RegistrationOp, now: number, timing: { minAgeSec: number; maxAgeSec: number }): RegistrationStage {
  if (op.registeredAt !== undefined) return 'registered'
  if (op.registerTx) return 'registering'
  if (!op.commitTx) return 'choosing'
  if (op.committedAt === undefined) return 'committing'
  const age = (now - op.committedAt) / 1000
  if (age > timing.maxAgeSec) return 'expired'
  return age >= timing.minAgeSec + 1 ? 'reveal-ready' : 'waiting'
}

const MESSAGES: Record<string, string> = {
  LabelUnavailable: 'That name is taken. Pick another.',
  LabelReserved: 'That name is reserved.',
  InvalidLabel: 'Use 3–32 lowercase letters or digits, with single hyphens only inside the name.',
  AlreadyMember: 'This wallet already has a Dusk name.',
  WalletBanned: 'This wallet cannot register a Dusk name.',
  CommitmentMissing: 'No matching reservation was found for this wallet. Start again.',
  CommitmentTooNew: 'Wait a little longer before confirming — the reservation needs a minute to settle.',
  CommitmentTooOld: 'The reservation expired. Start again to reserve the name.',
  CommitmentExists: 'This reservation is already pending.',
  NotAnEOA: 'Names are issued to key-controlled wallets only, not to contract wallets.',
  Paused: 'Registration is paused right now.',
  NamespaceExpired: 'dusk.eth itself has expired, so no names can be issued until it is renewed.',
  ExpiryCappedByNamespace: 'This name already runs until dusk.eth itself expires.',
  RenewalTooEarly: 'This name is already renewed as far ahead as allowed.',
  NotMember: 'This wallet holds no Dusk name to renew.',
  Reentrancy: 'The transaction was refused. Try again.',
  ERC1155InvalidReceiver: 'This wallet cannot receive the name: its smart-account delegate (EIP-7702) does not accept ERC-1155 tokens. Use a plain wallet, or a delegate that accepts them.',
  LabelAlreadyRegistered: 'That name is taken. Pick another.',
  LabelAlreadyReserved: 'That name is reserved.',
}

const REVERT_ABI = [...DuskIdentityControllerAbi, ...UserRegistryAbi]

export function describeEnsError(error: unknown): string {
  const e = error as { code?: number; name?: string; message?: string }
  if (e?.code === 4001 || e?.name === 'UserRejectedRequestError' || /user rejected|user denied/i.test(e?.message ?? '')) {
    return 'Cancelled in the wallet. Nothing was sent.'
  }
  const name = revertName(error)
  if (name) return MESSAGES[name] ?? `The controller refused the transaction (${name}).`
  const selector = revertSelector(error)
  if (selector) return `The transaction reverted with an unrecognised error (${selector}).`
  return 'The transaction could not be sent. Check the network and try again.'
}

export function isTerminalEnsError(error: unknown): boolean {
  if ((error as { reverted?: boolean })?.reverted === true) return true
  return revertName(error) !== undefined || revertSelector(error) !== undefined
}

function revertSelector(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const data = (e as { data?: unknown; signature?: unknown }).signature ?? (e as { data?: unknown }).data
    if (typeof data === 'string' && /^0x[0-9a-f]{8}/i.test(data)) return data.slice(0, 10)
  }
  return undefined
}

function revertName(error: unknown): string | undefined {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) return reverted.data.errorName
  }
  for (let e: unknown = error, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const data = (e as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        return decodeErrorResult({ abi: REVERT_ABI, data: data as Hex }).errorName
      } catch { }
    }
  }
  return undefined
}
