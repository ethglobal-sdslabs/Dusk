import { encodeChatInput, type ChatAttachment } from '@dusk/core'

/**
 * A Dusk job carries ONE prompt string, which the worker sends as a single user message.
 * OpenAI chat requests carry a list of messages, so they are flattened here into a
 * transcript. A lone user message passes through unchanged.
 */

export class RequestError extends Error {
  constructor(
    message: string,
    readonly param?: string,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

type Part = { type?: unknown; text?: unknown; image_url?: unknown }
type Message = { role?: unknown; content?: unknown; name?: unknown }

const ROLE_LABEL: Record<string, string> = {
  system: 'System',
  developer: 'System',
  user: 'User',
  assistant: 'Assistant',
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/

function contentOf(content: unknown, at: string, images: ChatAttachment[]): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new RequestError(`${at}.content must be a string or an array of parts`, at)
  const texts: string[] = []
  content.forEach((raw: Part, j) => {
    const where = `${at}.content[${j}]`
    if (raw?.type === 'text' && typeof raw.text === 'string') {
      texts.push(raw.text)
    } else if (raw?.type === 'image_url') {
      const url = typeof raw.image_url === 'string' ? raw.image_url : (raw.image_url as { url?: unknown })?.url
      const m = typeof url === 'string' ? DATA_URL.exec(url) : null
      if (!m) {
        throw new RequestError(
          `${where}: only base64 data: URLs of PNG, JPEG or WebP images are supported (workers do not fetch remote URLs)`,
          where,
        )
      }
      images.push({ kind: 'image', name: `image-${images.length + 1}`, mime: m[1] as 'image/png', data: m[2]!.replace(/\s+/g, '') })
    } else {
      throw new RequestError(`${where}: unsupported content part type ${JSON.stringify(raw?.type)}`, where)
    }
  })
  return texts.join('\n')
}

export function promptFromMessages(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RequestError('messages must be a non-empty array', 'messages')
  }
  const images: ChatAttachment[] = []
  const turns = messages.map((raw: Message, i) => {
    const at = `messages[${i}]`
    const role = typeof raw?.role === 'string' ? raw.role : ''
    const label = ROLE_LABEL[role]
    if (!label) {
      throw new RequestError(`${at}.role ${JSON.stringify(raw?.role)} is not supported (tool calls are not available on Dusk)`, at)
    }
    return { role, label, text: contentOf(raw.content, at, images) }
  })

  let text: string
  const only = turns[0]!
  if (turns.length === 1 && only.role === 'user') {
    text = only.text
  } else {
    const system = turns.filter((t) => t.label === 'System').map((t) => t.text).filter(Boolean)
    const convo = turns.filter((t) => t.label !== 'System')
    const parts: string[] = []
    if (system.length > 0) parts.push(`Instructions:\n${system.join('\n\n')}`)
    if (convo.length === 1 && convo[0]!.role === 'user') {
      parts.push(convo[0]!.text)
    } else if (convo.length > 0) {
      parts.push(
        'Conversation so far:\n\n' +
          convo.map((t) => `${t.label}: ${t.text}`).join('\n\n') +
          '\n\nWrite the assistant\'s next reply. Output only the reply text, without an "Assistant:" prefix.',
      )
    }
    text = parts.join('\n\n')
  }

  if (text.trim() === '' && images.length === 0) throw new RequestError('the messages contain no text', 'messages')
  return encodeChatInput({ text, attachments: images })
}

/** Legacy /v1/completions: prompt is a string or a one-element array of strings. */
export function promptFromCompletion(prompt: unknown): string {
  const p = Array.isArray(prompt) && prompt.length === 1 ? prompt[0] : prompt
  if (typeof p !== 'string' || p.trim() === '') {
    throw new RequestError('prompt must be a non-empty string (batched prompts are not supported)', 'prompt')
  }
  return p
}
