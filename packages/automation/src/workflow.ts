import { Runner } from '@chainlink/cre-sdk/unrestricted'
import { parseReputationWorkflowConfig, type ReputationWorkflowConfig } from './config'
import { initReputationWorkflow } from './runtime'

export async function main() {
  const runner = await Runner.newRunner<ReputationWorkflowConfig>({ configParser: (bytes) => parseReputationWorkflowConfig(JSON.parse(new TextDecoder().decode(bytes))) })
  await runner.run(initReputationWorkflow)
}
