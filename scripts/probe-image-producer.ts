import 'dotenv/config'
import '@dusk/core/env'
import { imageJobInput, loadConfig, sniffImage, type Job } from '@dusk/core'
import { createOgImageClient, redactKeyish } from '@dusk/og'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import { createImageProducer } from '../worker/src/produce-image'
import { keccak256 } from 'viem'

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const inferKey = process.env.OG_INFERE_MAIN
  if (!inferKey) throw new Error('og.computeKey (OG_INFERE_MAIN) is required')

  const image = createOgImageClient({ baseUrl: config.og.baseUrl, inferKey })
  const produce = createImageProducer({ image, now: Date.now })
  const swarm = createSwarmStore({
    uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
    downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
  })

  const now = Date.now()
  const job = {
    id: 'probe-image-producer',
    model: 'z-image-turbo',
    maxTokens: 1,
    trustMode: 'verified',
    expiresAt: now + 10 * 60_000,
  } as Job

  console.log('generating…')
  const p = await produce(job, imageJobInput('a paper boat on a pond, ink and wash', config.og.imageSize), {
    giveUpAt: job.expiresAt - 90_000,
  })
  console.log(`  ${p.bytes.length} bytes, ${p.contentType}, ${p.latencyMs} ms, creditsSpent ${p.creditsSpent}`)

  const ref = await swarm.upload(p.bytes, { contentType: p.contentType })
  const back = await swarm.download(ref)
  const same = back.length === p.bytes.length && back.every((b, i) => b === p.bytes[i])
  const downloadBase = config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL
  const head = await fetch(`${downloadBase}/bzz/${ref}/`, { method: 'HEAD' })

  console.log(`  swarm ref      : ${ref}`)
  console.log(`  open it        : ${downloadBase}/bzz/${ref}/`)
  console.log(`  round trip     : ${same ? 'identical bytes' : 'MISMATCH'}`)
  console.log(`  re-sniffed     : ${sniffImage(back)}`)
  console.log(`  gateway serves : ${head.headers.get('content-type')}`)
  console.log(`  keccak256      : ${keccak256(p.bytes)}`)
  if (!same || sniffImage(back) !== p.contentType) process.exit(1)
}

main().catch((e) => {
  console.error(redactKeyish(e instanceof Error ? (e.stack ?? e.message) : String(e)))
  process.exit(1)
})
