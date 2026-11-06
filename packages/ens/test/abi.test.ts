import { describe, expect, it } from 'vitest'
import { toFunctionSelector, type AbiFunction } from 'viem'
import { PermissionedResolverAbi, UserRegistryAbi } from '../src'

const fn = (abi: readonly unknown[], name: string) => (abi as AbiFunction[]).find((x) => x.type === 'function' && x.name === name)!

describe('pinned ENSv2 ABI subsets', () => {
  it('setText and setAddress take a DNS-encoded name, not a node', () => {
    expect(toFunctionSelector(fn(PermissionedResolverAbi, 'setText'))).toBe(toFunctionSelector('setText(bytes,string,string)'))
    expect(toFunctionSelector(fn(PermissionedResolverAbi, 'setAddress'))).toBe(toFunctionSelector('setAddress(bytes,uint256,bytes)'))
  })

  it('register is the six-argument PermissionedRegistry form', () => {
    expect(toFunctionSelector(fn(UserRegistryAbi, 'register'))).toBe(toFunctionSelector('register(string,address,address,address,uint256,uint64)'))
  })
})
