import { ConfigError } from './config'

export function isImageModel(model: string, imageModels: readonly string[]): boolean {
  return imageModels.includes(model)
}

export function imageJobInput(prompt: string, size: string): string {
  return JSON.stringify({ v: 1, prompt, size })
}

export class ImageInputError extends Error {
  constructor(detail: string) {
    super(`This image job's input is not usable: ${detail}. Nothing was generated.`)
    this.name = 'ImageInputError'
  }
}

export const IMAGE_SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/

export function parseImageJobInput(raw: string): { prompt: string; size: string } {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new ImageInputError('it is not JSON — a text prompt was posted against an image model')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ImageInputError('it is not an object')
  const o = v as Record<string, unknown>
  if (o['v'] !== 1) throw new ImageInputError(`version ${JSON.stringify(o['v'])} is not one this worker reads`)
  const prompt = typeof o['prompt'] === 'string' ? o['prompt'] : ''
  if (prompt.trim() === '') throw new ImageInputError('the prompt is empty')
  const size = typeof o['size'] === 'string' ? o['size'] : ''
  if (!IMAGE_SIZE_PATTERN.test(size)) throw new ImageInputError(`size ${JSON.stringify(o['size'])} is not WIDTHxHEIGHT`)
  return { prompt, size }
}

export type ImageContentType = 'image/png' | 'image/jpeg' | 'image/webp'

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0): boolean =>
  bytes.length >= at + sig.length && sig.every((b, i) => bytes[at + i] === b)

export function sniffImage(bytes: Uint8Array): ImageContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return null
}

export function refuseImageModels(models: readonly string[], imageModels: readonly string[]): void {
  const images = models.filter((m) => isImageModel(m, imageModels))
  if (images.length > 0) {
    throw new ConfigError(
      `${images.join(', ')} ${images.length === 1 ? 'is an image model' : 'are image models'}. ` +
        'The headless worker serves text models only; image jobs are served from the /earn ' +
        'page. Remove it from DUSK_MODELS / DUSK_TRUSTED_MODELS.',
    )
  }
}
