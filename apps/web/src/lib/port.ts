
export const REQUIRED_PORT = 3000

type Env = Record<string, string | undefined>

export type PortVerdict = { ok: true; port: number } | { ok: false; port: number | null; message: string }

export function requestedPort(input: { argv?: readonly string[]; env?: Env }): number | null {
  const argv = input.argv ?? []
  const env = input.env ?? {}

  let raw: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-p' || arg === '--port') {
      raw = argv[i + 1]
      break
    }
    const inline = /^(?:-p|--port)=(.*)$/.exec(arg)
    if (inline) {
      raw = inline[1]
      break
    }
  }
  raw ??= env['PORT']
  if (raw === undefined || raw === '') return REQUIRED_PORT

  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function portVerdict(input: { argv?: readonly string[]; env?: Env; inUse?: boolean }): PortVerdict {
  const port = requestedPort(input)

  if (port === null) {
    return {
      ok: false,
      port: null,
      message:
        `Could not read the port being asked for. Dusk's web app only works on ` +
        `http://localhost:${REQUIRED_PORT} — the 0G Router allowlists that exact origin ` +
        `string and nothing else we would plausibly pick. See docs/findings/friction.md #21.`,
    }
  }

  if (port !== REQUIRED_PORT) {
    return { ok: false, port, message: wrongPortMessage(port) }
  }

  if (input.inUse) {
    return {
      ok: false,
      port,
      message:
        `Something is already listening on port ${REQUIRED_PORT}, and \`next dev\` would ` +
        `quietly move to ${REQUIRED_PORT + 1}. Free port ${REQUIRED_PORT} and start again — ` +
        `do not move the app.\n\n` +
        trapExplanation() +
        `\n\nThe app must be served from, and opened at, http://localhost:${REQUIRED_PORT}. ` +
        `See docs/findings/friction.md #21.`,
    }
  }

  return { ok: true, port }
}

function wrongPortMessage(port: number): string {
  return (
    `Refusing to serve Dusk on port ${port}. The 0G Router allowlists exact origin ` +
    `strings for CORS, and the only one that also works with Privy's shared 0G app ID is ` +
    `http://localhost:${REQUIRED_PORT}.\n\n` +
    trapExplanation() +
    `\n\nRun it on port ${REQUIRED_PORT}. See docs/findings/friction.md #21.`
  )
}

function trapExplanation(): string {
  return (
    `On port ${REQUIRED_PORT + 1} — Privy's documented fallback — sign-in works and ` +
    `inference silently does not. A CORS refusal never reaches the Router, so it arrives ` +
    `as a \`TypeError\` with no status and no server log, and reads like a network blip.`
  )
}
