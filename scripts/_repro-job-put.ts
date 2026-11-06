import 'dotenv/config'
import '@dusk/core/env'
import { loadConfig, partyKey } from '@dusk/core'
import { createArkivStore } from '@dusk/arkiv'

const config = loadConfig(process.env)
const buyer = partyKey(process.env, 'buyer')
const accessKey = process.env.ARKIV_ACCESS_KEY?.trim()

const store = createArkivStore({
  rpc: config.arkiv.rpc,
  chainId: config.arkiv.chainId,
  privateKey: buyer,
  ...(accessKey ? { accessKey } : {}),
})

const job = {
  model: '0gm-1.0-35b-a3b',
  maxPricePer1kOut: 1000n,
  maxTokens: 8,
  trustMode: 'verified',
  visibility: 'public',
  inputRef: 'ab'.repeat(32),
  inputHash: `0x${'cd'.repeat(32)}`,
  buyerPubkey: `0x04${'ef'.repeat(64)}`,
  escrowId: `0x${'12'.repeat(32)}`,
  status: 'open',
  expiresAt: Date.now() + 600_000,
}

console.log('writer', store.address)
console.log('job', job)

function dump(e: unknown, depth = 0): void {
  const pad = '  '.repeat(depth)
  if (!(e instanceof Error)) {
    console.log(pad, 'non-error:', e)
    return
  }
  console.log(`${pad}${e.name}: ${e.message}`)
  for (const k of ['shortMessage', 'details', 'metaMessages', 'data', 'abiItem'] as const) {
    const v = (e as unknown as Record<string, unknown>)[k]
    if (v !== undefined) console.log(pad, k, '=', v)
  }
  if (e.cause) dump(e.cause, depth + 1)
}

try {
  const id = await store.put('job', job, { ttlSeconds: 120 })
  console.log('OK job key', id)
} catch (e) {
  console.log('\n──── FAILED ────')
  dump(e)
}
