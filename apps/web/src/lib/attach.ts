import type { ChatAttachment } from '@dusk/core'

export type FileKind = 'image' | 'text' | 'pdf' | 'unsupported'

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|swift|php|sh|bash|zsh|sql|sol|log|ini|cfg|conf|env\.example)$/i

export function classifyFile(name: string, type: string): FileKind {
  if (/\.pdf$/i.test(name) || type === 'application/pdf') return 'pdf'
  if (IMAGE_EXT.test(name) || ['image/png', 'image/jpeg', 'image/webp'].includes(type)) return 'image'
  if (TEXT_EXT.test(name) || type.startsWith('text/') || type === 'application/json') return 'text'
  return 'unsupported'
}

export class AttachError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachError'
  }
}

export function textAttachment(name: string, bytes: Uint8Array): ChatAttachment {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AttachError(`${name} is not UTF-8 text, so it cannot be attached.`)
  }
  if (text.includes('\u0000')) throw new AttachError(`${name} looks binary, not text, so it cannot be attached.`)
  return { kind: 'text', name, text }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

async function reencodeImage(file: File, maxPx: number): Promise<ChatAttachment> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AttachError(`${file.name} could not be read as an image.`)
  }
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AttachError('This browser cannot draw images, so it cannot attach one.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.85))
  if (!blob) throw new AttachError(`${file.name} could not be re-encoded.`)
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
  return { kind: 'image', name: file.name, mime, data }
}

export async function readAttachment(file: File, opts: { maxImagePx: number }): Promise<ChatAttachment> {
  const kind = classifyFile(file.name, file.type)
  if (kind === 'image') return reencodeImage(file, opts.maxImagePx)
  if (kind === 'text') return textAttachment(file.name, new Uint8Array(await file.arrayBuffer()))
  if (kind === 'pdf') {
    throw new AttachError(`${file.name}: PDFs are not supported yet. Paste the text you need into the message instead.`)
  }
  throw new AttachError(`${file.name}: only PNG, JPEG or WebP images and plain-text files can be attached.`)
}
