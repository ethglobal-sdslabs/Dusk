import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSwarmImage } from '../src/lib/image-view'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const swarmOf = (bytes: Uint8Array) => ({ download: async () => bytes })

afterEach(() => vi.unstubAllGlobals())

describe('loadSwarmImage', () => {
  it('returns an object url typed by the bytes, not by any label', async () => {
    let blob: Blob | undefined
    vi.stubGlobal('URL', { ...URL, createObjectURL: (b: Blob) => ((blob = b), 'blob:fake') })
    const r = await loadSwarmImage(swarmOf(JPEG), 'ab'.repeat(32))
    expect(r).toEqual({ url: 'blob:fake', contentType: 'image/jpeg' })
    expect(blob?.type).toBe('image/jpeg')
  })

  it('throws on bytes that are not an image', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:fake' })
    await expect(
      loadSwarmImage(swarmOf(new TextEncoder().encode('<html>landing page</html>')), 'ab'.repeat(32)),
    ).rejects.toThrow(/not an image/)
  })
})
