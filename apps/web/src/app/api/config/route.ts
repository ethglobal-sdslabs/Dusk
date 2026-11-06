import { readCredentials } from '@dusk/core/credentials-file'
import { ConfigError } from '@dusk/core'
import { configRequestAllowed } from '../../../lib/config-gate'
import { browserCredentials } from '../../../lib/prefill'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  if (!configRequestAllowed(request.headers)) {
    return Response.json(
      { error: 'config.json is only served to a loopback origin.' },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    )
  }

  try {
    const party = new URL(request.url).searchParams.get('wallet')
    if (party !== null) {
      if (party !== 'buyer' && party !== 'worker') return Response.json({ error: 'Unknown wallet.' }, { status: 400, headers: { 'cache-control': 'no-store' } })
      const credentials = readCredentials()
      const privateKey = party === 'buyer' ? credentials.buyerPrivateKey : credentials.workerPrivateKey
      return Response.json(privateKey ? { privateKey } : {}, { headers: { 'cache-control': 'no-store' } })
    }
    return Response.json(browserCredentials(readCredentials()), { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ConfigError
            ? error.message
            : 'config.json could not be read. The reason is withheld because it may quote the file.',
      },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}
