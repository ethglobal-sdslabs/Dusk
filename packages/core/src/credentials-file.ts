import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConfigError } from './config'
import {
  applyCredentials,
  CREDENTIALS_FILE,
  parseCredentialsJson,
  type DuskCredentials,
} from './credentials'

export const CREDENTIALS_PATH_ENV = 'DUSK_CONFIG_FILE'

export function findCredentialsFile(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, CREDENTIALS_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export interface ReadCredentialsOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

export function readCredentials(options: ReadCredentialsOptions = {}): DuskCredentials {
  const env = options.env ?? process.env
  const explicit = env[CREDENTIALS_PATH_ENV]?.trim()
  if (explicit) {
    const path = resolve(explicit)
    if (!existsSync(path)) {
      throw new ConfigError(
        `${CREDENTIALS_PATH_ENV} points at ${path}, which does not exist. Unset it to fall back ` +
          `to the nearest ${CREDENTIALS_FILE}, or fix the path — ignoring it would leave this ` +
          'process running on whatever credentials were already in the environment.',
      )
    }
    return parseCredentialsJson(readFileSync( path, 'utf8'), path)
  }

  const found = findCredentialsFile(options.cwd ?? process.cwd())
  if (!found) return {}
  return parseCredentialsJson(readFileSync( found, 'utf8'), found)
}

export function applyCredentialsFile(options: ReadCredentialsOptions = {}): DuskCredentials {
  const credentials = readCredentials(options)
  applyCredentials(credentials, options.env ?? process.env)
  return credentials
}
