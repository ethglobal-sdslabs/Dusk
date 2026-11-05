import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createSwarmStore,
  DEFAULT_DOWNLOAD_URL,
  DEFAULT_UPLOAD_URL,
  SwarmError,
} from '../src/client'

function beeGateway(): Promise<{ url: string; server: Server }> {
  const stored = new Map<string, Buffer>()
  let seq = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = req.url ?? '/'
      if (req.method === 'POST' && path === '/bzz') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const encrypted = req.headers['swarm-encrypt'] !== undefined
          const ref = String(seq++).padStart(encrypted ? 128 : 64, 'a')
          stored.set(ref, Buffer.concat(chunks))
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ reference: ref }))
        })
        return
      }
      const match = /^\/bzz\/([0-9a-fA-F]+)(\/?)$/.exec(path)
      if (req.method === 'GET' && match) {
        if (match[2] !== '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          return res.end('<!DOCTYPE html><html><body>landing page</body></html>')
        }
        const body = stored.get(match[1] as string)
        if (!body) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end('{"code":404}')
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(body)
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    )
  })
}

describe('SwarmStore', () => {
  const servers: Server[] = []
  afterAll(() => servers.forEach((s) => s.close()))

  const bytes = new TextEncoder().encode('dusk gate 1 round trip')

  async function localStore() {
    const gateway = await beeGateway()
    servers.push(gateway.server)
    return createSwarmStore({ uploadUrl: gateway.url, downloadUrl: gateway.url })
  }

  it('round-trips plaintext and returns a 64-char reference', async () => {
    const store = await localStore()
    const ref = await store.upload(bytes)
    expect(ref).toHaveLength(64)
    expect(await store.download(ref)).toEqual(bytes)
  })

  it('round-trips encrypted and returns a 128-char reference', async () => {
    const store = await localStore()
    const ref = await store.upload(bytes, { encrypt: true })
    expect(ref).toHaveLength(128)
    expect(await store.download(ref)).toEqual(bytes)
  })

  it('appends the trailing slash, so a landing page is never read as content', async () => {
    const store = await localStore()
    const ref = await store.upload(bytes)
    expect(await store.download(ref)).toEqual(bytes)
  })

  it('throws on an unknown reference instead of returning empty bytes', async () => {
    const store = await localStore()
    await expect(store.download('f'.repeat(64))).rejects.toThrow(SwarmError)
  })
})

describe.skipIf(!process.env.DUSK_LIVE_SWARM)('SwarmStore against the live gateway', () => {
  const store = createSwarmStore({
    uploadUrl: DEFAULT_UPLOAD_URL,
    downloadUrl: DEFAULT_DOWNLOAD_URL,
  })
  const bytes = new TextEncoder().encode('dusk gate 1 round trip')

  it('round-trips plaintext and returns a 64-char reference', async () => {
    const ref = await store.upload(bytes)
    expect(ref).toHaveLength(64)
    expect(await store.download(ref)).toEqual(bytes)
  }, 60_000)

  it('round-trips encrypted and returns a 128-char reference', async () => {
    const ref = await store.upload(bytes, { encrypt: true })
    expect(ref).toHaveLength(128)
    expect(await store.download(ref)).toEqual(bytes)
  }, 60_000)

  it('survives downloadUrl being pointed at the upload host', async () => {
    const misconfigured = createSwarmStore({
      uploadUrl: DEFAULT_UPLOAD_URL,
      downloadUrl: DEFAULT_UPLOAD_URL,
    })
    const ref = await misconfigured.upload(bytes)
    expect(await misconfigured.download(ref)).toEqual(bytes)
  }, 60_000)

  it('throws on an unknown reference instead of returning empty bytes', async () => {
    await expect(store.download('f'.repeat(64))).rejects.toThrow(SwarmError)
  }, 60_000)
})

describe('SwarmStore html guard', () => {
  let server: Server

  afterAll(() => server?.close())

  function htmlGateway(): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!DOCTYPE html><html><body>landing page</body></html>')
      })
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      )
    })
  }

  it('rejects a 200 response whose content-type is text/html', async () => {
    const url = await htmlGateway()
    const store = createSwarmStore({ uploadUrl: url, downloadUrl: url })
    await expect(store.download('a'.repeat(64))).rejects.toThrow(SwarmError)
    await expect(store.download('a'.repeat(64))).rejects.toThrow(/text\/html/)
  }, 30_000)
})

describe('SwarmStore retries', () => {
  const servers: Server[] = []
  afterAll(() => servers.forEach((s) => s.close()))

  function flakyGateway(failures: number, mode: 'reset' | '503'): Promise<string> {
    let seen = 0
    return new Promise((resolve) => {
      const server = createServer((_req, res) => {
        if (seen++ < failures) {
          if (mode === 'reset') return res.socket?.destroy()
          res.writeHead(503, { 'content-type': 'text/plain' })
          return res.end('upstream busy')
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end('recovered')
      })
      servers.push(server)
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      )
    })
  }

  it('retries through a dropped connection and succeeds', async () => {
    const url = await flakyGateway(2, 'reset')
    const store = createSwarmStore({ uploadUrl: url, downloadUrl: url })
    expect(new TextDecoder().decode(await store.download('a'.repeat(64)))).toBe('recovered')
  }, 30_000)

  it('retries through a 5xx and succeeds', async () => {
    const url = await flakyGateway(2, '503')
    const store = createSwarmStore({ uploadUrl: url, downloadUrl: url })
    expect(new TextDecoder().decode(await store.download('a'.repeat(64)))).toBe('recovered')
  }, 30_000)

  it('gives up after the retry budget and says how many attempts it made', async () => {
    const url = await flakyGateway(99, '503')
    const store = createSwarmStore({ uploadUrl: url, downloadUrl: url, retries: 2 })
    await expect(store.download('a'.repeat(64))).rejects.toThrow(/2 attempt/)
  }, 30_000)

  it('does not retry a 404', async () => {
    let hits = 0
    const server = createServer((_req, res) => {
      hits++
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"code":404}')
    })
    servers.push(server)
    const url = await new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    )
    const store = createSwarmStore({ uploadUrl: url, downloadUrl: url })
    await expect(store.download('a'.repeat(64))).rejects.toThrow(SwarmError)
    expect(hits).toBe(1)
  }, 30_000)
})
