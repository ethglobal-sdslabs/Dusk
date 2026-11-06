import { describe, expect, it } from 'vitest'
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from '@dusk/core'
import { attributeTypesFor } from '@dusk/arkiv'
import { render } from '@arkiv-network/sdk/query'
import { buildBrowserWorker, MIXED_MODELS_MESSAGE, OG_KEY_SHAPED } from '../src/lib/worker-browser'
import { earnQueries } from '../src/lib/earn'

const ARKIV_ACCESS_KEY = `0x${'11'.repeat(32)}` as Hex
const ESCROW_KEY = `0x${'22'.repeat(32)}` as Hex
const INFER_KEY = 'sk-live-abcdef0123456789'
const MANAGE_KEY = 'mk-live-abcdef0123456789'
const ESCROW_ADDRESS = '0x2cd51c09ca44001a86b8491fadef099d24560f75' as Address

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    OG_BASE_URL: 'https://router-api.0g.ai',
    ARKIV_RPC: 'https://rpc.tiramisu.db-chain.testnet.arkiv.network',
    ...extra,
  })
}

function build(overrides: Partial<Parameters<typeof buildBrowserWorker>[0]> = {}) {
  return buildBrowserWorker({
    config: config(),
    inferKey: INFER_KEY,
    workerKey: ARKIV_ACCESS_KEY,
    pricePer1kOut: 1n,
    models: ['0gm-1.0-35b-a3b'],
    ...overrides,
  })
}

describe('buildBrowserWorker', () => {
  it('produces the same identity the headless worker does', () => {
    const deps = build()
    const expected = privateKeyToAccount(ARKIV_ACCESS_KEY)
    expect(deps.arkivAddress).toBe(expected.address)
    expect(deps.workerId).toBe(keccak256(toHex(expected.address)))
    expect(deps.pubkey).toBe(expected.publicKey)
  })

  it('takes the delivery margin from config, not from a number of its own', () => {
    const deps = build({ config: config({ DUSK_TTL_CLAIM: '120' }) })
    expect(deps.deliverMarginMs).toBe(120 * 1000)
  })

  it('is paid whenever the build has an escrow contract, because one key does both', () => {
    const deps = build({ config: config({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }) })
    expect(deps.escrow).toBeDefined()
    expect(deps.paid).toBe(true)
    expect(deps.payout).toBe(privateKeyToAccount(ARKIV_ACCESS_KEY).address)
  })

  it('runs in Gate 1’s no-money mode when the build has no escrow contract', () => {
    const deps = build({ workerKey: ESCROW_KEY })
    expect(deps.escrow).toBeUndefined()
    expect(deps.paid).toBe(false)
  })

  it('names the escrow signer as payout, because that is the only address the contract pays', () => {
    const deps = build({ config: config({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }), workerKey: ESCROW_KEY })
    expect(deps.escrow).toBeDefined()
    expect(deps.paid).toBe(true)
    expect(deps.payout).toBe(privateKeyToAccount(ESCROW_KEY).address)
    expect(deps.payout).not.toBe(privateKeyToAccount(ARKIV_ACCESS_KEY).address)
  })

  it('can open a grant, so a private job is servable from a tab', () => {
    expect(build().unsealInput).toBeTypeOf('function')
  })

  it('injects the clock rather than reaching for Date.now inside the loop', () => {
    let calls = 0
    const deps = build({ now: () => ++calls })
    expect(deps.now()).toBe(1)
    expect(deps.now()).toBe(2)
  })

  it('starts the credit window at zero when it cannot read a balance, which is the lowest bucket', () => {
    expect(build().dayStartCredits).toBe(0n)
  })

  it('carries no key on the result, in any form', () => {
    const deps = build({
      config: config({ DUSK_ESCROW_ADDRESS: ESCROW_ADDRESS }),
      manageKey: MANAGE_KEY,
    })

    const serialised = JSON.stringify(deps, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(serialised).not.toMatch(OG_KEY_SHAPED)
    expect(serialised).not.toContain('1111111111')
    expect(serialised).not.toContain('2222222222')

    for (const [name, value] of Object.entries(deps)) {
      if (typeof value !== 'string') continue
      expect(value, name).not.toMatch(OG_KEY_SHAPED)
      expect(value, name).not.toContain('1111111111')
      expect(value, name).not.toContain('2222222222')
    }
  })

  it('wraps the Router client so an error from it cannot carry the key', async () => {
    const deps = build({ config: config({ OG_BASE_URL: 'http://127.0.0.1:1' }) })
    const rejection = await deps.og
      .complete({ model: 'nope', maxTokens: 1, messages: [] }, 'verified')
      .then(
        () => new Error('unreachable: the call should not have succeeded'),
        (e: unknown) => e as Error,
      )

    expect(rejection.message).not.toMatch(OG_KEY_SHAPED)
    expect(rejection.cause).toBeUndefined()
  })

  it('refuses a 0G key pasted into the Arkiv signing field, before anything is built', () => {
    expect(() => build({ workerKey: INFER_KEY as Hex })).toThrow()
    try {
      build({ workerKey: INFER_KEY as Hex })
    } catch (e) {
      expect((e as Error).message).not.toMatch(OG_KEY_SHAPED)
    }
  })
})

describe('earnQueries', () => {
  it('tags every comparison with the type the attribute is actually stored as', () => {
    const payout = privateKeyToAccount(ESCROW_KEY).address
    const workerId = keccak256(toHex(privateKeyToAccount(ARKIV_ACCESS_KEY).address))

    for (const query of Object.values(earnQueries(workerId, payout))) {
      const types = attributeTypesFor(query.kind)
      const comparisons = [...render(query.filter).matchAll(/([a-z][a-z0-9._-]*)\s*=\s*([a-z0-9]+)\(/g)]
      expect(comparisons.length).toBeGreaterThan(0)
      for (const [, name, tag] of comparisons) {
        expect(types[name!]).toBeDefined()
        expect(tag).toBe(types[name!])
      }
    }
  })

  it('asks about this worker’s own claims and this worker’s own receipts', () => {
    const payout = privateKeyToAccount(ESCROW_KEY).address
    const workerId = keccak256(toHex(privateKeyToAccount(ARKIV_ACCESS_KEY).address))
    const q = earnQueries(workerId, payout)

    expect(q.claims.kind).toBe('claim')
    expect(render(q.claims.filter)).toContain(workerId)
    expect(q.receipts.kind).toBe('receipt')
    expect(render(q.receipts.filter).toLowerCase()).toContain(payout.toLowerCase())
  })
})

describe('buildBrowserWorker — image models', () => {
  it('wires the image producer for image models, and none for text', () => {
    expect(typeof build({ models: ['z-image-turbo'] }).produce).toBe('function')
    expect(build().produce).toBeUndefined()
  })

  it('refuses a mix of text and image models', () => {
    expect(() => build({ models: ['0gm-1.0-35b-a3b', 'z-image-turbo'] })).toThrow(MIXED_MODELS_MESSAGE)
  })

  it('carries no key as a property of an image worker either', () => {
    const deps = build({ models: ['z-image-turbo'] })
    const props = Object.entries(deps)
      .filter(([, v]) => typeof v === 'string')
      .map(([, v]) => v as string)
    expect(props.some((v) => OG_KEY_SHAPED.test(v))).toBe(false)
  })
})

describe('buildBrowserWorker — affordability', () => {
  it('prices jobs before claiming, like the headless worker', () => {
    const w = build()
    expect(w.budget).toBeDefined()
    expect(w.budget?.spends).toEqual([])
    expect(w.budget?.defaultUnitsPerToken).toBe(1)
  })
})

describe('buildBrowserWorker — TEE proofs from the tab', () => {
  // The tab seals with @noble now (no node:crypto, no Buffer), so it can take TEE jobs
  // and be paid for them like `pnpm worker`, instead of leaving them all to a headless one.
  it('says it can prove what ran, so it claims TEE (private) jobs', () => {
    expect(build().provesTee).toBe(true)
  })
})
