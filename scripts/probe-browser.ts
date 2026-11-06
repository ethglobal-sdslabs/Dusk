import 'dotenv/config'
import '@dusk/core/env'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@dusk/core'
import { DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'

const config = loadConfig(process.env)
const ogBase = config.og.baseUrl
const targets = {
  ogModels: `${ogBase}/v1/models`,
  arkivRpc: config.arkiv.rpc,
  swarmUpload: `${config.swarm.endpoint ?? DEFAULT_UPLOAD_URL}/`,
  swarmDownload: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
}

const page = (t: typeof targets) => `<!doctype html>
<meta charset="utf-8"><title>dusk browser probe</title>
<pre id="out">running…</pre>
<script type="module">
const T = ${JSON.stringify(t)}
const results = []

async function probe(name, fn) {
  const started = performance.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), detail })
  } catch (e) {
    results.push({
      name, ok: false, ms: Math.round(performance.now() - started),
      error: String(e && e.message || e),
      likelyCors: e instanceof TypeError,
    })
  }
}

await probe('og.models (no auth)', async () => {
  const r = await fetch(T.ogModels)
  const j = await r.json()
  return \`\${r.status}, \${j.data?.length ?? 0} models\`
})

await probe('og.completions preflight (Authorization allowed?)', async () => {
  const r = await fetch(T.ogModels.replace('/v1/models', '/v1/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer probe-not-a-key' },
    body: '{}',
  })
  return \`\${r.status} (reached the Router; a 4xx here is success for this probe)\`
})

await probe('arkiv.eth_chainId', async () => {
  const r = await fetch(T.arkivRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  })
  const j = await r.json()
  return \`\${r.status}, chainId \${parseInt(j.result, 16)}\`
})

let ref = null
await probe('swarm.upload', async () => {
  const r = await fetch(T.swarmUpload + 'bzz', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'swarm-postage-batch-id': '0'.repeat(64),
    },
    body: new TextEncoder().encode('dusk browser probe'),
  })
  const j = await r.json()
  ref = j.reference
  return \`\${r.status}, ref \${String(ref).slice(0, 16)}…\`
})

await probe('swarm.download', async () => {
  if (!ref) throw new Error('no reference from the upload probe')
  const r = await fetch(\`\${T.swarmDownload}/bzz/\${ref}/\`)
  const text = await r.text()
  return \`\${r.status}, \${text === 'dusk browser probe' ? 'round-tripped' : 'MISMATCH: ' + text.slice(0, 40)}\`
})

document.title = 'done'
document.getElementById('out').textContent = JSON.stringify(results, null, 2)
</script>`

const PORT = Number(process.env.DUSK_PROBE_PORT ?? 3000)
const HOST = process.env.DUSK_PROBE_HOST ?? 'localhost'
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page(targets))
})

const CHROME = process.env.CHROME_BIN ?? 'google-chrome'
const profile = mkdtempSync(join(tmpdir(), 'dusk-probe-'))

await new Promise<void>((r) => server.listen(PORT, r))
console.log(`── dusk browser probe ──`)
console.log(`  serving   http://${HOST}:${PORT}`)
console.log(`  targets   ${Object.values(targets).join('\n            ')}`)
console.log(`  browser   ${CHROME}`)
console.log('')

const dom = await new Promise<string>((resolve, reject) => {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=25000',
    '--dump-dom',
    `http://${HOST}:${PORT}/`,
  ])
  let out = ''
  let err = ''
  chrome.stdout.on('data', (d) => (out += d))
  chrome.stderr.on('data', (d) => (err += d))
  chrome.on('error', reject)
  chrome.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${CHROME} exited ${code}: ${err.slice(0, 400)}`)))) // eslint-disable-line
})

server.close()
rmSync(profile, { recursive: true, force: true })

const body = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1] ?? ''
const decoded = body.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

let results: Array<{ name: string; ok: boolean; ms: number; detail?: string; error?: string; likelyCors?: boolean }>
try {
  results = JSON.parse(decoded)
} catch {
  console.log('could not parse the probe output. Raw DOM follows:\n')
  console.log(dom.slice(0, 2000))
  process.exit(1)
}

for (const r of results) {
  const mark = r.ok ? '✓' : '✗'
  console.log(`  ${mark} ${r.name.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${r.ok ? r.detail : r.error}`)
  if (!r.ok && r.likelyCors) {
    console.log(`      ↑ opaque TypeError — this is what a CORS refusal looks like to fetch`)
  }
}

const blocked = results.filter((r) => !r.ok)
console.log('')
console.log(
  blocked.length === 0
    ? '✓ every target is reachable from a browser origin — /earn can run the worker loop in-tab'
    : `✗ ${blocked.length} target(s) unreachable: ${blocked.map((b) => b.name).join(', ')}`,
)
process.exit(blocked.length === 0 ? 0 : 1)
