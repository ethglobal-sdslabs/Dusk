import { describe, expect, it } from 'vitest'
import {
  ChatInputError,
  chatContent,
  checkChatInput,
  encodeChatInput,
  parseChatInput,
  type ChatInput,
} from '../src/chat-input'

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG_B64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))
const HTML_B64 = btoa('<!doctype html><html></html>')

const LIMITS = { maxBytes: 100_000, maxAttachments: 4 }
const VISION = ['0gm-1.0-35b-a3b']

const withImage: ChatInput = {
  text: 'what is this?',
  attachments: [{ kind: 'image', name: 'dot.png', mime: 'image/png', data: PNG_B64 }],
}

describe('encodeChatInput', () => {
  it('writes a text-only message as the bare text, byte for byte what posting wrote before', () => {
    expect(encodeChatInput({ text: 'hi', attachments: [] })).toBe('hi')
  })

  it('writes attachments as the marked v2 envelope', () => {
    const raw = encodeChatInput(withImage)
    expect(JSON.parse(raw)).toEqual({ dusk: 'input/v2', ...withImage })
  })
})

describe('parseChatInput', () => {
  it('round-trips an envelope', () => {
    expect(parseChatInput(encodeChatInput(withImage))).toEqual(withImage)
  })

  it('reads anything unmarked as a plain prompt, including a prompt that is itself JSON', () => {
    const prompt = '{"text":"x","attachments":[]}'
    expect(parseChatInput(prompt)).toEqual({ text: prompt, attachments: [] })
    expect(parseChatInput('hi')).toEqual({ text: 'hi', attachments: [] })
  })

  it.each([
    ['attachments not an array', { dusk: 'input/v2', text: 'x', attachments: 'no' }],
    ['an unknown kind', { dusk: 'input/v2', text: 'x', attachments: [{ kind: 'video', name: 'a' }] }],
    ['an image with no data', { dusk: 'input/v2', text: 'x', attachments: [{ kind: 'image', name: 'a', mime: 'image/png' }] }],
    ['an image of an unsupported type', { dusk: 'input/v2', text: 'x', attachments: [{ kind: 'image', name: 'a', mime: 'image/gif', data: PNG_B64 }] }],
    ['a text file with no text', { dusk: 'input/v2', text: 'x', attachments: [{ kind: 'text', name: 'a' }] }],
    ['a nameless attachment', { dusk: 'input/v2', text: 'x', attachments: [{ kind: 'text', name: '', text: 'y' }] }],
  ])('refuses a marked envelope with %s', (_, v) => {
    expect(() => parseChatInput(JSON.stringify(v))).toThrow(ChatInputError)
  })
})

describe('checkChatInput', () => {
  const ok = (input: ChatInput, model = VISION[0]!) =>
    checkChatInput(input, { model, visionModels: VISION, ...LIMITS })

  it('accepts a real PNG on a vision model', () => {
    expect(() => ok(withImage)).not.toThrow()
  })

  it('accepts a JPEG whose bytes say JPEG', () => {
    expect(() =>
      ok({ text: '', attachments: [{ kind: 'image', name: 'a.jpg', mime: 'image/jpeg', data: JPEG_B64 }] }),
    ).not.toThrow()
  })

  it('refuses an image on a model that does not take images, naming the model', () => {
    expect(() => ok(withImage, 'qwen3-coder-flash')).toThrow(/qwen3-coder-flash/)
  })

  it('does not gate on capability when the catalog could not be read', () => {
    expect(() =>
      checkChatInput(withImage, { model: 'anything-typed', visionModels: undefined, ...LIMITS }),
    ).not.toThrow()
  })

  it('accepts a text file on any model', () => {
    expect(() =>
      ok({ text: 'sum it', attachments: [{ kind: 'text', name: 'a.csv', text: '1,2' }] }, 'qwen3-coder-flash'),
    ).not.toThrow()
  })

  it('refuses bytes that are not the image they claim to be', () => {
    expect(() =>
      ok({ text: '', attachments: [{ kind: 'image', name: 'x.png', mime: 'image/png', data: HTML_B64 }] }),
    ).toThrow(ChatInputError)
  })

  it('refuses a PNG declared as a JPEG', () => {
    expect(() =>
      ok({ text: '', attachments: [{ kind: 'image', name: 'x.jpg', mime: 'image/jpeg', data: PNG_B64 }] }),
    ).toThrow(ChatInputError)
  })

  it('refuses base64 that does not decode', () => {
    expect(() =>
      ok({ text: '', attachments: [{ kind: 'image', name: 'x.png', mime: 'image/png', data: '!!!not base64' }] }),
    ).toThrow(ChatInputError)
  })

  it('refuses more attachments than the limit', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'text' as const, name: `${i}.txt`, text: 'x' }))
    expect(() => ok({ text: '', attachments: many })).toThrow(/at most 4/)
  })

  it('refuses an envelope over the byte limit', () => {
    const big = { kind: 'text' as const, name: 'big.txt', text: 'x'.repeat(LIMITS.maxBytes) }
    expect(() => ok({ text: '', attachments: [big] })).toThrow(ChatInputError)
  })

  it('refuses a message with neither text nor attachments', () => {
    expect(() => ok({ text: '  ', attachments: [] })).toThrow(ChatInputError)
  })
})

describe('chatContent', () => {
  it('is the bare string for a text-only message, so the wire request is unchanged', () => {
    expect(chatContent({ text: 'hi', attachments: [] })).toBe('hi')
  })

  it('maps text, text files and images to OpenAI content parts, in that order', () => {
    const parts = chatContent({
      text: 'compare',
      attachments: [
        { kind: 'image', name: 'dot.png', mime: 'image/png', data: PNG_B64 },
        { kind: 'text', name: 'notes.md', text: '# hi' },
      ],
    })
    expect(parts).toEqual([
      { type: 'text', text: 'compare' },
      { type: 'text', text: '[File: notes.md]\n# hi\n[End of file: notes.md]' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ])
  })

  it('omits an empty text part', () => {
    const parts = chatContent({ text: '', attachments: withImage.attachments })
    expect(Array.isArray(parts) && parts.every((p) => p.type === 'image_url')).toBe(true)
  })
})
