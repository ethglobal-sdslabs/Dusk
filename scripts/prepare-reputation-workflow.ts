import '@dusk/core/env'
import { findCredentialsFile } from '@dusk/core/credentials-file'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { reputationSetup } from './reputation-config'

try {
  const index = process.argv.indexOf('--out')
  const path = resolve(index < 0 ? '.dusk/automation/config.json' : process.argv[index + 1] ?? '')
  const protectedPaths = ['config.json', 'config.user.example.json', 'config.developer.example.json'].map((name) => resolve(name))
  const source = process.env.DUSK_CONFIG_FILE?.trim() || findCredentialsFile(process.cwd())
  if (source) protectedPaths.push(resolve(source))
  if (protectedPaths.includes(path)) throw new Error('Workflow output must not replace the source configuration or an example.')
  const setup = reputationSetup(process.env)
  if (!setup.ens.reputation) throw new Error('config.json ens.reputationAddress is required; deploy DuskReputation first.')
  const publicConfig = setup.publicWorkflow(setup.ens.reputation)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(publicConfig, null, 2) + '\n', { mode: 0o600 })
  console.log(`Public workflow configuration written to ${path}`)
  console.log(`Company workflow owner: ${setup.workflowOwner}; approved evidence sources: ${setup.sourceHash}`)
} catch (error) {
  console.error(error instanceof Error && !/https?:\/\//.test(error.message) ? error.message : 'Workflow preparation failed; no private value or URL is repeated.')
  process.exitCode = 1
}
