import { describe, expect, it } from 'vitest'
import { ConfigError } from '@dusk/core'
import { browserArkivAccessKey, browserClock, browserConfig, browserFallbackAddress, PUBLIC_CONFIG_NAMES } from '../src/lib/config'

const minimal = { NEXT_PUBLIC_OG_BASE_URL: 'https://router-api.0g.ai' }

describe('browserConfig', () => {
  it('builds a DuskConfig from NEXT_PUBLIC_ names', () => {
    const config = browserConfig({
      ...minimal,
      NEXT_PUBLIC_ARKIV_CHAIN_ID: '7794095',
      NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS: '300',
    })

    expect(config.og.baseUrl).toBe('https://router-api.0g.ai')
    expect(config.arkiv.chainId).toBe(7794095)
    expect(config.clock).toEqual({ resetAt: { everySeconds: 300 } })
  })

  it('cannot see an unprefixed variable, even one it would otherwise want', () => {
    expect(() => browserConfig({ OG_BASE_URL: 'https://router-api.0g.ai' })).toThrow(ConfigError)
  })

  it('names the NEXT_PUBLIC_ variable in the error, not the server-side one', () => {
    expect(() => browserConfig({})).toThrow(/NEXT_PUBLIC_OG_BASE_URL/)
  })

  it('drops a server secret handed to it alongside the public values', () => {
    const config = browserConfig({
      ...minimal,
      OG_INFERE_MAIN: 'sk-not-a-real-key-but-shaped-like-one',
      OG_MANAGE_MAIN: 'mk-not-a-real-key-either',
      ARKIV_PRIVATE_KEY: '0x1111111111111111111111111111111111111111111111111111111111111111',
      GALILEO_PRIVATE_KEY: '0x2222222222222222222222222222222222222222222222222222222222222222',
    })

    const serialised = JSON.stringify(config)
    expect(serialised).not.toMatch(/\b(sk|mk)-/)
    expect(serialised).not.toMatch(/1111111111/)
    expect(serialised).not.toMatch(/2222222222/)
  })

  it('ignores a NEXT_PUBLIC_ name outside the allowlist, so prefixing a key does not publish it into the config', () => {
    const config = browserConfig({
      ...minimal,
      NEXT_PUBLIC_GALILEO_PRIVATE_KEY: '0x3333333333333333333333333333333333333333333333333333333333333333',
    })

    expect(JSON.stringify(config)).not.toMatch(/3333333333/)
  })

  it('refuses to start at all if a public value is key-shaped, without echoing it', () => {
    let thrown: unknown
    try {
      browserConfig({ NEXT_PUBLIC_OG_BASE_URL: 'sk-pasted-into-the-wrong-variable' })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(ConfigError)
    expect(String((thrown as Error).message)).not.toMatch(/\b(sk|mk)-/)
    expect(String((thrown as Error).message)).toMatch(/NEXT_PUBLIC_OG_BASE_URL/)
  })

  it('allowlists no name that could hold a key or a private key', () => {
    for (const name of PUBLIC_CONFIG_NAMES) {
      expect(name).not.toMatch(/PRIVATE_KEY|_INFERE|_MANAGE|SECRET|MNEMONIC/)
    }
  })
})

describe('browserClock', () => {
  it('counts to 00:00 UTC with nothing configured, because the countdown is the product', () => {
    expect(browserClock({})).toEqual({ resetAt: 'daily-utc-midnight' })
  })

  it('honours a compressed demo day', () => {
    expect(browserClock({ NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS: '300' })).toEqual({
      resetAt: { everySeconds: 300 },
    })
  })

  it('validates through loadConfig rather than a second copy of the parsing', () => {
    expect(() => browserClock({ NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS: '0' })).toThrow(
      /NEXT_PUBLIC_DUSK_CLOCK_EVERY_SECONDS/,
    )
  })

  it('still refuses a key-shaped public value', () => {
    expect(() => browserClock({ NEXT_PUBLIC_ARKIV_RPC: 'sk-oops' })).toThrow(ConfigError)
  })
})

describe('browserArkivAccessKey', () => {
  it('reads the published quota key', () => {
    expect(browserArkivAccessKey({ NEXT_PUBLIC_ARKIV_ACCESS_KEY: 'hub-quota-key' })).toBe('hub-quota-key')
  })

  it('is undefined when unset, so the app falls back to the anonymous budget rather than failing', () => {
    expect(browserArkivAccessKey({})).toBeUndefined()
    expect(browserArkivAccessKey({ NEXT_PUBLIC_ARKIV_ACCESS_KEY: '' })).toBeUndefined()
    expect(browserArkivAccessKey({ NEXT_PUBLIC_ARKIV_ACCESS_KEY: '  ' })).toBeUndefined()
  })

  it('cannot see the unprefixed ARKIV_ACCESS_KEY, which is the server-side one', () => {
    expect(browserArkivAccessKey({ ARKIV_ACCESS_KEY: 'hub-quota-key' })).toBeUndefined()
  })

  it('refuses a 0G key pasted into it, and does not echo the value', () => {
    let thrown: unknown
    try {
      browserArkivAccessKey({ NEXT_PUBLIC_ARKIV_ACCESS_KEY: 'sk-pasted-into-the-wrong-variable' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect(String((thrown as Error).message)).not.toMatch(/\b(sk|mk)-/)
    expect(String((thrown as Error).message)).not.toMatch(/pasted-into/)
  })

  it('is not on PUBLIC_CONFIG_NAMES, because it is a credential and not a DuskConfig field', () => {
    expect(PUBLIC_CONFIG_NAMES).not.toContain('ARKIV_ACCESS_KEY')
  })
})

describe('browserConfig — image models', () => {
  it('defaults imageModels to z-image-turbo', () => {
    expect(browserConfig({ NEXT_PUBLIC_OG_BASE_URL: 'https://router.example' }).og.imageModels).toEqual([
      'z-image-turbo',
    ])
  })

  it('reads NEXT_PUBLIC_DUSK_IMAGE_MODELS and NEXT_PUBLIC_DUSK_IMAGE_SIZE', () => {
    const c = browserConfig({
      NEXT_PUBLIC_OG_BASE_URL: 'https://router.example',
      NEXT_PUBLIC_DUSK_IMAGE_MODELS: 'z-image-turbo,minimax-image-01',
      NEXT_PUBLIC_DUSK_IMAGE_SIZE: '768x768',
    })
    expect(c.og.imageModels).toEqual(['z-image-turbo', 'minimax-image-01'])
    expect(c.og.imageSize).toBe('768x768')
  })

  it('refuses a key-shaped image model list without echoing it', () => {
    let thrown: unknown
    try {
      browserConfig({ NEXT_PUBLIC_OG_BASE_URL: 'https://router.example', NEXT_PUBLIC_DUSK_IMAGE_MODELS: 'sk-oops-123' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect(String((thrown as Error).message)).not.toMatch(/\b(sk|mk)-/)
  })
})

describe('browserFallbackAddress', () => {
  it('is unset by default and validated when set', () => {
    expect(browserFallbackAddress({})).toBeUndefined()
    expect(browserFallbackAddress({ NEXT_PUBLIC_DUSK_FALLBACK_ADDRESS: `0x${'ab'.repeat(20)}` })).toBe(`0x${'ab'.repeat(20)}`)
    expect(() => browserFallbackAddress({ NEXT_PUBLIC_DUSK_FALLBACK_ADDRESS: 'nope' })).toThrow(/FALLBACK/)
  })
})
