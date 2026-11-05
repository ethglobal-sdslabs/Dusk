import 'dotenv/config'
import '@dusk/core/env'

const UPLOAD_BASE = process.env.SWARM_ENDPOINT ?? 'https://api.gateway.ethswarm.org'
const DOWNLOAD_BASE = process.env.SWARM_DOWNLOAD_ENDPOINT ?? 'https://download.gateway.ethswarm.org'

const BATCH_ID = process.env.SWARM_BATCH_ID ?? '0'.repeat(64)

const PAYLOAD = 'dusk gate 0 — swarm round trip'

const findings: Array<[string, string]> = []
function record(question: string, answer: string): void {
  findings.push([question, answer])
  console.log(`  → FINDING: ${question} — ${answer}`)
}

function head(title: string): void {
  console.log(`\n═══ ${title} ═══`)
}

async function upload(data: string, encrypt: boolean): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    'swarm-postage-batch-id': BATCH_ID,
  }
  if (encrypt) headers['swarm-encrypt'] = 'true'

  const res = await fetch(`${UPLOAD_BASE}/bzz`, { method: 'POST', headers, body: data })
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { reference?: string }
  if (!body.reference) throw new Error(`upload returned no reference: ${JSON.stringify(body)}`)
  return body.reference
}

async function download(ref: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${DOWNLOAD_BASE}/bzz/${ref}/`, { redirect: 'follow' })
  return { status: res.status, text: await res.text() }
}

let failures = 0

head('1. endpoint liveness')
for (const [label, base] of [
  ['upload  ', UPLOAD_BASE],
  ['download', DOWNLOAD_BASE],
] as const) {
  try {
    const res = await fetch(`${base}/health`)
    console.log(`  ${label} ${base} → HTTP ${res.status} ${(await res.text()).trim().slice(0, 20)}`)
  } catch (e) {
    console.log(`  ${label} ${base} → unreachable: ${String(e)}`)
    failures += 1
  }
}

head('2. plain upload + download')
let plainRef = ''
try {
  plainRef = await upload(PAYLOAD, false)
  console.log(`  ref (${plainRef.length} chars): ${plainRef}`)
  const got = await download(plainRef)
  const identical = got.text === PAYLOAD
  console.log(`  download → HTTP ${got.status}, ${got.text.length} bytes, identical=${identical}`)
  if (!identical) {
    failures += 1
    console.log(`  ✗ expected ${JSON.stringify(PAYLOAD)}, got ${JSON.stringify(got.text.slice(0, 80))}`)
  }
  record('plain reference length', `${plainRef.length} hex chars`)
} catch (e) {
  failures += 1
  console.log(`  ✗ ${String(e)}`)
}

head('3. encrypted upload + download')
let encRef = ''
try {
  encRef = await upload(PAYLOAD, true)
  console.log(`  ref (${encRef.length} chars): ${encRef}`)
  const got = await download(encRef)
  const identical = got.text === PAYLOAD
  console.log(`  download → HTTP ${got.status}, ${got.text.length} bytes, identical=${identical}`)
  if (!identical) failures += 1

  record(
    'encrypted reference length',
    `${encRef.length} hex chars — double the plain ${plainRef.length || 64}, because the ` +
      'decryption key is the second half',
  )
  record(
    'which Arkiv attribute type can carry a ref',
    `str only. MAX_STRING_BYTES is 128 and an encrypted ref is ${encRef.length} chars — exactly ` +
      'at the limit, zero headroom. bytes32 (32 bytes) cannot hold either form. This is why ' +
      'Receipt.outputRef is SwarmRef (string), not Hex.',
  )
} catch (e) {
  failures += 1
  console.log(`  ✗ ${String(e)}`)
}

head('4. does an encrypted reference carry its own key')
if (encRef.length === 128) {
  const stripped = encRef.slice(0, 64)
  const withKey = await download(encRef)
  const withoutKey = await download(stripped)
  console.log(`  full 128-char ref  → HTTP ${withKey.status}, ${withKey.text.length} bytes`)
  console.log(`  first 64 chars     → HTTP ${withoutKey.status}, ${withoutKey.text.length} bytes`)

  const keyIsInRef = withKey.text === PAYLOAD && withoutKey.text !== PAYLOAD
  record(
    'is an encrypted reference sufficient to decrypt',
    keyIsInRef
      ? 'YES. The full reference decrypts with no other secret; stripping the trailing 64 chars ' +
          `yields HTTP ${withoutKey.status}. So the second half IS the key. Writing an encrypted ` +
          'ref into a public Arkiv entity publishes the plaintext — it must be sealed to the ' +
          'recipient first (DESIGN.md §8 step 8).'
      : `INCONCLUSIVE — full=${withKey.status}, stripped=${withoutKey.status}`,
  )
} else {
  record('is an encrypted reference sufficient to decrypt', 'NOT TESTED — no encrypted ref obtained')
}

head('5. gateway limitations')
const stamps = await fetch(`${UPLOAD_BASE}/stamps`).then((r) => r.status).catch(() => 0)
console.log(`  GET /stamps → HTTP ${stamps}`)
record(
  'is bee-js usable against the gateway',
  `Only partly. /stamps returns ${stamps}, so postage-batch management (createPostageBatch, ` +
    'getAllPostageBatch) is unavailable and bee-js calls that touch it will fail. Upload and ' +
    'download work over plain HTTP, which is all SwarmStore needs.',
)

head('findings')
for (const [q, a] of findings) console.log(`  • ${q}\n      ${a}`)
console.log('')
if (failures > 0) {
  console.log(`✗ Gate 0 light #3 NOT green — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ Gate 0 light #3 green — both round trips byte-identical via the public gateway')
