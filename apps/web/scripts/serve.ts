import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { portVerdict, REQUIRED_PORT } from '../src/lib/port'
import { LOOPBACK_HOST, serveArgs } from '../src/lib/bind'

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(true)
      else reject(error)
    })
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, '0.0.0.0')
  })
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2)
  if (mode !== 'dev' && mode !== 'start') {
    console.error(`usage: tsx scripts/serve.ts <dev|start> [next flags]`)
    process.exitCode = 1
    return
  }

  const asked = portVerdict({ argv: rest, env: process.env, inUse: false })
  const verdict = asked.ok
    ? portVerdict({ argv: rest, env: process.env, inUse: await portInUse(REQUIRED_PORT) })
    : asked

  if (!verdict.ok) {
    console.error(`\n✗ ${verdict.message}\n`)
    process.exitCode = 1
    return
  }

  const built = serveArgs(mode, rest)
  if (!built.ok) {
    console.error(`\n✗ ${built.message}\n`)
    process.exitCode = 1
    return
  }
  const args = built.args

  console.log(`→ http://localhost:${REQUIRED_PORT}  (the only origin the 0G Router allows — friction #21)`)
  console.log(`  bound to ${LOOPBACK_HOST} only — /api/config serves your keys; never tunnel or expose this port`)
  const child = spawn('next', args, { stdio: 'inherit' })
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0)
  })
  child.on('error', (error) => {
    console.error(`\n✗ could not run \`next ${args.join(' ')}\`: ${error.message}\n`)
    process.exitCode = 1
  })
}

main().catch((error: unknown) => {
  console.error(`\n✗ could not check port ${REQUIRED_PORT}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
