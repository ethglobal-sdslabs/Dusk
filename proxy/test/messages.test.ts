import { describe, expect, it } from 'vitest'
import { parseChatInput } from '@dusk/core'
import { promptFromCompletion, promptFromMessages } from '../src/messages'

describe('promptFromMessages', () => {
  it('passes a lone user message through unchanged', () => {
    expect(promptFromMessages([{ role: 'user', content: 'hello' }])).toBe('hello')
  })

  it('puts system text first as instructions', () => {
    const p = promptFromMessages([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
    expect(p).toBe('Instructions:\nBe terse.\n\nhi')
  })

  it('flattens a multi-turn conversation into a transcript', () => {
    const p = promptFromMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect(p).toContain('User: a\n\nAssistant: b\n\nUser: c')
    expect(p).toMatch(/next reply/)
  })

  it('carries data-URL images as Dusk chat attachments', () => {
    const p = promptFromMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ])
    expect(parseChatInput(p)).toEqual({
      text: 'what is this',
      attachments: [{ kind: 'image', name: 'image-1', mime: 'image/png', data: 'iVBORw0KGgo=' }],
    })
  })

  it('rejects what a worker cannot run', () => {
    expect(() => promptFromMessages([])).toThrow(/non-empty/)
    expect(() => promptFromMessages([{ role: 'tool', content: 'x' }])).toThrow(/tool/)
    expect(() =>
      promptFromMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }]),
    ).toThrow(/data: URLs/)
    expect(() => promptFromMessages([{ role: 'user', content: '  ' }])).toThrow(/no text/)
  })
})

describe('promptFromCompletion', () => {
  it('takes a string or a one-element array', () => {
    expect(promptFromCompletion('x')).toBe('x')
    expect(promptFromCompletion(['y'])).toBe('y')
    expect(() => promptFromCompletion(['a', 'b'])).toThrow(/batched/)
  })
})
