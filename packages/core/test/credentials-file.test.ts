import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../src/config'
import { findCredentialsFile, readCredentials } from '../src/credentials-file'

let root = ''
let deep = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dusk-config-'))
  deep = join(root, 'apps', 'web')
  mkdirSync(deep, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const FILE = { og: { computeKey: 'sk-from-file' } }

describe('findCredentialsFile', () => {
  it('walks up from the working directory to the repo root', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify(FILE))
    expect(findCredentialsFile(deep)).toBe(join(root, 'config.json'))
  })

  it('prefers the nearest file when a subdirectory has its own', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify(FILE))
    writeFileSync(join(deep, 'config.json'), JSON.stringify(FILE))
    expect(findCredentialsFile(deep)).toBe(join(deep, 'config.json'))
  })

  it('returns undefined when there is no file, because every credential is optional', () => {
    expect(findCredentialsFile(deep)).toBeUndefined()
  })
})

describe('readCredentials', () => {
  it('reads and validates the file it finds', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify(FILE))
    expect(readCredentials({ cwd: deep })).toEqual({ ogComputeKey: 'sk-from-file' })
  })

  it('is empty rather than an error when no file exists', () => {
    expect(readCredentials({ cwd: deep })).toEqual({})
  })

  it('names the file when the JSON is malformed', () => {
    const path = join(root, 'config.json')
    writeFileSync(path, '{ "og": { "computeKey": "sk-x" }, }')
    const run = () => readCredentials({ cwd: deep })
    expect(run).toThrow(ConfigError)
    expect(run).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('honours an explicit path, for a holder who keeps credentials outside the repo', () => {
    const path = join(root, 'elsewhere.json')
    writeFileSync(path, JSON.stringify(FILE))
    expect(readCredentials({ env: { DUSK_CONFIG_FILE: path } })).toEqual({
      ogComputeKey: 'sk-from-file',
    })
  })

  it('refuses an explicit path that does not exist', () => {
    expect(() => readCredentials({ env: { DUSK_CONFIG_FILE: join(root, 'missing.json') } })).toThrow(
      /DUSK_CONFIG_FILE/,
    )
  })
})
