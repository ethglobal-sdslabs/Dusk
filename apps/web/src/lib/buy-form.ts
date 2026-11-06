import { isImageModel, nextCreditReset, type ClockConfig, type Visibility } from '@dusk/core'

export type RawJobForm = {
  prompt: string
  model: string
  maxPricePer1kOut: string
  maxTokens: string
  deadlineMinutes: string
  visibility: Visibility
}

export type ParsedJobForm = {
  prompt: string
  model: string
  maxPricePer1kOut: bigint
  maxTokens: number
  deadlineMs: number
  visibility: Visibility
}

export type FormErrors = Partial<Record<keyof RawJobForm, string>>

export type ParseResult = { ok: true; spec: ParsedJobForm } | { ok: false; errors: FormErrors }

export const DEADLINE_MARGIN_MS = 60_000

export function maxDeadlineMs(clock: ClockConfig, now: number): number {
  const remaining = nextCreditReset(clock, new Date(now)).getTime() - now
  const margin = Math.min(DEADLINE_MARGIN_MS, Math.floor(remaining / 10))
  return remaining - margin
}

export function maxDeadlineMinutes(clock: ClockConfig, now: number): number {
  return Math.max(0, Math.floor(maxDeadlineMs(clock, now) / 60_000))
}

export function defaultJobForm(clock: ClockConfig, now: number, model = ''): RawJobForm {
  return {
    prompt: 'hi',
    model,
    maxPricePer1kOut: '1000000',
    maxTokens: '8',
    deadlineMinutes: String(Math.max(1, Math.min(10, maxDeadlineMinutes(clock, now)))),
    visibility: 'public',
  }
}

export const MAX_TOKENS_CEILING = Number.POSITIVE_INFINITY

export function parseJobForm(
  raw: RawJobForm,
  opts: {
    clock: ClockConfig
    now: number
    maxTokensCeiling?: number
    imageModels?: readonly string[]
    hasAttachments?: boolean
  },
): ParseResult {
  const ceiling = opts.maxTokensCeiling
  const errors: FormErrors = {}

  const prompt = raw.prompt.trim()
  if (prompt === '' && !opts.hasAttachments) errors.prompt = 'Write the prompt you want answered.'

  const model = raw.model.trim()
  if (model === '') {
    errors.model = 'Name the model to run this on. Anything the Router can actually serve.'
  }

  let maxPricePer1kOut = 0n
  if (!/^\d+$/.test(raw.maxPricePer1kOut.trim())) {
    errors.maxPricePer1kOut =
      'A ceiling in wei, as a whole number. Zero is allowed: tonight’s credits are worth nothing tomorrow, so a holder’s floor price really is zero.'
  } else {
    maxPricePer1kOut = BigInt(raw.maxPricePer1kOut.trim())
  }

  const isImage = isImageModel(model, opts.imageModels ?? [])
  if (isImage && opts.hasAttachments) {
    errors.prompt = 'An image model takes a written prompt only. Remove the attachments, or pick a text model.'
  } else if (isImage && prompt === '') {
    errors.prompt = 'Write the prompt you want answered.'
  }
  if (isImage && raw.visibility === 'private') {
    errors.visibility =
      'Image jobs are public for now: a picture is too large to keep in this browser, so a private one would have nowhere to survive.'
  }

  let maxTokens = 0
  const tokens = Number(raw.maxTokens.trim())
  if (isImage) {
    maxTokens = 1
  } else if (!Number.isSafeInteger(tokens) || tokens < 1) {
    errors.maxTokens = 'A whole number of output tokens, at least one.'
  } else if (ceiling !== undefined && tokens > ceiling) {
    errors.maxTokens = `At most ${ceiling} output tokens. Every one of them burns a holder’s real credits, and there are few left.`
  } else {
    maxTokens = tokens
  }

  let deadlineMs = 0
  const minutes = Number(raw.deadlineMinutes.trim())
  const windowMs = maxDeadlineMs(opts.clock, opts.now)
  if (windowMs <= 0) {
    errors.deadlineMinutes =
      'Tonight’s credits are about to reset, and a job posted now could not clear before they do. Post again after the reset.'
  } else if (!Number.isInteger(minutes) || minutes < 1) {
    errors.deadlineMinutes = 'A whole number of minutes, at least one.'
  } else if (minutes * 60_000 > windowMs) {
    errors.deadlineMinutes =
      `The job’s deadline outlives tonight’s credits. Shorten it to ${maxDeadlineMinutes(opts.clock, opts.now)} ` +
      'minutes or less, or post again after the reset.'
  } else {
    deadlineMs = minutes * 60_000
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    spec: { prompt, model, maxPricePer1kOut, maxTokens, deadlineMs, visibility: raw.visibility },
  }
}
