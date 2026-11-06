import { describe, expect, it } from 'vitest'
import type { ClockConfig } from '@dusk/core'
import { nextCreditReset } from '@dusk/core'
import { defaultJobForm, maxDeadlineMinutes, parseJobForm, type RawJobForm } from '../src/lib/buy-form'

const DAILY: ClockConfig = { resetAt: 'daily-utc-midnight' }

const NOON = Date.UTC(2026, 9, 30, 12, 0, 0)

function form(over: Partial<RawJobForm> = {}): RawJobForm {
  return {
    prompt: 'hi',
    model: '0gm-1.0-35b-a3b',
    maxPricePer1kOut: '1000000',
    maxTokens: '8',
    deadlineMinutes: '10',
    visibility: 'public',
    ...over,
  }
}

describe('parseJobForm', () => {
  it('turns a filled form into a JobSpec, with the price as a bigint', () => {
    const parsed = parseJobForm(form(), { clock: DAILY, now: NOON })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.spec).toEqual({
      prompt: 'hi',
      model: '0gm-1.0-35b-a3b',
      maxPricePer1kOut: 1000000n,
      maxTokens: 8,
      deadlineMs: 600_000,
      visibility: 'public',
    })
  })

  it('accepts a max price of zero, because zero is a real quote in this market', () => {
    const parsed = parseJobForm(form({ maxPricePer1kOut: '0' }), { clock: DAILY, now: NOON })
    expect(parsed.ok && parsed.spec.maxPricePer1kOut).toBe(0n)
  })

  it('carries the private toggle through', () => {
    const parsed = parseJobForm(form({ visibility: 'private' }), { clock: DAILY, now: NOON })
    expect(parsed.ok && parsed.spec.visibility).toBe('private')
  })

  it('trims the model and the prompt, because a trailing space on a model id is a 404', () => {
    const parsed = parseJobForm(form({ model: ' 0gm-1.0-35b-a3b ' }), { clock: DAILY, now: NOON })
    expect(parsed.ok && parsed.spec.model).toBe('0gm-1.0-35b-a3b')
  })

  it.each([
    ['an empty prompt', { prompt: '  ' }, 'prompt'],
    ['an empty model', { model: '' }, 'model'],
    ['a negative price', { maxPricePer1kOut: '-1' }, 'maxPricePer1kOut'],
    ['a fractional price', { maxPricePer1kOut: '1.5' }, 'maxPricePer1kOut'],
    ['a non-numeric price', { maxPricePer1kOut: 'cheap' }, 'maxPricePer1kOut'],
    ['zero tokens', { maxTokens: '0' }, 'maxTokens'],
    ['fractional tokens', { maxTokens: '8.5' }, 'maxTokens'],
    ['a zero deadline', { deadlineMinutes: '0' }, 'deadlineMinutes'],
    ['a non-numeric deadline', { deadlineMinutes: 'soon' }, 'deadlineMinutes'],
  ])('refuses %s, on that field', (_why, over, field) => {
    const parsed = parseJobForm(form(over), { clock: DAILY, now: NOON })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(Object.keys(parsed.errors)).toContain(field)
  })

  it('reports every bad field at once, not the first one', () => {
    const parsed = parseJobForm(form({ prompt: '', model: '', maxTokens: 'x' }), {
      clock: DAILY,
      now: NOON,
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(Object.keys(parsed.errors).sort()).toEqual(['maxTokens', 'model', 'prompt'])
  })

  it('has no token ceiling by default', () => {
    const parsed = parseJobForm(form({ maxTokens: '4096' }), { clock: DAILY, now: NOON })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.spec.maxTokens).toBe(4096)
  })

  it('refuses a token count past the safe-integer range', () => {
    const parsed = parseJobForm(form({ maxTokens: '9007199254740993' }), { clock: DAILY, now: NOON })
    expect(parsed.ok).toBe(false)
  })

  it('takes the ceiling as a parameter, so the page supplies it rather than this module deciding', () => {
    const parsed = parseJobForm(form({ maxTokens: '16' }), { clock: DAILY, now: NOON, maxTokensCeiling: 8 })
    expect(parsed.ok).toBe(false)
  })

  describe('the deadline against tonight’s credits', () => {
    const LATE = Date.UTC(2026, 9, 30, 23, 30, 0)

    it('refuses a deadline that outlives the reset, and says what to do about it', () => {
      const parsed = parseJobForm(form({ deadlineMinutes: '90' }), { clock: DAILY, now: LATE })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      const message = parsed.errors.deadlineMinutes ?? ''
      expect(message).toMatch(/reset/i)
      expect(message).toMatch(/shorten/i)
      expect(message).not.toMatch(/sorry|apolog|unfortunately/i)
    })

    it('accepts a deadline inside the window', () => {
      expect(parseJobForm(form({ deadlineMinutes: '10' }), { clock: DAILY, now: LATE }).ok).toBe(true)
    })

    it('refuses a deadline that lands inside the safety margin, which postJob would still accept now', () => {
      const window = maxDeadlineMinutes(DAILY, LATE)
      expect(window).toBeLessThan(30)
      const parsed = parseJobForm(form({ deadlineMinutes: '30' }), { clock: DAILY, now: LATE })
      expect(parsed.ok).toBe(false)
      expect(LATE + 30 * 60_000).toBeLessThanOrEqual(nextCreditReset(DAILY, new Date(LATE)).getTime())
    })

    it('accepts exactly the maximum it advertises', () => {
      const minutes = maxDeadlineMinutes(DAILY, LATE)
      expect(parseJobForm(form({ deadlineMinutes: String(minutes) }), { clock: DAILY, now: LATE }).ok).toBe(true)
    })

    it('refuses everything once there is no postable window left', () => {
      const edge = Date.UTC(2026, 9, 30, 23, 59, 50)
      expect(maxDeadlineMinutes(DAILY, edge)).toBe(0)
      const parsed = parseJobForm(form({ deadlineMinutes: '1' }), { clock: DAILY, now: edge })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.errors.deadlineMinutes).toMatch(/after the reset/i)
    })

    it('scales its margin to a compressed demo clock instead of swallowing the whole cycle', () => {
      const compressed: ClockConfig = { resetAt: { everySeconds: 120 } }
      const t = 0
      expect(maxDeadlineMinutes(compressed, t)).toBeGreaterThan(0)
    })
  })
})

describe('defaultJobForm', () => {
  it('opens with a deadline inside the window, so the only thing missing is the model', () => {
    const late = Date.UTC(2026, 9, 30, 23, 45, 0)
    const parsed = parseJobForm(defaultJobForm(DAILY, late), { clock: DAILY, now: late })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.deadlineMinutes).toBeUndefined()
    expect(Object.keys(parsed.errors)).toEqual(['model'])
  })

  it('opens public, because a public job is the one a judge can open', () => {
    expect(defaultJobForm(DAILY, NOON).visibility).toBe('public')
  })

  it('names no model, because a hardcoded model id is a defect and /v1/models lies', () => {
    expect(defaultJobForm(DAILY, NOON).model).toBe('')
  })

  it('opens at a tiny token budget rather than the ceiling', () => {
    expect(Number(defaultJobForm(DAILY, NOON).maxTokens)).toBeLessThanOrEqual(8)
  })
})

describe('parseJobForm — image models', () => {
  const IMG = ['z-image-turbo']

  it('an image model ignores maxTokens and posts one image', () => {
    const parsed = parseJobForm(form({ model: 'z-image-turbo', maxTokens: '' }), {
      clock: DAILY,
      now: NOON,
      imageModels: IMG,
    })
    expect(parsed.ok && parsed.spec.maxTokens).toBe(1)
  })

  it('an image model refuses private', () => {
    const parsed = parseJobForm(form({ model: 'z-image-turbo', visibility: 'private' }), {
      clock: DAILY,
      now: NOON,
      imageModels: IMG,
    })
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.errors.visibility).toMatch(/public/i)
  })

  it('a text model is parsed exactly as before', () => {
    const without = parseJobForm(form(), { clock: DAILY, now: NOON })
    const withList = parseJobForm(form(), { clock: DAILY, now: NOON, imageModels: IMG })
    expect(withList).toEqual(without)
  })
})

describe('parseJobForm — attachments', () => {
  it('allows an empty prompt when something is attached', () => {
    const parsed = parseJobForm(form({ prompt: '' }), { clock: DAILY, now: NOON, hasAttachments: true })
    expect(parsed.ok).toBe(true)
  })
  it('still refuses an empty prompt with nothing attached', () => {
    const parsed = parseJobForm(form({ prompt: '' }), { clock: DAILY, now: NOON, hasAttachments: false })
    expect(parsed.ok).toBe(false)
  })
  it('refuses attachments on an image model, which takes a prompt only', () => {
    const parsed = parseJobForm(form({ model: 'z-image-turbo' }), {
      clock: DAILY, now: NOON, hasAttachments: true, imageModels: ['z-image-turbo'],
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.prompt).toMatch(/attach/i)
  })
})
