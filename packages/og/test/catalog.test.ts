import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { imageInputModels, parseCatalog, textOutputModels, trustTier } from '../src/catalog'

const body = JSON.parse(readFileSync(new URL('./fixtures/models.json', import.meta.url), 'utf8')) as unknown

describe('parseCatalog', () => {
  it('reads each model’s input and output modalities', () => {
    const vl = parseCatalog(body).find((m) => m.id === 'qwen2.5-vl-72b-instruct')
    expect(vl).toMatchObject({ id: 'qwen2.5-vl-72b-instruct', inputModalities: ['text', 'image'], outputModalities: ['text'] })
  })
  it('reads the list price: neuron per token as a bigint, USD per token as a number', () => {
    const m = parseCatalog(body).find((x) => x.id === '0gm-1.0-35b-a3b')
    expect(m?.pricing).toEqual({
      inNeuronPerToken: 548_000_000_000n,
      outNeuronPerToken: 3_290_000_000_000n,
      inUsdPerToken: 0.00000008,
      outUsdPerToken: 0.00000048,
    })
  })
  it('reads a per-image price', () => {
    const m = parseCatalog(body).find((x) => x.id === 'z-image-turbo')
    expect(m?.pricing?.perImageNeuron).toBe(60_411_340_000_000_000n)
    expect(m?.pricing?.perImageUsd).toBe(0.0088)
  })
  it('leaves out a price that is missing or not a whole number, rather than guessing', () => {
    const [m] = parseCatalog({ data: [{ id: 'x', pricing: { prompt: '1.5', completion: 'abc' }, pricing_usd: { prompt: 'nope' } }] })
    expect(m?.pricing).toBeUndefined()
  })
  it('skips an entry with no id, and survives one with no architecture', () => {
    const models = parseCatalog({ data: [{}, { id: 'bare' }] })
    expect(models).toEqual([{ id: 'bare', inputModalities: [], outputModalities: [] }])
  })
  it('is empty for anything that is not a catalog', () => {
    expect(parseCatalog(null)).toEqual([])
    expect(parseCatalog({ data: 'no' })).toEqual([])
  })
})

describe('imageInputModels', () => {
  it('names the models that take an image and answer in text', () => {
    expect(imageInputModels(parseCatalog(body)).sort()).toEqual(['0gm-1.0-35b-a3b', 'qwen2.5-vl-72b-instruct'])
  })
})

describe('textOutputModels', () => {
  it('names the chat models — not the image generator, not the embedder', () => {
    expect(textOutputModels(parseCatalog(body)).sort()).toEqual([
      '0gm-1.0-35b-a3b',
      'qwen2.5-vl-72b-instruct',
      'qwen3-coder-flash',
    ])
  })
})

describe('trustTier', () => {
  it('reads TeeML as private, TeeTLS as verified, nothing as standard', () => {
    const [ml, tls, none] = parseCatalog({
      data: [
        { id: 'a', verifiability: 'TeeML' },
        { id: 'b', verifiability: 'TeeTLS' },
        { id: 'c' },
      ],
    })
    expect([trustTier(ml!), trustTier(tls!), trustTier(none!)]).toEqual(['private', 'verified', 'standard'])
  })
  it('does not promote an unknown label above standard', () => {
    const [m] = parseCatalog({ data: [{ id: 'x', verifiability: 'SomethingNew' }] })
    expect(trustTier(m!)).toBe('standard')
  })
  it('keeps the raw label on the parsed model', () => {
    expect(parseCatalog(body).find((m) => m.id === '0gm-1.0-35b-a3b')?.verifiability).toBe('TeeML')
    expect(parseCatalog(body).find((m) => m.id === 'qwen3-coder-flash')?.verifiability).toBeUndefined()
  })
})
