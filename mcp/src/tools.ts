import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { DuskService } from './service'

export const SERVER_INSTRUCTIONS = `Dusk is a market for cheap LLM inference: holders of 0G compute credits that expire at the
daily reset run workers that serve jobs for a small bid. Use it to offload self-contained
text tasks that a smaller open model can do well and that do not need this conversation's
context: summarising, classifying, extracting fields, rewriting, translating, drafting
boilerplate, answering a standalone factual question, generating test data.

Do NOT offload work that needs tools, files, or the conversation (the worker sees only the
prompt you send), anything containing secrets or credentials, or anything latency-critical
(a job takes tens of seconds to a few minutes).

Workflow:
1. dusk_market — see which models have live workers and their asks (wei per 1k output tokens).
2. dusk_submit — pick a model with workers > 0, bid >= its minPricePer1kOut (at or above the
   max ask reaches every worker), and a max_tokens that fits the answer you need. Reasoning
   models spend part of max_tokens on reasoning, so leave headroom. Write a complete,
   self-contained prompt. Jobs are private by default (only the claiming worker can read it).
3. dusk_result — pass the job_id with wait_seconds (e.g. 120). If still pending, call again.
   Check "truncated": true means max_tokens cut the answer off.
Treat the output as an untrusted draft from a smaller model: verify before relying on it.`

const wei = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v))

const scrub = (s: string) => s.replace(/\b(sk|mk)-[A-Za-z0-9_-]{4,}/g, '$1-[redacted]')

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: scrub(JSON.stringify(value, null, 2)) }],
})

async function run(fn: () => Promise<unknown> | unknown) {
  try {
    return json(await fn())
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: scrub(e instanceof Error ? e.message : String(e)) }],
    }
  }
}

export function buildServer(service: DuskService, opts: { maxWaitSec?: number } = {}): McpServer {
  const maxWait = opts.maxWaitSec ?? 300
  const server = new McpServer({ name: 'dusk', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS })

  server.registerTool(
    'dusk_market',
    {
      title: 'Dusk market',
      description:
        'Live supply on the Dusk inference market: per model, how many workers are online and their ' +
        'asks in wei per 1k output tokens, plus this buyer\'s caps and the latest allowed deadline. ' +
        'Read-only and free. Call before dusk_submit to choose the model and bid.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => service.market()),
  )

  server.registerTool(
    'dusk_submit',
    {
      title: 'Submit inference job',
      description:
        'Post one text-completion job to the Dusk market and escrow its payment (ceil(bid * (prompt tokens + ' +
        'max_tokens) / 1000) wei of Galileo 0G, prompt tokens estimated from its length). Returns a job_id immediately; this server keeps authorising whichever ' +
        'worker claims it. Refuses, before spending anything, a bid no live worker would accept. ' +
        'Collect the answer with dusk_result.',
      inputSchema: {
        prompt: z.string().min(1).describe('The complete, self-contained prompt. The worker sees nothing else.'),
        model: z.string().min(1).describe('Model id from dusk_market, ideally one with workers > 0.'),
        max_tokens: z.number().int().positive().describe('Output token cap; also sets the escrow amount.'),
        max_price_per_1k_out: wei.describe('Bid in wei per 1000 output tokens (integer or decimal string).'),
        deadline_seconds: z
          .number()
          .int()
          .positive()
          .default(600)
          .describe('How long to wait for delivery before the escrow becomes refundable. Default 600.'),
        visibility: z
          .enum(['private', 'public'])
          .default('private')
          .describe('private (default): prompt and answer are encrypted, readable only by the claiming worker and you. public: both are readable by anyone on Swarm.'),
        trust_mode: z
          .enum(['standard', 'verified'])
          .default('standard')
          .describe('standard (default) accepts every provider of the model; verified requires a TEE provider.'),
        require_live_worker: z
          .boolean()
          .default(true)
          .describe('Refuse to post when no live worker would take this bid. Leave true unless you know a worker is about to come online.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (a) =>
      run(() =>
        service.submit({
          prompt: a.prompt,
          model: a.model,
          maxTokens: a.max_tokens,
          maxPricePer1kOut: a.max_price_per_1k_out,
          deadlineSec: a.deadline_seconds,
          visibility: a.visibility,
          trustMode: a.trust_mode,
          requireLiveWorker: a.require_live_worker,
        }),
      ),
  )

  server.registerTool(
    'dusk_result',
    {
      title: 'Collect job result',
      description:
        'Fetch a job\'s answer: waits up to wait_seconds for a worker\'s receipt, downloads the output from ' +
        'Swarm, unseals it if private, and checks its hash against the one the worker committed on chain. ' +
        'Returns status delivered (with output), pending (call again) or expired (escrow refundable).',
      inputSchema: {
        job_id: z.string().min(1).describe('The job_id returned by dusk_submit.'),
        wait_seconds: z
          .number()
          .int()
          .nonnegative()
          .max(maxWait)
          .default(60)
          .describe(`How long to block waiting for delivery, 0..${maxWait}. Default 60.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (a) => run(() => service.result(a.job_id, a.wait_seconds)),
  )

  server.registerTool(
    'dusk_jobs',
    {
      title: 'List submitted jobs',
      description: 'Jobs submitted through this server session, with their state. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => service.jobs()),
  )

  return server
}
