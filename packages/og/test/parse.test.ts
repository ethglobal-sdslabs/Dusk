import { describe, expect, it } from 'vitest'
import { creditsSpentOf, EmptyCompletionError, parseCompletion } from '../src/parse'
import type { Balance } from '@dusk/core'

describe('parseCompletion', () => {
  it('reads content when present', () => {
    const r = parseCompletion(
      {
        choices: [{ message: { content: 'dusk ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
        model: '0gm-1.0-35b-a3b',
      },
      '0gm-1.0-35b-a3b',
      1200,
    )
    expect(r.text).toBe('dusk ok')
    expect(r.tokensIn).toBe(3)
    expect(r.tokensOut).toBe(4)
    expect(r.latencyMs).toBe(1200)
  })

  it('falls back to reasoning_content when content is empty', () => {
    const r = parseCompletion(
      {
        choices: [
          { message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 16 },
      },
      '0gm-1.0-35b-a3b',
      900,
    )
    expect(r.text).toBe('thinking...')
    expect(r.finishReason).toBe('length')
  })

  it('throws when content and reasoning_content are both empty', () => {
    expect(() =>
      parseCompletion(
        { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} },
        '0gm-1.0-35b-a3b',
        100,
      ),
    ).toThrow(EmptyCompletionError)
  })

  it('says the request was billed when it throws, so the log explains the money', () => {
    expect(() =>
      parseCompletion({ choices: [{ message: { content: '' } }], usage: {} }, 'm', 100),
    ).toThrow(/billed/i)
  })

  it('records the model actually served, not the one requested', () => {
    const r = parseCompletion(
      { choices: [{ message: { content: 'x' } }], usage: {}, model: 'some-other-model' },
      '0gm-1.0-35b-a3b',
      10,
    )
    expect(r.modelServed).toBe('some-other-model')
  })

  it('falls back to the requested model when the response omits one', () => {
    const r = parseCompletion(
      { choices: [{ message: { content: 'x' } }], usage: {} },
      '0gm-1.0-35b-a3b',
      10,
    )
    expect(r.modelServed).toBe('0gm-1.0-35b-a3b')
  })

  it('throws on a response with no choices', () => {
    expect(() => parseCompletion({ usage: {} }, 'm', 10)).toThrow(EmptyCompletionError)
  })

  it('treats whitespace-only content as empty', () => {
    expect(() =>
      parseCompletion({ choices: [{ message: { content: '   \n' } }], usage: {} }, 'm', 10),
    ).toThrow(EmptyCompletionError)
  })

  it('defaults missing token counts to 0 rather than NaN', () => {
    const r = parseCompletion({ choices: [{ message: { content: 'x' } }] }, 'm', 10)
    expect(r.tokensIn).toBe(0)
    expect(r.tokensOut).toBe(0)
  })
})

describe('creditsSpentOf', () => {
  const bal = (credit: string): Balance => ({
    address: '0x0000000000000000000000000000000000000000',
    currency: 'usd',
    depositBalance: '0',
    creditBalance: credit,
    pendingCharge: '0',
    totalBalance: credit,
  })

  const result = {
    text: 'x',
    modelServed: 'm',
    tokensIn: 7,
    tokensOut: 11,
    finishReason: 'stop',
    latencyMs: 5,
  }

  it('reports the measured credit delta when both balances are known', () => {
    expect(creditsSpentOf(bal('983041'), bal('983000'), result)).toBe('41')
  })

  it('falls back to a labelled token proxy when no balance is available', () => {
    expect(creditsSpentOf(null, null, result)).toBe('tokens:7/11')
  })

  it('falls back rather than reporting a negative delta', () => {
    expect(creditsSpentOf(bal('100'), bal('150'), result)).toBe('tokens:7/11')
  })

  it('falls back on a zero delta, because settlement lags the call', () => {
    expect(creditsSpentOf(bal('100'), bal('100'), result)).toBe('tokens:7/11')
  })

  it('still trusts a positive delta, which can only mean a settled spend', () => {
    expect(creditsSpentOf(bal('983041'), bal('983023'), result)).toBe('18')
  })

  it('falls back when no tokens were consumed and nothing settled', () => {
    const noTokens = { ...result, tokensIn: 0, tokensOut: 0 }
    expect(creditsSpentOf(bal('100'), bal('100'), noTokens)).toBe('tokens:0/0')
  })
})
