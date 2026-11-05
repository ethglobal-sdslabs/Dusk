import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

function pkg(name: string): string {
  return fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))
}

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { exclude: [...configDefaults.exclude, '**/*.bun.test.js'] },
  resolve: {
    alias: {
      '@dusk/core/env': fileURLToPath(new URL('./packages/core/src/env.ts', import.meta.url)),
      '@dusk/core/credentials-file': fileURLToPath(
        new URL('./packages/core/src/credentials-file.ts', import.meta.url),
      ),
      '@dusk/core': pkg('core'),
      '@dusk/ens': pkg('ens'),
      '@dusk/og/e2ee': fileURLToPath(new URL('./packages/og/src/e2ee.ts', import.meta.url)),
      '@dusk/og/sealed': fileURLToPath(new URL('./packages/og/src/sealed.ts', import.meta.url)),
      '@dusk/buyer/verify': fileURLToPath(new URL('./packages/buyer/src/verify.ts', import.meta.url)),
      '@dusk/og': pkg('og'),
      '@dusk/arkiv': pkg('arkiv'),
      '@dusk/swarm': pkg('swarm'),
      '@dusk/escrow': pkg('escrow'),
      '@dusk/crypto': pkg('crypto'),
      '@dusk/buyer': pkg('buyer'),
      '@dusk/signer': pkg('signer'),
      '@dusk/worker/loop': fileURLToPath(new URL('./worker/src/loop.ts', import.meta.url)),
      '@dusk/worker/payout': fileURLToPath(new URL('./worker/src/payout.ts', import.meta.url)),
    },
  },
})
