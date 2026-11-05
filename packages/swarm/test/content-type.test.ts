import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSwarmStore } from '../src/client'

afterEach(() => vi.unstubAllGlobals())

function capture(): Array<Record<string, string>> {
  const headers: Array<Record<string, string>> = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
    headers.push(init.headers as Record<string, string>)
    return new Response(JSON.stringify({ reference: 'ab'.repeat(32) }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  })
  return headers
}

const store = () => createSwarmStore({ uploadUrl: 'https://up.example', downloadUrl: 'https://down.example' })

describe('SwarmStore.upload content type', () => {
  it('sends the given content type', async () => {
    const sent = capture()
    await store().upload(new Uint8Array([0xff, 0xd8, 0xff]), { contentType: 'image/jpeg' })
    expect(sent[0]!['Content-Type']).toBe('image/jpeg')
  })

  it('still sends application/octet-stream when none is given', async () => {
    const sent = capture()
    await store().upload(new Uint8Array([1, 2, 3]))
    expect(sent[0]!['Content-Type']).toBe('application/octet-stream')
  })
})
