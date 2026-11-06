import { describe, expect, it } from 'vitest'
import { encodeErrorResult, keccak256, encodeAbiParameters, type Address, type Hex } from 'viem'
import {
  DuskIdentityControllerAbi, UserRegistryAbi, commitmentOf, isTerminalEnsError, describeEnsError, newRegistration, registrationStage, dnsEncode,
  type RegistrationOp,
} from '../src'

const controller = '0x5e7AaC0312eB2Bd9595020Fd9165aa26e1719F27' as Address
const wallet = '0x1111111111111111111111111111111111111111' as Address
const secret = `0x${'ab'.repeat(32)}` as Hex

describe('commitmentOf', () => {
  it('is the controller\'s makeCommitment: abi.encode(chainid, controller, policy, label, owner, secret)', () => {
    const expected = keccak256(encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint32' }, { type: 'string' }, { type: 'address' }, { type: 'bytes32' }],
      [11155111n, controller, 3, 'alice', wallet, secret],
    ))
    expect(commitmentOf({ chainId: 11155111, controller, label: 'alice', wallet, secret })).toBe(expected)
  })

  it('binds the wallet: the same reveal from another wallet is a different commitment', () => {
    const other = '0x2222222222222222222222222222222222222222' as Address
    expect(commitmentOf({ chainId: 11155111, controller, label: 'alice', wallet, secret }))
      .not.toBe(commitmentOf({ chainId: 11155111, controller, label: 'alice', wallet: other, secret }))
  })
})

describe('newRegistration', () => {
  it('canonicalizes the label and never accepts a full name or a reserved one', () => {
    const op = newRegistration({ chainId: 11155111, controller, wallet, label: 'Alice', parentName: 'dusk.eth', now: 1000 })
    expect(op.label).toBe('alice')
    expect(op.name).toBe('alice.dusk.eth')
    expect(op.secret).toMatch(/^0x[0-9a-f]{64}$/)
    expect(() => newRegistration({ chainId: 11155111, controller, wallet, label: 'alice.dusk.eth', parentName: 'dusk.eth', now: 0 })).toThrow()
    expect(() => newRegistration({ chainId: 11155111, controller, wallet, label: 'admin', parentName: 'dusk.eth', now: 0 })).toThrow(/reserved/)
  })

  it('draws a fresh secret every time', () => {
    const a = newRegistration({ chainId: 11155111, controller, wallet, label: 'alice', parentName: 'dusk.eth', now: 0 })
    const b = newRegistration({ chainId: 11155111, controller, wallet, label: 'alice', parentName: 'dusk.eth', now: 0 })
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('registrationStage', () => {
  const base: RegistrationOp = { ...newRegistration({ chainId: 11155111, controller, wallet, label: 'alice', parentName: 'dusk.eth', now: 0 }) }
  const timing = { minAgeSec: 60, maxAgeSec: 86_400 }

  it('walks choosing → committing → waiting → reveal-ready → registering → registered', () => {
    expect(registrationStage(base, 0, timing)).toBe('choosing')
    expect(registrationStage({ ...base, commitTx: '0x01' }, 0, timing)).toBe('committing')
    const committed = { ...base, commitTx: '0x01' as Hex, committedAt: 1_000 }
    expect(registrationStage(committed, 1_000 + 59_000, timing)).toBe('waiting')
    expect(registrationStage(committed, 1_000 + 61_000, timing)).toBe('reveal-ready')
    expect(registrationStage({ ...committed, registerTx: '0x02' }, 70_000, timing)).toBe('registering')
    expect(registrationStage({ ...committed, registerTx: '0x02', registeredAt: 80_000 }, 90_000, timing)).toBe('registered')
  })

  it('an unrevealed commitment past the window is expired, and needs a new one', () => {
    const committed = { ...base, commitTx: '0x01' as Hex, committedAt: 0 }
    expect(registrationStage(committed, 86_401_000, timing)).toBe('expired')
  })
})

describe('describeEnsError', () => {
  const revert = (errorName: string) => {
    const data = encodeErrorResult({ abi: DuskIdentityControllerAbi, errorName: errorName as never })
    return Object.assign(new Error('execution reverted https://rpc.example/secret'), { data, cause: { data } })
  }

  it.each([
    ['LabelUnavailable', /taken/i],
    ['LabelReserved', /reserved/i],
    ['AlreadyMember', /already has/i],
    ['WalletBanned', /cannot register/i],
    ['CommitmentTooNew', /wait/i],
    ['CommitmentTooOld', /expired/i],
    ['NamespaceExpired', /dusk\.eth/i],
  ])('%s reads as a plain sentence', (name, pattern) => {
    expect(describeEnsError(revert(name))).toMatch(pattern)
  })

  it('names a revert bubbled up from the registry\'s mint (7702 delegate without a receiver)', () => {
    const data = encodeErrorResult({ abi: UserRegistryAbi, errorName: 'ERC1155InvalidReceiver', args: [wallet] })
    expect(describeEnsError(Object.assign(new Error('reverted'), { cause: { data } }))).toMatch(/EIP-7702/)
  })

  it('reports an unknown revert by selector only', () => {
    expect(describeEnsError(Object.assign(new Error('reverted'), { cause: { data: '0xdeadbeef00' } }))).toMatch(/0xdeadbeef/)
  })

  it('never repeats an RPC URL from an unknown error', () => {
    expect(describeEnsError(new Error('fetch failed https://rpc.example/secret'))).not.toMatch(/rpc\.example|secret/)
  })

  it('treats a wallet rejection as a recoverable cancellation', () => {
    expect(describeEnsError(Object.assign(new Error('User rejected the request.'), { code: 4001 }))).toMatch(/cancel/i)
  })
})

describe('dnsEncode', () => {
  it('matches the controller\'s dnsName', () => {
    expect(dnsEncode('alice.dusk.eth')).toBe('0x05616c696365046475736b0365746800')
  })
})

describe('isTerminalEnsError', () => {
  const revert = (errorName: string) => {
    const data = encodeErrorResult({ abi: DuskIdentityControllerAbi, errorName: errorName as never })
    return Object.assign(new Error('reverted'), { cause: { data } })
  }
  it('is terminal for a named contract refusal and for a mined revert', () => {
    expect(isTerminalEnsError(revert('LabelUnavailable'))).toBe(true)
    expect(isTerminalEnsError(revert('WalletBanned'))).toBe(true)
    expect(isTerminalEnsError(Object.assign(new Error('x'), { reverted: true }))).toBe(true)
  })
  it('is not terminal for a network failure or a cancelled prompt', () => {
    expect(isTerminalEnsError(new Error('fetch failed'))).toBe(false)
    expect(isTerminalEnsError(Object.assign(new Error('User rejected the request.'), { code: 4001 }))).toBe(false)
  })
})
