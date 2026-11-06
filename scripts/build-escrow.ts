import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function compileEscrow(): { abi: unknown[]; bytecode: `0x${string}` } {
  const require = createRequire(import.meta.url)
  const solc = require('solc') as { compile(input: string): string; version(): string }
  if (!solc.version().startsWith('0.8.24')) throw new Error(`solc ${solc.version()} — DuskEscrow pins 0.8.24`)
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = readFileSync(join(root, 'contracts', 'src', 'DuskEscrow.sol'), 'utf8')
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { 'DuskEscrow.sol': { content: source } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
      }),
    ),
  )
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'))
  const c = out.contracts['DuskEscrow.sol'].DuskEscrow
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { abi, bytecode } = compileEscrow()
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const dir = join(root, 'contracts', 'out', 'DuskEscrow.sol')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'DuskEscrow.json'), JSON.stringify({ abi, bytecode: { object: bytecode } }, null, 2))
  console.log(`wrote contracts/out/DuskEscrow.sol/DuskEscrow.json (${(bytecode.length - 2) / 2} bytes)`)
}
