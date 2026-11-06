import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ImageJobError, parseImagePoll, parseImageSubmit } from '../src/image-parse'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const completed = fixture('image-poll-completed.json') as {
  data: { data: Array<Record<string, unknown>> }
}

describe('parseImageSubmit', () => {
  it('reads jobId and provider address from the 202 body', () => {
    expect(parseImageSubmit(fixture('image-submit-202.json'))).toEqual({
      jobId: 'be0f9f8c-1f2d-45b7-a392-62d68fb1edd0',
      providerAddress: '0x59E598DB6E8c63D7fEeB64a69De36510a221C762',
    })
  })

  it('refuses a 202 body with no job id', () => {
    expect(() => parseImageSubmit({ status: 'pending' })).toThrow(ImageJobError)
  })
})

describe('parseImagePoll', () => {
  it('reads a pending poll as pending', () => {
    expect(parseImagePoll(fixture('image-poll-pending.json'), 'z-image-turbo')).toEqual({
      state: 'pending',
    })
  })

  it('treats any non-terminal status as pending', () => {
    expect(parseImagePoll({ status: 'processing' }, 'z-image-turbo')).toEqual({ state: 'pending' })
    expect(parseImagePoll({ status: 'queued' }, 'z-image-turbo')).toEqual({ state: 'pending' })
  })

  it('decodes a completed poll into JPEG bytes', () => {
    const r = parseImagePoll(fixture('image-poll-completed.json'), 'z-image-turbo')
    if (r.state !== 'completed') throw new Error(`expected completed, got ${r.state}`)
    expect([...r.images[0]!.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect(r.outputImages).toBe(1)
    expect(r.modelServed).toBe('z-image-turbo')
  })

  it("carries the Router's own billed cost", () => {
    const r = parseImagePoll(fixture('image-poll-completed.json'), 'z-image-turbo')
    expect(r.state === 'completed' && r.billedUnits).toBe('8800')
  })

  it('omits billedUnits when the trace has none', () => {
    const { x_0g_trace: _t, ...noTrace } = fixture('image-poll-completed.json') as Record<string, unknown>
    const r = parseImagePoll(noTrace, 'z-image-turbo')
    expect(r.state === 'completed' && 'billedUnits' in r).toBe(false)
  })

  it('rejects a completed poll with no b64_json', () => {
    const body = { ...completed, data: { ...completed.data, data: [] } }
    expect(() => parseImagePoll(body, 'z-image-turbo')).toThrow(ImageJobError)
    expect(() => parseImagePoll(body, 'z-image-turbo')).toThrow(/billed/)
  })

  it('rejects a completed poll carrying only a url', () => {
    const body = {
      ...completed,
      data: { ...completed.data, data: [{ b64_json: null, url: 'https://x.example/a.jpg' }] },
    }
    expect(() => parseImagePoll(body, 'z-image-turbo')).toThrow(ImageJobError)
  })

  it('reads a failed poll with its reason', () => {
    expect(
      parseImagePoll({ status: 'failed', error: { message: 'provider out of memory' } }, 'z-image-turbo'),
    ).toEqual({ state: 'failed', reason: 'provider out of memory' })
  })

  it('never echoes a key', () => {
    const r = parseImagePoll(
      { status: 'failed', error: { message: 'Incorrect API key provided: sk-live-abc123' } },
      'z-image-turbo',
    )
    expect(JSON.stringify(r)).not.toMatch(/\b(sk|mk)-/)
  })
})
