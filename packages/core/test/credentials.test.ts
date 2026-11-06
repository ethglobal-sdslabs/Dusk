import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/config'
import { applyCredentials, credentialEnv, parseCredentials } from '../src/credentials'

const BUYER_KEY = `0x${'a'.repeat(64)}` as const
const WORKER_KEY = `0x${'b'.repeat(64)}` as const
const BUYER_ADDRESS = '0x8fd379246834eac74B8419FfdA202CF8051F7A03'
const WORKER_ADDRESS = '0x88f9B82462f6C4bf4a0Fb15e5c3971559a316e7f'

describe('parseCredentials', () => {
  it('reads nothing out of an empty file, which is the "fill it in manually" state', () => {
    expect(parseCredentials({})).toEqual({})
  })

  it('treats an empty string, null and whitespace as unset', () => {
    const parsed = parseCredentials({
      buyer: { privateKey: '', address: '   ' },
      worker: { privateKey: null, address: undefined },
      og: { computeKey: '', accessKey: '' },
    })
    expect(parsed).toEqual({})
  })

  it('reads all six values', () => {
    const parsed = parseCredentials({
      buyer: { privateKey: BUYER_KEY, address: BUYER_ADDRESS },
      worker: { privateKey: WORKER_KEY, address: WORKER_ADDRESS },
      og: { computeKey: 'sk-live-inference', accessKey: 'mk-live-manage' },
    })
    expect(parsed).toEqual({
      buyerPrivateKey: BUYER_KEY,
      buyerAddress: BUYER_ADDRESS,
      workerPrivateKey: WORKER_KEY,
      workerAddress: WORKER_ADDRESS,
      ogComputeKey: 'sk-live-inference',
      ogAccessKey: 'mk-live-manage',
    })
  })

  it('normalises a bare 64-hex private key', () => {
    const parsed = parseCredentials({ buyer: { privateKey: 'a'.repeat(64) } })
    expect(parsed.buyerPrivateKey).toBe(BUYER_KEY)
  })

  it('accepts "sender" as an alias for "worker", since that is what people call it', () => {
    const parsed = parseCredentials({ sender: { privateKey: WORKER_KEY, address: WORKER_ADDRESS } })
    expect(parsed.workerPrivateKey).toBe(WORKER_KEY)
    expect(parsed.workerAddress).toBe(WORKER_ADDRESS)
  })

  it('refuses both "worker" and "sender", rather than silently picking one', () => {
    expect(() =>
      parseCredentials({ worker: { privateKey: WORKER_KEY }, sender: { privateKey: BUYER_KEY } }),
    ).toThrow(/worker.*sender|sender.*worker/s)
  })

  it('names an unknown field instead of ignoring it', () => {
    expect(() => parseCredentials({ buyer: { privatekey: BUYER_KEY } })).toThrow(/privatekey/)
    expect(() => parseCredentials({ buyerPrivateKey: BUYER_KEY })).toThrow(/buyerPrivateKey/)
  })

  it('rejects a malformed private key by its defect, never echoing the value', () => {
    const bad = `0x${'a'.repeat(63)}`
    const run = () => parseCredentials({ buyer: { privateKey: bad } })
    expect(run).toThrow(ConfigError)
    expect(run).toThrow(/63 hex characters/)
    expect(run).not.toThrow(new RegExp(bad))
  })

  it('rejects a malformed wallet address', () => {
    expect(() => parseCredentials({ buyer: { address: '0xnope' } })).toThrow(/buyer.*address/s)
  })

  it('refuses an address that is not the one its private key owns', () => {
    const run = () => parseCredentials({ buyer: { privateKey: BUYER_KEY, address: WORKER_ADDRESS } })
    expect(run).toThrow(ConfigError)
    expect(run).toThrow(/buyer/)
  })

  it('accepts an address that matches its key regardless of checksum casing', () => {
    const parsed = parseCredentials({
      buyer: { privateKey: BUYER_KEY, address: BUYER_ADDRESS.toLowerCase() },
    })
    expect(parsed.buyerAddress?.toLowerCase()).toBe(BUYER_ADDRESS.toLowerCase())
  })

  it('refuses a 0G API key in a private-key slot', () => {
    expect(() => parseCredentials({ worker: { privateKey: 'sk-live-inference' } })).toThrow(
      /0G API key|inference key/i,
    )
  })

  it('refuses the two 0G keys swapped', () => {
    expect(() => parseCredentials({ og: { computeKey: 'mk-manage' } })).toThrow(/computeKey/)
    expect(() => parseCredentials({ og: { accessKey: 'sk-inference' } })).toThrow(/accessKey/)
  })

  it('refuses a private key in a 0G key slot', () => {
    expect(() => parseCredentials({ og: { computeKey: BUYER_KEY } })).toThrow(/computeKey/)
  })

  it('refuses a file that is not an object', () => {
    expect(() => parseCredentials([])).toThrow(ConfigError)
    expect(() => parseCredentials('sk-oops')).toThrow(ConfigError)
    expect(() => parseCredentials(null)).toThrow(ConfigError)
  })
})

describe('credentialEnv', () => {
  it('maps each field onto the environment variable its consumers already read', () => {
    expect(
      credentialEnv({
        buyerPrivateKey: BUYER_KEY,
        buyerAddress: BUYER_ADDRESS,
        workerPrivateKey: WORKER_KEY,
        workerAddress: WORKER_ADDRESS,
        ogComputeKey: 'sk-live',
        ogAccessKey: 'mk-live',
      }),
    ).toEqual({
      DUSK_BUYER_PRIVATE_KEY: BUYER_KEY,
      DUSK_BUYER_ADDRESS: BUYER_ADDRESS,
      DUSK_WORKER_PRIVATE_KEY: WORKER_KEY,
      DUSK_WORKER_ADDRESS: WORKER_ADDRESS,
      OG_INFERE_MAIN: 'sk-live',
      OG_MANAGE_MAIN: 'mk-live',
    })
  })

  it('emits nothing for an unset field', () => {
    expect(credentialEnv({ ogComputeKey: 'sk-live' })).toEqual({ OG_INFERE_MAIN: 'sk-live' })
  })
})

describe('applyCredentials', () => {
  it('wins over a value already in the environment, because config.json is the source now', () => {
    const env: Record<string, string | undefined> = { OG_INFERE_MAIN: 'sk-stale-from-dotenv' }
    applyCredentials({ ogComputeKey: 'sk-from-config-json' }, env)
    expect(env.OG_INFERE_MAIN).toBe('sk-from-config-json')
  })

  it('leaves an environment value alone when the field is unset, so a legacy .env still works', () => {
    const env: Record<string, string | undefined> = { OG_INFERE_MAIN: 'sk-from-dotenv' }
    applyCredentials({}, env)
    expect(env.OG_INFERE_MAIN).toBe('sk-from-dotenv')
  })
})
