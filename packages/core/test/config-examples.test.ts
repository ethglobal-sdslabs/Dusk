import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCredentialsJson } from '../src/credentials'
import { publicSettingsEnv } from '../src/file-settings'

const read = (name: string) => readFileSync(resolve(name), 'utf8')

describe('role-specific configuration examples', () => {
  it.each(['config.user.example.json', 'config.developer.example.json'])('%s is valid and contains no private credentials', (name) => {
    const raw = JSON.parse(read(name))
    const credentials = parseCredentialsJson(read(name))
    expect(credentials.buyerPrivateKey).toBeUndefined()
    expect(credentials.workerPrivateKey).toBeUndefined()
    expect(credentials.ogComputeKey).toBeUndefined()
    expect(credentials.ogAccessKey).toBeUndefined()
    expect(Object.values(raw.operators ?? {}).every((value) => value === '')).toBe(true)
    expect(publicSettingsEnv(credentials.settings)).toMatchObject({
      NEXT_PUBLIC_ENS_MODE: 'application-enforced',
      NEXT_PUBLIC_ENS_CONTROLLER_ADDRESS: raw.ens.controllerAddress,
      NEXT_PUBLIC_DUSK_ESCROW_ADDRESS: raw.escrow.address,
    })
  })

  it('keeps user and developer public network settings consistent', () => {
    const user = JSON.parse(read('config.user.example.json'))
    const developer = JSON.parse(read('config.developer.example.json'))
    for (const section of ['og', 'arkiv', 'escrow', 'swarm']) expect(developer[section]).toEqual(user[section])
    for (const [key, value] of Object.entries(user.ens)) expect(developer.ens[key]).toEqual(value)
    expect(user.operators).toBeUndefined()
    expect(developer.reputation).toMatchObject({ revokeBelow: 50, minimumResolved: 3, workflowId: '', forwarderAddress: '' })
  })
})
