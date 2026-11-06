export type PlannedPiece = { prompt: string; maxTokens: number }

export type JobPlan =
  | { kind: 'single' }
  | { kind: 'serial'; pieces: PlannedPiece[] }
  | { kind: 'parallel'; pieces: PlannedPiece[] }
  | { kind: 'too-big'; limit: number }

const NUMBERED = /^\s*\d+[.)]\s+/
const HEADING = /^\s*#{1,6}\s+/
const WHOLE_LIST = /\b(rank|ranking|compare|comparison|contrast|sort|which|best|worst|choose|pick|between|combine|together|overall|difference|differences|versus|vs)\b/i
const REFERS_BACK = /\b(then|previous|above|earlier|step\s+\d+|that answer|the result|from\s+(it|that))\b/i

function split(prompt: string): { kind: 'parallel' | 'serial'; parts: string[] } | null {
  const lines = prompt.split('\n')

  const numbered = lines.map((l, i) => (NUMBERED.test(l) ? i : -1)).filter((i) => i >= 0)
  if (numbered.length >= 2) {
    const preamble = lines.slice(0, numbered[0]).join('\n').trim()
    if (WHOLE_LIST.test(preamble)) return null
    const items = numbered.map((start, k) =>
      lines
        .slice(start, numbered[k + 1] ?? lines.length)
        .join('\n')
        .replace(NUMBERED, '')
        .trim(),
    )
    const parts = items.map((t) => (preamble ? `${preamble}\n${t}` : t))
    return { kind: items.slice(1).some((t) => REFERS_BACK.test(t)) ? 'serial' : 'parallel', parts }
  }

  const headings = lines.map((l, i) => (HEADING.test(l) ? i : -1)).filter((i) => i >= 0)
  if (headings.length >= 2) {
    const preamble = lines.slice(0, headings[0]).join('\n').trim()
    if (WHOLE_LIST.test(preamble)) return null
    const sections = headings.map((start, k) => lines.slice(start, headings[k + 1] ?? lines.length).join('\n').trim())
    return { kind: 'parallel', parts: sections.map((t) => (preamble ? `${preamble}\n${t}` : t)) }
  }

  return null
}

export function planJob(prompt: string, maxTokens: number, outputLimit: number): JobPlan {
  const found = split(prompt)
  if (!found) return maxTokens > outputLimit ? { kind: 'too-big', limit: outputLimit } : { kind: 'single' }
  const each = Math.max(1, Math.ceil(maxTokens / found.parts.length))
  if (each > outputLimit) return { kind: 'too-big', limit: outputLimit }
  return { kind: found.kind, pieces: found.parts.map((p) => ({ prompt: p, maxTokens: each })) }
}
