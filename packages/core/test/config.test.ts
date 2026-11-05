import { describe, expect, it } from 'vitest'
import { galileoChain, loadConfig, partyKey, partyKeys } from '../src/config'
import { TtlAlignmentError } from '../src/expiry'

const COMPLETE_ENV: Record<string, string> = {
  OG_BASE_URL: 'https://router-api-testnet.integratenetwork.work',
  OG_INFERE: 'sk-test-inference-key-value',
  OG_MANAGE: 'mk-test-manage-key-value',
  DUSK_BUYER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
  DUSK_WORKER_PRIVATE_KEY: `0x${'b'.repeat(64)}`,
  DUSK_ESCROW_ADDRESS: '0x'.padEnd(42, 'c'),
}

describe('loadConfig', () => {
  it('builds a config from a complete environment', () => {
    const c = loadConfig(COMPLETE_ENV)
    expect(c.arkiv.chainId).toBe(7794095)
    expect(c.escrow.chainId).toBe(16602)
  })

  it('rejects a TTL that is not block-aligned', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_TTL_CLAIM: '91' })).toThrow(TtlAlignmentError)
  })

  it('names the missing variable when one is absent', () => {
    const { OG_BASE_URL: _omitted, ...rest } = COMPLETE_ENV
    expect(() => loadConfig(rest)).toThrow(/OG_BASE_URL/)
  })

  it('accepts a mainnet-only environment, since mainnet is where Dusk runs', () => {
    const { OG_BASE_URL: _testnetOnly, ...rest } = COMPLETE_ENV
    const c = loadConfig({ ...rest, OG_BASE_URL_MAIN: 'https://router-api.0g.ai' })
    expect(c.og.baseUrl).toBe('https://router-api.0g.ai')
  })

  it('strips a trailing /v1 from the Router base url, since both spellings are documented', () => {
    const c = loadConfig({ ...COMPLETE_ENV, OG_BASE_URL: 'https://router-api.0g.ai/v1' })
    expect(c.og.baseUrl).toBe('https://router-api.0g.ai')
  })

  it('strips trailing slashes from the Router base url', () => {
    const c = loadConfig({ ...COMPLETE_ENV, OG_BASE_URL: 'https://router-api.0g.ai/v1///' })
    expect(c.og.baseUrl).toBe('https://router-api.0g.ai')
  })

  it('prefers OG_BASE_URL when both are set, so a probe can still target testnet', () => {
    const c = loadConfig({ ...COMPLETE_ENV, OG_BASE_URL_MAIN: 'https://router-api.0g.ai' })
    expect(c.og.baseUrl).toBe(COMPLETE_ENV.OG_BASE_URL)
  })

  it('names both Router variables when neither is set', () => {
    const { OG_BASE_URL: _omitted, ...rest } = COMPLETE_ENV
    expect(() => loadConfig(rest)).toThrow(/OG_BASE_URL_MAIN/)
  })

  it('never includes an API key in a thrown message', () => {
    expect.assertions(1)
    try {
      loadConfig({ ...COMPLETE_ENV, DUSK_TTL_CLAIM: '91' })
    } catch (e) {
      expect(String(e)).not.toContain(COMPLETE_ENV.OG_INFERE)
    }
  })

  it('defaults every TTL to the values DESIGN.md pins', () => {
    const c = loadConfig(COMPLETE_ENV)
    expect(c.ttl).toEqual({ worker: 120, claim: 90, grant: 300, receipt: 604800 })
    expect(c.clock.resetAt).toBe('daily-utc-midnight')
  })

  it('treats the swarm settings as optional, since Gate 0 Task 4 discovers them', () => {
    const c = loadConfig(COMPLETE_ENV)
    expect(c.swarm.endpoint).toBeUndefined()
    expect(c.swarm.batchId).toBeUndefined()
  })

  it('accepts a compressed demo clock for the credit reset', () => {
    const c = loadConfig({ ...COMPLETE_ENV, DUSK_CLOCK_EVERY_SECONDS: '300' })
    expect(c.clock.resetAt).toEqual({ everySeconds: 300 })
  })

  it('rejects a non-numeric chain id instead of yielding NaN', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, ARKIV_CHAIN_ID: 'not-a-number' })).toThrow(
      /ARKIV_CHAIN_ID/,
    )
  })

  it('rejects a non-numeric demo clock instead of yielding NaN', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_CLOCK_EVERY_SECONDS: 'abc' })).toThrow(
      /DUSK_CLOCK_EVERY_SECONDS/,
    )
  })

  it('rejects a malformed escrow address rather than passing the string through', () => {
    expect(() =>
      loadConfig({ ...COMPLETE_ENV, DUSK_ESCROW_ADDRESS: 'totally-not-an-address' }),
    ).toThrow(/DUSK_ESCROW_ADDRESS/)
  })

  it('never yields NaN for any numeric field in a complete environment', () => {
    const c = loadConfig(COMPLETE_ENV)
    for (const n of [
      c.arkiv.chainId,
      c.escrow.chainId,
      c.ttl.worker,
      c.ttl.claim,
      c.ttl.grant,
      c.ttl.receipt,
    ]) {
      expect(Number.isFinite(n)).toBe(true)
    }
  })
})

describe('partyKey / partyKeys', () => {
  it('reads one key per party', () => {
    expect(partyKey(COMPLETE_ENV, 'buyer')).toBe(COMPLETE_ENV.DUSK_BUYER_PRIVATE_KEY)
    expect(partyKey(COMPLETE_ENV, 'worker')).toBe(COMPLETE_ENV.DUSK_WORKER_PRIVATE_KEY)
  })

  it('names the missing variable when a party has no key', () => {
    const { DUSK_WORKER_PRIVATE_KEY: _omitted, ...rest } = COMPLETE_ENV
    expect(() => partyKey(rest, 'worker')).toThrow(/DUSK_WORKER_PRIVATE_KEY/)
  })

  it('refuses a retired key name instead of falling back to it', () => {
    const { DUSK_BUYER_PRIVATE_KEY: _omitted, ...rest } = COMPLETE_ENV
    expect(() => partyKey({ ...rest, ARKIV_PRIVATE_KEY: `0x${'a'.repeat(64)}` }, 'buyer')).toThrow(
      /retired/i,
    )
  })

  it('explains what to do when a retired name is found', () => {
    const { DUSK_BUYER_PRIVATE_KEY: _omitted, ...rest } = COMPLETE_ENV
    expect(() =>
      partyKey({ ...rest, GALILEO_PRIVATE_KEY: `0x${'a'.repeat(64)}` }, 'buyer'),
    ).toThrow(/DUSK_BUYER_PRIVATE_KEY/)
  })

  it('rejects a malformed key without repeating it', () => {
    const bad = 'not-a-key-at-all'
    try {
      partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: bad }, 'buyer')
      throw new Error('should have thrown')
    } catch (e) {
      expect(String(e)).toMatch(/DUSK_BUYER_PRIVATE_KEY/)
      expect(String(e)).not.toContain(bad)
    }
  })

  it('accepts a bare 64-hex key and normalises it', () => {
    const bare = 'a'.repeat(64)
    expect(partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: bare }, 'buyer')).toBe(`0x${bare}`)
  })

  it('normalises an uppercase 0X prefix', () => {
    const k = `0X${'a'.repeat(64)}`
    expect(partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: k }, 'buyer')).toBe(
      `0x${'a'.repeat(64)}`,
    )
  })

  it('strips surrounding whitespace and quotes, which .env files collect', () => {
    const k = `  "0x${'a'.repeat(64)}"  `
    expect(partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: k }, 'buyer')).toBe(
      `0x${'a'.repeat(64)}`,
    )
  })

  it('still sees one key written two ways as the same key', () => {
    const k = 'a'.repeat(64)
    expect(() =>
      partyKeys({
        ...COMPLETE_ENV,
        DUSK_BUYER_PRIVATE_KEY: k,
        DUSK_WORKER_PRIVATE_KEY: `0x${k}`,
      }),
    ).toThrow(/distinct accounts/)
  })

  it('says what is wrong with a key without repeating it', () => {
    expect(() =>
      partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: `0x${'a'.repeat(60)}` }, 'buyer'),
    ).toThrow(/60 hex characters, not 64/)
    expect(() =>
      partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: `0x${'z'.repeat(64)}` }, 'buyer'),
    ).toThrow(/not hexadecimal/)
  })

  it('rejects a key of the wrong length', () => {
    expect(() =>
      partyKey({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: `0x${'a'.repeat(63)}` }, 'buyer'),
    ).toThrow(/32-byte private key/)
  })

  it('returns both keys for a complete environment', () => {
    const { buyer, worker } = partyKeys(COMPLETE_ENV)
    expect(buyer).not.toBe(worker)
  })

  it('refuses one key used for both parties', () => {
    const same = `0x${'a'.repeat(64)}`
    expect(() =>
      partyKeys({ ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: same, DUSK_WORKER_PRIVATE_KEY: same }),
    ).toThrow(/distinct accounts/)
  })

  it('compares the two keys case-insensitively, since hex casing is not identity', () => {
    expect(() =>
      partyKeys({
        ...COMPLETE_ENV,
        DUSK_BUYER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
        DUSK_WORKER_PRIVATE_KEY: `0x${'A'.repeat(64)}`,
      }),
    ).toThrow(/distinct accounts/)
  })

  it('refuses one key for both parties through the single-key accessor too', () => {
    const same = `0x${'a'.repeat(64)}`
    const env = { ...COMPLETE_ENV, DUSK_BUYER_PRIVATE_KEY: same, DUSK_WORKER_PRIVATE_KEY: same }
    expect(() => partyKey(env, 'buyer')).toThrow(/distinct accounts/)
    expect(() => partyKey(env, 'worker')).toThrow(/distinct accounts/)
  })

  it('still reads one party on a box that holds only that party key', () => {
    const { DUSK_WORKER_PRIVATE_KEY: _w, ...buyerOnly } = COMPLETE_ENV
    expect(partyKey(buyerOnly, 'buyer')).toBe(COMPLETE_ENV.DUSK_BUYER_PRIVATE_KEY)

    const { DUSK_BUYER_PRIVATE_KEY: _b, ...workerOnly } = COMPLETE_ENV
    expect(partyKey(workerOnly, 'worker')).toBe(COMPLETE_ENV.DUSK_WORKER_PRIVATE_KEY)
  })

  it('ignores a malformed other-party key rather than reporting it as a collision', () => {
    expect(
      partyKey({ ...COMPLETE_ENV, DUSK_WORKER_PRIVATE_KEY: 'not-a-key' }, 'buyer'),
    ).toBe(COMPLETE_ENV.DUSK_BUYER_PRIVATE_KEY)
  })
})

describe('galileoChain', () => {
  it('builds a viem Chain from config rather than a hardcoded one', () => {
    const c = loadConfig(COMPLETE_ENV)
    const chain = galileoChain(c.escrow)
    expect(chain.id).toBe(c.escrow.chainId)
    expect(chain.rpcUrls.default.http[0]).toBe(c.escrow.rpc)
  })

  it('reflects a configured override, not the OG_GALILEO_* default', () => {
    const chain = galileoChain({ chainId: 99999, rpc: 'https://example.invalid' })
    expect(chain.id).toBe(99999)
    expect(chain.rpcUrls.default.http[0]).toBe('https://example.invalid')
  })
})

describe('loadConfig — image models', () => {
  it('defaults imageModels to z-image-turbo and imageSize to 1024x1024', () => {
    const c = loadConfig(COMPLETE_ENV)
    expect(c.og.imageModels).toEqual(['z-image-turbo'])
    expect(c.og.imageSize).toBe('1024x1024')
  })
  it('reads DUSK_IMAGE_MODELS as a comma list', () => {
    const c = loadConfig({ ...COMPLETE_ENV, DUSK_IMAGE_MODELS: ' z-image-turbo, minimax-image-01 ,' })
    expect(c.og.imageModels).toEqual(['z-image-turbo', 'minimax-image-01'])
  })
  it('refuses a malformed DUSK_IMAGE_SIZE', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_IMAGE_SIZE: 'huge' })).toThrow(/DUSK_IMAGE_SIZE/)
  })
})

describe('loadConfig — TEE proof (client-side sealing)', () => {
  it('is on by default, against 0G mainnet and the router behind the gateway', () => {
    const t = loadConfig(COMPLETE_ENV).og.teeProof
    expect(t.enabled).toBe(true)
    expect(t.routerUrl).toBe('https://router-api-cloud.0g.ai')
    expect(t.rpc).toBe('https://evmrpc.0g.ai')
    expect(t.servingContract).toBe('0x47340d900bdFec2BD393c626E12ea0656F938d84')
  })

  it('can be switched off', () => {
    expect(loadConfig({ ...COMPLETE_ENV, DUSK_TEE_PROOF: '0' }).og.teeProof.enabled).toBe(false)
  })

  it('refuses a malformed serving contract address', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, OG_SERVING_CONTRACT: '0x123' })).toThrow(/OG_SERVING_CONTRACT/)
  })
})

describe('loadConfig — verifier-gated payment', () => {
  it('defaults the challenge window to 600s, long enough for the verifier to check a proof', () => {
    expect(loadConfig(COMPLETE_ENV).escrow.challengeWindowSec).toBe(600)
  })
  it('reads the verifier address, and refuses a malformed one', () => {
    const v = '0x'.padEnd(42, 'd')
    expect(loadConfig({ ...COMPLETE_ENV, DUSK_VERIFIER_ADDRESS: v }).escrow.verifier).toBe(v)
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_VERIFIER_ADDRESS: '0x1' })).toThrow(/DUSK_VERIFIER_ADDRESS/)
  })
})

describe('loadConfig — chat attachments', () => {
  it('sets input limits', () => {
    const c = loadConfig(COMPLETE_ENV)
    expect(c.input.maxBytes).toBe(4_000_000)
    expect(c.input.maxAttachments).toBe(4)
    expect(c.input.maxImagePx).toBe(1568)
  })
  it('reads the input limits', () => {
    const c = loadConfig({ ...COMPLETE_ENV, DUSK_INPUT_MAX_BYTES: '1000', DUSK_INPUT_MAX_ATTACHMENTS: '2', DUSK_INPUT_MAX_IMAGE_PX: '512' })
    expect(c.input).toEqual({ maxBytes: 1000, maxAttachments: 2, maxImagePx: 512 })
  })
  it('refuses a limit that is not a positive whole number', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_INPUT_MAX_BYTES: '0' })).toThrow(/DUSK_INPUT_MAX_BYTES/)
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_INPUT_MAX_ATTACHMENTS: '1.5' })).toThrow(/DUSK_INPUT_MAX_ATTACHMENTS/)
  })
  it('refuses a byte limit over the 20 MiB the Router accepts, which base64 inflates toward', () => {
    expect(() => loadConfig({ ...COMPLETE_ENV, DUSK_INPUT_MAX_BYTES: String(20 * 1024 * 1024) })).toThrow(/20 MiB/)

  })
})
