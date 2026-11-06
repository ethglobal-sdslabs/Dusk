import { config as loadDotenv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

console.log = console.error
console.info = console.error
console.debug = console.error

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.chdir(root)
loadDotenv({ path: resolve(root, '.env'), quiet: true })
