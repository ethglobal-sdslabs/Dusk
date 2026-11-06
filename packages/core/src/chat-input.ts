import { sniffImage, type ImageContentType } from './image'
import type { ContentPart } from './types'

export const CHAT_INPUT_MARKER = 'input/v2'

const IMAGE_TYPES: readonly ImageContentType[] = ['image/png', 'image/jpeg', 'image/webp']

export type ChatAttachment =
  | { kind: 'image'; name: string; mime: ImageContentType; data: string }
  | { kind: 'text'; name: string; text: string }

export type ChatInput = { text: string; attachments: ChatAttachment[] }

export class ChatInputError extends Error {
  constructor(detail: string) {
    super(`This job's input is not usable: ${detail}. Nothing was run.`)
    this.name = 'ChatInputError'
  }
}

export function encodeChatInput(input: ChatInput): string {
  if (input.attachments.length === 0) return input.text
  return JSON.stringify({ dusk: CHAT_INPUT_MARKER, text: input.text, attachments: input.attachments })
}

export function parseChatInput(raw: string): ChatInput {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { text: raw, attachments: [] }
  }
  if (typeof v !== 'object' || v === null || (v as Record<string, unknown>)['dusk'] !== CHAT_INPUT_MARKER) {
    return { text: raw, attachments: [] }
  }
  const o = v as Record<string, unknown>
  if (typeof o['text'] !== 'string') throw new ChatInputError('the message text is missing')
  if (!Array.isArray(o['attachments'])) throw new ChatInputError('the attachments are not a list')
  return { text: o['text'], attachments: o['attachments'].map(attachmentOf) }
}

function attachmentOf(value: unknown, i: number): ChatAttachment {
  if (typeof value !== 'object' || value === null) throw new ChatInputError(`attachment ${i + 1} is not an object`)
  const a = value as Record<string, unknown>
  const name = typeof a['name'] === 'string' ? a['name'].trim() : ''
  if (name === '') throw new ChatInputError(`attachment ${i + 1} has no name`)
  if (a['kind'] === 'image') {
    const mime = a['mime']
    if (typeof mime !== 'string' || !IMAGE_TYPES.includes(mime as ImageContentType)) {
      throw new ChatInputError(`${name} is not a PNG, JPEG or WebP image`)
    }
    if (typeof a['data'] !== 'string' || a['data'] === '') throw new ChatInputError(`${name} carries no image data`)
    return { kind: 'image', name, mime: mime as ImageContentType, data: a['data'] }
  }
  if (a['kind'] === 'text') {
    if (typeof a['text'] !== 'string') throw new ChatInputError(`${name} carries no text`)
    return { kind: 'text', name, text: a['text'] }
  }
  throw new ChatInputError(`${name} is of a kind this worker does not read`)
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const bin = atob(data)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export type ChatInputLimits = {
  maxBytes: number
  maxAttachments: number
}

export function checkChatInput(
  input: ChatInput,
  opts: ChatInputLimits & {
    model: string
    visionModels: readonly string[] | undefined
  },
): void {
  if (input.text.trim() === '' && input.attachments.length === 0) {
    throw new ChatInputError('there is no message and nothing attached')
  }
  if (input.attachments.length > opts.maxAttachments) {
    throw new ChatInputError(`at most ${opts.maxAttachments} attachments are allowed, and this has ${input.attachments.length}`)
  }
  const size = new TextEncoder().encode(encodeChatInput(input)).length
  if (size > opts.maxBytes) {
    throw new ChatInputError(`it is ${size} bytes and the limit is ${opts.maxBytes}`)
  }
  for (const a of input.attachments) {
    if (a.kind !== 'image') continue
    if (opts.visionModels !== undefined && !opts.visionModels.includes(opts.model)) {
      throw new ChatInputError(`${opts.model} does not take images, and ${a.name} is one`)
    }
    const bytes = decodeBase64(a.data)
    if (bytes === null) throw new ChatInputError(`${a.name} is not valid base64`)
    const actual = sniffImage(bytes)
    if (actual === null) throw new ChatInputError(`${a.name} is not an image`)
    if (actual !== a.mime) throw new ChatInputError(`${a.name} says ${a.mime} but its bytes are ${actual}`)
  }
}

export function chatContent(input: ChatInput): string | ContentPart[] {
  if (input.attachments.length === 0) return input.text
  const parts: ContentPart[] = []
  if (input.text.trim() !== '') parts.push({ type: 'text', text: input.text })
  for (const a of input.attachments) {
    if (a.kind === 'text') parts.push({ type: 'text', text: `[File: ${a.name}]\n${a.text}\n[End of file: ${a.name}]` })
  }
  for (const a of input.attachments) {
    if (a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } })
  }
  return parts
}
