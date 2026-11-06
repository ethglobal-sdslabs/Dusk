import { expect } from 'bun:test'
import { test, newTestRuntime, EvmMock, HttpActionsMock, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test'
import { bytesToHex } from 'viem'
import { evaluateScheduledReputation } from '../src/runtime'
import { world, config, h, user, reputation, receipt, decoded } from './fixtures'

function setup(options = {}) {
  const model = world()
  model.state.receipts = [receipt(1), receipt(2)]
  const http = HttpActionsMock.testInstance()
  let stored = ''
  const writes = []
  http.sendRequest = (request) => {
    const body = new TextDecoder().decode(request.body)
    const respond = (value) => ({ statusCode: 200, body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64') })
    if (request.url.startsWith(config.swarm.uploadUrl)) {
      stored = body
      return respond({ reference: h(body).slice(2) })
    }
    if (request.url.startsWith(config.swarm.downloadUrl)) return respond(options.wrongEvidence ? '{}' : stored)
    const rpc = JSON.parse(body)
    if (options.failedSource && rpc.method === 'arkiv_query') return { statusCode: 503 }
    return respond({ jsonrpc: '2.0', id: 1, result: model.rpc(request.url, rpc.method, rpc.params) })
  }
  const evm = EvmMock.testInstance(16015286601757825753n)
  evm.writeReport = (input) => { writes.push(input); return { txStatus: 'TX_STATUS_SUCCESS' } }
  const runtime = newTestRuntime(null, { timeProvider: () => 1000_000 }, config)
  return { model, runtime, writes, evidence: () => stored }
}

test('the real CRE runtime adapters recompute, retain evidence, sign and submit a bounded report', () => {
  const run = setup()
  expect(evaluateScheduledReputation(run.runtime)).toBe(1)
  expect(run.writes).toHaveLength(1)
  expect(bytesToHex(run.writes[0].receiver)).toBe(reputation)
  const payload = bytesToHex(run.writes[0].report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))
  const evaluations = decoded(payload)[4]
  expect(evaluations[0].wallet.toLowerCase()).toBe(user)
  expect(evaluations[0].score).toBe(0)
  expect(evaluations[0].settledJobs).toBe(3)
  expect(JSON.parse(run.evidence()).records).toHaveLength(1)
})

test('a source outage stops the CRE execution before a score is signed or submitted', () => {
  const run = setup({ failedSource: true })
  expect(() => evaluateScheduledReputation(run.runtime)).toThrow(/transport/)
  expect(run.writes).toHaveLength(0)
  expect(run.evidence()).toBe('')
})

test('the decentralized publisher refuses mismatched public evidence readback', () => {
  const run = setup({ wrongEvidence: true })
  expect(() => evaluateScheduledReputation(run.runtime)).toThrow(/readback/)
  expect(run.writes).toHaveLength(0)
})
