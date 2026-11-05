import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk'
import { asc, MAX_LIMIT, type Expression } from '@arkiv-network/sdk/query'
import { http, type Account, type Address, type Hex } from 'viem'
import { assertBlockAligned, type ArkivStore, type Kind } from '@dusk/core'
import { localSigner, signerTransport, type DuskSigner } from '@dusk/signer'
import { rabdi } from '@arkiv-network/sdk/chains'
import { schemaFor } from './schemas'
import { decode, encode, kindTag } from './codec'
import { asQuotaError, parseQuotaHeaders, type ArkivQuota } from './quota'

export type ArkivStoreConfig = ArkivTransportInput & {
  rpc: string
  chainId: number
  signer?: DuskSigner
  privateKey?: Hex
}

const FLAGS: Partial<Record<Kind, { readonly?: boolean; permissionlessExtension?: boolean }>> = {
  job: { permissionlessExtension: true },
  receipt: { readonly: true },
  verification: { readonly: true },
}

export type DuskArkivStore = ArkivStore & { address: Address }

export type ArkivReader = Pick<ArkivStore, 'query'>

export type ArkivReaderConfig = ArkivTransportInput & { rpc: string; chainId: number }

const DEFAULT_ATTEMPTS = 4

async function withRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
  let last: unknown
  for (let i = 1; i <= DEFAULT_ATTEMPTS; i++) {
    try {
      return await op()
    } catch (e) {
      last = e
      const quota = asQuotaError(e)
      if (quota) throw quota
      const msg = e instanceof Error ? e.message : String(e)
      const transient = /fetch failed|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket|network|HTTP request failed/i.test(msg)
      if (!transient || i === DEFAULT_ATTEMPTS) throw e
      await new Promise((r) => setTimeout(r, i * 500))
    }
  }
  throw last
}

const READ_TIMEOUT_MS = 15_000

export const ARKIV_TRANSPORT_OPTS = { retryCount: 0, timeout: READ_TIMEOUT_MS } as const

const OG_KEY_SHAPED = /\b(sk|mk)-/

export type ArkivTransportInput = {
  accessKey?: string
  onQuota?: (quota: ArkivQuota) => void
}

export class ArkivKeyRejectedError extends Error {
  override readonly name = 'ArkivKeyRejectedError'

  constructor() {
    super(
      'Arkiv rejected ARKIV_ACCESS_KEY with 401. Access keys are per-network and ' +
        'per-origin, so the usual causes are a key issued for a different Arkiv network ' +
        'than this build targets, or an origin restriction that does not cover this one. ' +
        'Either use a key that fits, or UNSET ARKIV_ACCESS_KEY — the public endpoint still ' +
        'serves reads, heavily rate limited but not broken, whereas a rejected key fails ' +
        'every single request including eth_blockNumber. The key is deliberately not ' +
        'repeated here.',
    )
  }
}

export function arkivTransportOpts(input: ArkivTransportInput = {}): {
  retryCount: 0
  timeout: number
  onFetchResponse?: (response: Response) => void
} {
  const accessKey = input.accessKey?.trim()
  if (accessKey && OG_KEY_SHAPED.test(accessKey)) {
    throw new Error(
      'The Arkiv access key looks like a 0G API key. Arkiv wants an access key from ' +
        'https://hub.arkiv.network/access-keys, which buys read quota and nothing else; a ' +
        '0G key spends credits with no cap and must never leave the process that reads it. ' +
        'The value is not repeated here on purpose.',
    )
  }
  const onQuota = input.onQuota
  return {
    ...ARKIV_TRANSPORT_OPTS,
    ...(onQuota || accessKey
      ? {
          onFetchResponse: (response: Response): void => {
            if (accessKey && response.status === 401) throw new ArkivKeyRejectedError()
            if (onQuota) {
              const quota = parseQuotaHeaders(response.headers)
              if (quota) onQuota(quota)
            }
          },
        }
      : {}),
  }
}

export function arkivChain(cfg: ArkivTransportInput): ReturnType<typeof rabdi> {
  const accessKey = cfg.accessKey?.trim() ?? ''
  if (accessKey === '') warnNoAccessKey()
  return rabdi({ accessKey })
}

let warnedNoAccessKey = false
function warnNoAccessKey(): void {
  if (warnedNoAccessKey) return
  warnedNoAccessKey = true
  const where =
    typeof window === 'undefined'
      ? 'ARKIV_ACCESS_KEY in .env'
      : 'NEXT_PUBLIC_ARKIV_ACCESS_KEY in .env, then rebuild — Next inlines it at build time'
  console.warn(
    `[arkiv] no access key, so reads go to the public endpoint and are heavily rate ` +
      `limited. Set ${where}. Free key: https://hub.arkiv.network/access-keys — it is ` +
      `per-network (use Rabdi) and is not a secret, so restrict it by origin instead.`,
  )
}

export function createArkivStore(cfg: ArkivStoreConfig): DuskArkivStore {
  const signer = cfg.signer ?? localSigner(cfg.privateKey as Hex)
  const chain = arkivChain(cfg)
  const transport = http(undefined, arkivTransportOpts(cfg))
  const pub = createPublicClient({ chain, transport })
  const wallet = createWalletClient({
    chain,
    transport: signerTransport(signer, transport),
    account: signer as Account,
  })

  const ensureChain = async (): Promise<void> => {
    await signer.switchChain?.({
      chainId: cfg.chainId,
      name: 'Arkiv Rabdi',
      rpcUrl: cfg.rpc,
      nativeCurrency: { name: 'GLM', symbol: 'GLM', decimals: 18 },
    })
  }

  return {
    address: signer.address,

    async put<T>(kind: Kind, data: T, opts: { ttlSeconds: number }): Promise<string> {
      const ttl = assertBlockAligned(opts.ttlSeconds)
      await ensureChain()
      const { entityKey } = await withRetry(`put ${kind}`, () =>
        wallet.createEntity(schemaFor(kind) as never, encode(kind, data) as never, {
          expiration: ExpirationTime.fromSeconds(ttl),
          ...(FLAGS[kind] ? { flags: FLAGS[kind] } : {}),
        }),
      )
      return entityKey
    },

    query: queryWith(pub),

    async extend(id: string, ttlSeconds: number): Promise<void> {
      await ensureChain()
      await withRetry('extend', () =>
        wallet.extendEntity({
          entityKey: id as Hex,
          expiration: ExpirationTime.fromSeconds(assertBlockAligned(ttlSeconds)),
        }),
      )
    },

    async del(id: string): Promise<void> {
      await ensureChain()
      await withRetry('delete', () => wallet.deleteEntity({ entityKey: id as Hex }))
    },
  }
}

export function createArkivReader(cfg: ArkivReaderConfig): ArkivReader {
  return {
    query: queryWith(
      createPublicClient({
        chain: arkivChain(cfg),
        transport: http(undefined, arkivTransportOpts(cfg)),
      }),
    ),
  }
}


type ArkivPublicClient = ReturnType<typeof createPublicClient>

export function queryWith(pub: ArkivPublicClient) {
  return async function query<T>(kind: Kind, filter?: Expression): Promise<T[]> {
    const schema = schemaFor(kind) as never

    const page = (offset: number) => {
      const base = pub.select().from(schema) as never as {
        where: (f: Expression) => typeof base
        orderBy: (o: unknown) => typeof base
        limit: (n: number) => typeof base
        offset: (n: number) => typeof base
        fetch: () => Promise<{ entities: readonly unknown[]; skipped: number }>
      }
      const scoped = filter ? base.where(filter) : base
      return scoped.orderBy(asc('$key')).limit(PAGE_SIZE).offset(offset).fetch()
    }

    const entities: unknown[] = []
    let offset = 0
    for (;;) {
      const p = await withRetry(`query ${kind}`, () => page(offset))
      entities.push(...p.entities)
      const covered = p.entities.length + p.skipped
      if (covered < PAGE_SIZE) break
      offset += covered
    }

    const out: T[] = []
    for (const e of entities) {
      try { out.push(decode<T>(kind, e as never)) } catch { }
    }
    return out
  }
}

const PAGE_SIZE = MAX_LIMIT

