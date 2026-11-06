import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Job } from '@dusk/core'
import { buildServer } from '../src/tools'
import { MODEL, setup } from './setup'

async function connect(t: ReturnType<typeof setup>) {
  const server = buildServer(t.service)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> }
    return { isError: r.isError === true, text: r.content[0]!.text }
  }
  return { client, call }
}

describe('mcp tools', () => {
  it('advertises the four tools and usage instructions', async () => {
    const { client } = await connect(setup())
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['dusk_jobs', 'dusk_market', 'dusk_result', 'dusk_submit'])
    const submit = tools.find((t) => t.name === 'dusk_submit')!
    expect(submit.inputSchema.required).toEqual(expect.arrayContaining(['prompt', 'model', 'max_tokens', 'max_price_per_1k_out']))
    expect(client.getInstructions()).toMatch(/dusk_market/)
  })

  it('market → submit → result round trip, bid given as a decimal string', async () => {
    const t = setup()
    await t.advertise(1000n)
    const { call } = await connect(t)

    const market = JSON.parse((await call('dusk_market')).text)
    expect(market.models[0]).toMatchObject({ model: MODEL, workers: 1, minPricePer1kOut: '1000' })

    const submitted = await call('dusk_submit', { prompt: 'say hi', model: MODEL, max_tokens: 16, max_price_per_1k_out: '1000' })
    expect(submitted.isError).toBe(false)
    const { jobId } = JSON.parse(submitted.text)

    await t.deliver(t.arkiv.all<Job>('job')[0]!, 'hi there')
    const result = JSON.parse((await call('dusk_result', { job_id: jobId, wait_seconds: 0 })).text)
    expect(result).toMatchObject({ status: 'delivered', output: 'hi there' })

    const jobs = JSON.parse((await call('dusk_jobs')).text)
    expect(jobs).toEqual([expect.objectContaining({ jobId, state: 'delivered' })])
  })

  it('returns a refusal as a tool error, not a protocol failure', async () => {
    const { call } = await connect(setup())
    const r = await call('dusk_submit', { prompt: 'x', model: MODEL, max_tokens: 16, max_price_per_1k_out: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/nobody is advertising/)
  })

  it('rejects wait_seconds over the cap', async () => {
    const { call } = await connect(setup())
    const r = await call('dusk_result', { job_id: '0x1', wait_seconds: 10_000 })
    expect(r.isError).toBe(true)
  })
})
