import { describe, expect, it } from 'vitest'
import {
  imageJobInput,
  ImageInputError,
  isImageModel,
  parseImageJobInput,
  refuseImageModels,
  sniffImage,
} from '../src/image'
import { ConfigError } from '../src/config'

const DEFAULT = ['z-image-turbo']

describe('isImageModel', () => {
  it('is true for z-image-turbo against the default list', () => {
    expect(isImageModel('z-image-turbo', DEFAULT)).toBe(true)
  })
  it('is false for the text model', () => {
    expect(isImageModel('0gm-1.0-35b-a3b', DEFAULT)).toBe(false)
  })
  it('is case-sensitive, as model ids are', () => {
    expect(isImageModel('Z-Image-Turbo', DEFAULT)).toBe(false)
  })
})

describe('imageJobInput / parseImageJobInput', () => {
  it('writes the exact v1 JSON blob', () => {
    expect(imageJobInput('a cat', '1024x1024')).toBe('{"v":1,"prompt":"a cat","size":"1024x1024"}')
  })
  it('round-trips', () => {
    expect(parseImageJobInput(imageJobInput('a cat', '1024x1024'))).toEqual({
      prompt: 'a cat',
      size: '1024x1024',
    })
  })
  it.each([
    ['plain text', 'a cat'],
    ['a future version', '{"v":2,"prompt":"a cat","size":"1024x1024"}'],
    ['a missing prompt', '{"v":1,"size":"1024x1024"}'],
    ['an empty prompt', '{"v":1,"prompt":"  ","size":"1024x1024"}'],
    ['a malformed size', '{"v":1,"prompt":"a cat","size":"big"}'],
    ['a JSON array', '[1,2]'],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseImageJobInput(raw)).toThrow(ImageInputError)
  })
})

describe('sniffImage', () => {
  const bytes = (...b: number[]) => new Uint8Array(b)
  it('knows PNG', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png')
  })
  it('knows JPEG — what z-image-turbo actually returns', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image/jpeg')
  })
  it('knows WebP', () => {
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect(sniffImage(webp)).toBe('image/webp')
  })
  it('refuses HTML', () => {
    expect(sniffImage(new TextEncoder().encode('<html><body>gateway</body></html>'))).toBeNull()
  })
  it('refuses empty bytes', () => {
    expect(sniffImage(new Uint8Array())).toBeNull()
  })
})

describe('refuseImageModels', () => {
  it('throws a ConfigError naming the image model', () => {
    expect(() => refuseImageModels(['0gm-1.0-35b-a3b', 'z-image-turbo'], DEFAULT)).toThrow(ConfigError)
    expect(() => refuseImageModels(['0gm-1.0-35b-a3b', 'z-image-turbo'], DEFAULT)).toThrow(
      /z-image-turbo.*\/earn/s,
    )
  })
  it('lets a text-only list through', () => {
    expect(() => refuseImageModels(['0gm-1.0-35b-a3b'], DEFAULT)).not.toThrow()
  })
})
