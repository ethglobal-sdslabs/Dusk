import { REQUIRED_PORT } from './port'

export const LOOPBACK_HOST = '127.0.0.1'

const PORT_FLAG = /^(?:-p|--port)(?:=|$)/
const HOST_FLAG = /^(?:-H|--hostname(?:=|$))/

export type ServeArgs = { ok: true; args: string[] } | { ok: false; message: string }

export function serveArgs(mode: 'dev' | 'start', rest: readonly string[]): ServeArgs {
  if (rest.some((arg) => HOST_FLAG.test(arg))) {
    return {
      ok: false,
      message:
        `Refusing -H/--hostname. Dusk's web app binds ${LOOPBACK_HOST} only, because ` +
        `/api/config serves the keys in config.json and Next would otherwise listen on ` +
        `every interface. Do not expose this app on a network or through a tunnel.`,
    }
  }
  const port = rest.some((arg) => PORT_FLAG.test(arg)) ? [] : ['-p', String(REQUIRED_PORT)]
  return { ok: true, args: [mode, '-H', LOOPBACK_HOST, ...port, ...rest] }
}
