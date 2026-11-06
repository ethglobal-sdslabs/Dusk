import type { NextConfig } from 'next'
import { readCredentials } from '../../packages/core/src/credentials-file'
import { credentialEnv } from '../../packages/core/src/credentials'
import { publicSettingsEnv } from '../../packages/core/src/file-settings'

const credentials = readCredentials()
Object.assign(process.env, credentialEnv(credentials))

const nextConfig: NextConfig = {
  env: publicSettingsEnv(credentials.settings),
  transpilePackages: [
    '@dusk/core',
    '@dusk/arkiv',
    '@dusk/buyer',
    '@dusk/crypto',
    '@dusk/ens',
    '@dusk/escrow',
    '@dusk/og',
    '@dusk/swarm',
    '@dusk/signer',
    '@dusk/worker',
  ],

  typescript: { tsconfigPath: './tsconfig.build.json' },
}

export default nextConfig
