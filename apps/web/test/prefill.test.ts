import { describe, expect, it } from 'vitest'
import { browserCredentials, fetchPrefill, EMPTY_PREFILL } from '../src/lib/prefill'

const KEY = `0x${'a'.repeat(64)}`
const ADDRESS = '0x8fd379246834eac74B8419FfdA202CF8051F7A03'

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('fetchPrefill', () => {
  it('returns public addresses and discards wallet private keys', async () => {
    const got = await fetchPrefill(respond({ buyerPrivateKey: KEY, buyerAddress: ADDRESS }))
    expect(got).toEqual({ buyerAddress: ADDRESS })
  })

  it('returns nothing for an empty file', async () => {
    expect(await fetchPrefill(respond({}))).toEqual(EMPTY_PREFILL)
  })

  it('returns nothing on a 403, which is what a non-loopback origin gets', async () => {
    expect(await fetchPrefill(respond({ error: 'nope' }, 403))).toEqual(EMPTY_PREFILL)
  })

  it('returns nothing when the endpoint is absent, not an unhandled rejection', async () => {
    const dead = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(fetchPrefill(dead)).resolves.toEqual(EMPTY_PREFILL)
  })

  it('returns nothing when the body is not JSON', async () => {
    const html = (async () => new Response('<!doctype html>')) as unknown as typeof fetch
    expect(await fetchPrefill(html)).toEqual(EMPTY_PREFILL)
  })

  it('drops a field that is not the shape its name promises', async () => {
    const got = await fetchPrefill(
      respond({ buyerPrivateKey: 'not-a-key', buyerAddress: ADDRESS, ogComputeKey: 42 }),
    )
    expect(got).toEqual({ buyerAddress: ADDRESS })
  })

  it('drops an empty string rather than prefilling a field with one', async () => {
    expect(await fetchPrefill(respond({ buyerPrivateKey: '', ogComputeKey: '  ' }))).toEqual(
      EMPTY_PREFILL,
    )
  })
})


describe('browser credentials boundary', () => {
  it('never returns wallet or ENS operator private keys', () => {
    const result = browserCredentials({
      buyerPrivateKey: KEY, workerPrivateKey: KEY, buyerAddress: ADDRESS,
      ENS_OWNER_PRIVATE_KEY: KEY, ENS_REVOKER_PRIVATE_KEY: KEY,
      ENS_UNBANNER_PRIVATE_KEY: KEY, ENS_INDEXER_PRIVATE_KEY: KEY,
      ENS_ATTESTER_PRIVATE_KEY: KEY, ENS_SUBMITTER_PRIVATE_KEY: KEY,
      settings: { ENS_OWNER_PRIVATE_KEY: KEY, ENS_REVOKER_PRIVATE_KEY: KEY },
      ogComputeKey: 'sk-local-compute', ogAccessKey: 'mk-local-read',
    })
    expect(result).toEqual({ buyerAddress: ADDRESS, ogComputeKey: 'sk-local-compute', ogAccessKey: 'mk-local-read' })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
