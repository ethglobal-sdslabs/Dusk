import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keccak256, type Address, type Hex } from 'viem'
import { controllerJournalStore, controllerRuntimeMatches, resolveControllerDeployment } from '../ens-controller-deployment'

const owner = '0x1111111111111111111111111111111111111111' as Address
const child = '0x2222222222222222222222222222222222222222' as Address
const controller = '0x3333333333333333333333333333333333333333' as Address
const data = '0x60001234' as Hex
const transactionHash = `0x${'ab'.repeat(32)}` as Hex
const context = { chainId: 11155111, owner, child, calldataHash: keccak256(data) }
let root: string
let path: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dusk-ens-deploy-')); path = join(root, 'controller.json') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

function world() {
  return {
    context, data, store: controllerJournalStore(path),
    send: vi.fn(async () => transactionHash),
    wait: vi.fn(async () => ({ status: 'success' as 'success' | 'reverted', contractAddress: controller as Address | null, blockNumber: 100n })),
    transaction: vi.fn(async () => ({ from: owner, to: null as Address | null, input: data })),
  }
}

describe('controller deployment recovery', () => {
  it('persists the broadcast hash before a receipt timeout and resumes without deploying twice', async () => {
    const first = world()
    first.wait.mockRejectedValueOnce(new Error('receipt timeout'))
    await expect(resolveControllerDeployment(first)).rejects.toThrow('receipt timeout')
    expect(JSON.parse(readFileSync(path, 'utf8')).transactionHash).toBe(transactionHash)
    const restarted = world()
    const result = await resolveControllerDeployment(restarted)
    expect(result).toEqual({ address: controller, blockNumber: 100n, transactionHash })
    expect(restarted.send).not.toHaveBeenCalled()
    expect(restarted.transaction).toHaveBeenCalledWith(transactionHash)
  })

  it('does not broadcast again after a successful run, even without a copied controller address', async () => {
    const first = world()
    await resolveControllerDeployment(first)
    const second = world()
    await resolveControllerDeployment(second)
    expect(first.send).toHaveBeenCalledOnce()
    expect(second.send).not.toHaveBeenCalled()
  })

  it('only permits a new explicit attempt after a confirmed on-chain revert', async () => {
    const failed = world()
    failed.wait.mockResolvedValueOnce({ status: 'reverted', contractAddress: null, blockNumber: 100n })
    await expect(resolveControllerDeployment(failed)).rejects.toThrow(/reverted.*rerun to retry/i)
    expect(failed.send).toHaveBeenCalledOnce()
    const retry = world()
    await resolveControllerDeployment(retry)
    expect(retry.send).toHaveBeenCalledOnce()
  })

  it('refuses changed deployment parameters instead of silently creating another controller', async () => {
    const old = world()
    old.store.save({ ...context, transactionHash })
    for (const changed of [{ ...context, chainId: 1 }, { ...context, owner: child }, { ...context, child: owner }]) {
      const next = world()
      await expect(resolveControllerDeployment({ ...next, context: changed })).rejects.toThrow(/different settings/)
      expect(next.send).not.toHaveBeenCalled()
    }
  })

  it('never trusts a saved hash for a different sender, recipient or creation bytecode', async () => {
    for (const transaction of [
      { from: child, to: null, input: data },
      { from: owner, to: child, input: data },
      { from: owner, to: null, input: '0x00' as Hex },
    ]) {
      const w = world()
      w.store.save({ ...context, transactionHash })
      w.transaction.mockResolvedValueOnce(transaction)
      await expect(resolveControllerDeployment(w)).rejects.toThrow(/not this owner's expected controller creation/)
      expect(w.send).not.toHaveBeenCalled()
      expect(w.store.load()?.transactionHash).toBe(transactionHash)
    }
  })

  it('previews without writing a journal or sending a transaction', async () => {
    const w = world()
    await expect(resolveControllerDeployment({ ...w, send: undefined })).resolves.toBeUndefined()
    expect(w.store.load()).toBeUndefined()
    expect(w.send).not.toHaveBeenCalled()
  })

  it('refuses a corrupt journal rather than forgetting a possibly pending deployment', async () => {
    writeFileSync(path, '{broken')
    const w = world()
    await expect(resolveControllerDeployment(w)).rejects.toThrow(/journal is unreadable/)
    expect(w.send).not.toHaveBeenCalled()
  })
})

describe('controller runtime verification', () => {
  const artifact = { object: '0x60006000f3' as Hex, immutableReferences: { '1': [{ start: 1, length: 1 }] } }
  it('permits only constructor immutable substitutions', () => {
    expect(controllerRuntimeMatches('0x60aa6000f3', artifact)).toBe(true)
    expect(controllerRuntimeMatches('0x60aa6100f3', artifact)).toBe(false)
    expect(controllerRuntimeMatches('0x60aa60', artifact)).toBe(false)
    expect(controllerRuntimeMatches(undefined, artifact)).toBe(false)
    expect(controllerRuntimeMatches('0x', artifact)).toBe(false)
  })
  it('refuses invalid immutable ranges rather than masking arbitrary bytecode', () => {
    expect(controllerRuntimeMatches(artifact.object, { ...artifact, immutableReferences: { '1': [{ start: 1, length: 99 }] } })).toBe(false)
  })
})
