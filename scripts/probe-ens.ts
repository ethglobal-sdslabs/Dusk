import '@dusk/core/env'
import { loadEnsConfig } from '../packages/ens/src/config'
import { EnsProbeError, probeNamespace } from '../packages/ens/src/probe'
import { EnsInputError } from '../packages/ens/src/names'

try {
  const config = loadEnsConfig(process.env)
  const report = await probeNamespace(config)
  console.log(JSON.stringify(report, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2))
  if (!report.readyForPermissionAudit) process.exitCode = 1
} catch (error) {
  console.error(error instanceof EnsProbeError || error instanceof EnsInputError ? error.message :
    'ENS discovery failed. Verify chain, root registry, parent hierarchy and RPC availability. No writes were performed.')
  process.exitCode = 1
}
