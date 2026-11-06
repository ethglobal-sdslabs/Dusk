import { describe, expect, it } from 'vitest'
import { ConfigError, type ModelInfo } from '@dusk/core'
import { jobTrustMode } from '../src/lib/model-groups'
import { browserModels, DEFAULT_MODELS } from '../src/lib/config'

describe('browserModels', () => {
  it('offers the one model Dusk has actually served when nothing is configured', () => {
    expect(browserModels({})).toEqual(['0gm-1.0-35b-a3b'])
    expect(DEFAULT_MODELS).toEqual(['0gm-1.0-35b-a3b'])
  })

  it('reads a comma-separated list', () => {
    expect(browserModels({ NEXT_PUBLIC_DUSK_MODELS: 'a-model, b-model ,c-model' })).toEqual([
      'a-model',
      'b-model',
      'c-model',
    ])
  })

  it('drops duplicates, keeping the first position', () => {
    expect(browserModels({ NEXT_PUBLIC_DUSK_MODELS: 'a, b, a' })).toEqual(['a', 'b'])
  })

  it('falls back to the default rather than returning an empty list', () => {
    expect(browserModels({ NEXT_PUBLIC_DUSK_MODELS: '' })).toEqual([...DEFAULT_MODELS])
    expect(browserModels({ NEXT_PUBLIC_DUSK_MODELS: ' , , ' })).toEqual([...DEFAULT_MODELS])
  })

  it('refuses a key-shaped value', () => {
    expect(() => browserModels({ NEXT_PUBLIC_DUSK_MODELS: 'sk-not-a-model-id' })).toThrow(
      ConfigError,
    )
  })
})

describe('jobTrustMode — when a job asks for a TEE proof', () => {
  const cat = [
    { id: 'tee-model', verifiability: 'TeeML' },
    { id: 'tls-model', verifiability: 'TeeTLS' },
    { id: 'plain-model', verifiability: '' },
  ] as unknown as ModelInfo[]

  it('asks for a proof (private tier) on a TeeML model', () => {
    expect(jobTrustMode('tee-model', cat, false)).toBe('private')
  })

  // A proof needs a TeeML enclave; asking for one elsewhere would leave the job unservable
  // by any proving worker and refunded by the verifier.
  it('stays standard on any other model', () => {
    expect(jobTrustMode('tls-model', cat, false)).toBe('standard')
    expect(jobTrustMode('plain-model', cat, false)).toBe('standard')
    expect(jobTrustMode('not-in-catalog', cat, false)).toBe('standard')
  })

  it('stays standard while the catalog is unread, and for image jobs', () => {
    expect(jobTrustMode('tee-model', null, false)).toBe('standard')
    expect(jobTrustMode('tee-model', cat, true)).toBe('standard')
  })
})
