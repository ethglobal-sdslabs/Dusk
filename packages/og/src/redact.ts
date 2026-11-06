export const OG_KEY_SHAPED = /\b(sk|mk)-/

const OG_KEY_ANYWHERE = /\b(?:sk|mk)-[A-Za-z0-9_-]*/gi

const REDACTED = '[0G key removed]'

export function redactKeyish(text: string): string {
  return text.replace(OG_KEY_ANYWHERE, REDACTED)
}

export function looksKeyish(text: string): boolean {
  OG_KEY_ANYWHERE.lastIndex = 0
  return OG_KEY_ANYWHERE.test(text)
}
