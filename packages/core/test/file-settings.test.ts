import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { applyCredentials, credentialEnv, parseCredentials, parseCredentialsJson } from '../src/credentials'
import { publicSettingsEnv } from '../src/file-settings'
import { loadEnsConfig } from '../../ens/src/config'

const controller = '0x1111111111111111111111111111111111111111'
const registry = '0x2222222222222222222222222222222222222222'
const resolver = '0x3333333333333333333333333333333333333333'
const key = `0x${'ab'.repeat(32)}`

describe('config.json runtime settings', () => {
  const file = {
    og: { baseUrl: 'https://router-api.0g.ai', models: ['text', 'image'] },
    arkiv: { chainId: 7794095, accessKey: 'public-hub-access' },
    escrow: { address: controller, challengeWindowSec: 600 },
    ens: { mode: 'enrollment', chainId: 11155111, controllerAddress: controller, registryAddress: registry, universalResolver: resolver },
    operators: { ensRevokerPrivateKey: key },
  }

  it('configures the app and ENS without an environment file', () => {
    const credentials = parseCredentials(file)
    const env = credentialEnv(credentials)
    expect(loadConfig(env).og.baseUrl).toBe(file.og.baseUrl)
    expect(loadConfig(env).escrow.address).toBe(controller)
    expect(loadEnsConfig(env)).toMatchObject({ mode: 'enrollment', controller, registry, universalResolver: resolver })
    expect(env.ENS_REVOKER_PRIVATE_KEY).toBe(key)
  })

  it('publishes only public settings, never an operator or party key', () => {
    const credentials = parseCredentials({ ...file, buyer: { privateKey: key }, og: { ...file.og, computeKey: 'sk-secret', accessKey: 'mk-secret' } })
    const published = publicSettingsEnv(credentials.settings)
    expect(published).toMatchObject({ NEXT_PUBLIC_ENS_CONTROLLER_ADDRESS: controller, NEXT_PUBLIC_DUSK_MODELS: 'text,image', NEXT_PUBLIC_OG_BASE_URL: file.og.baseUrl })
    expect(Object.keys(published).some((name) => /PRIVATE_KEY|INFERE|MANAGE/.test(name))).toBe(false)
    expect(JSON.stringify(published)).not.toMatch(/sk-secret|mk-secret|abababab/)
  })

  it('uses config.json attachment limits in both headless and public browser settings', () => {
    const input = { maxBytes: 2000000, maxAttachments: 2, maxImagePx: 1024 }
    const credentials = parseCredentials({ ...file, input })
    expect(loadConfig(credentialEnv(credentials)).input).toEqual(input)
    expect(publicSettingsEnv(credentials.settings)).toMatchObject({
      NEXT_PUBLIC_DUSK_INPUT_MAX_BYTES: '2000000',
      NEXT_PUBLIC_DUSK_INPUT_MAX_ATTACHMENTS: '2',
      NEXT_PUBLIC_DUSK_INPUT_MAX_IMAGE_PX: '1024',
    })
  })

  it('overrides stale settings with the file', () => {
    const env = { ENS_MODE: 'off', DUSK_ESCROW_ADDRESS: resolver, OG_BASE_URL: 'https://stale-testnet.example' }
    applyCredentials(parseCredentials(file), env)
    expect(env.ENS_MODE).toBe('enrollment')
    expect(env.DUSK_ESCROW_ADDRESS).toBe(controller)
    expect(loadConfig(env).og.baseUrl).toBe(file.og.baseUrl)
  })

  it('clears a stale legacy setting when the field is explicitly blank', () => {
    const env = { ENS_CHILD_REGISTRY: controller }
    applyCredentials(parseCredentials({ ens: { childRegistry: '' } }), env)
    expect(env.ENS_CHILD_REGISTRY).toBe('')
  })

  it('leaves a non-ENS .env value alone when its config.json field is blank', () => {
    const env = { ARKIV_ACCESS_KEY: 'from-dotenv' }
    applyCredentials(parseCredentials({ arkiv: { accessKey: '' } }), env)
    expect(env.ARKIV_ACCESS_KEY).toBe('from-dotenv')
  })

  it('keeps legitimate 32-byte public Swarm batch identifiers', () => {
    expect(publicSettingsEnv({ SWARM_BATCH_ID: 'ab'.repeat(32) }).NEXT_PUBLIC_SWARM_BATCH_ID).toBe('ab'.repeat(32))
  })

  it('rejects unknown settings and malformed operator keys without exposing values', () => {
    expect(() => parseCredentials({ ens: { controlerAddress: controller } })).toThrow(/controlerAddress/)
    const bad = 'sk-do-not-print-this'
    try {
      parseCredentials({ operators: { ensOwnerPrivateKey: bad } })
      throw new Error('expected validation to fail')
    } catch (error) {
      expect(String(error)).toContain('operators.ensOwnerPrivateKey')
      expect(String(error)).not.toContain(bad)
    }
  })

  it('does not echo credentials in malformed JSON diagnostics', () => {
    const bad = `{"operators":{"ensOwnerPrivateKey":"${key}"}, broken}`
    expect(() => parseCredentialsJson(bad)).toThrow(/not valid JSON/)
    expect(() => parseCredentialsJson(bad)).not.toThrow(new RegExp(key))
  })
})
