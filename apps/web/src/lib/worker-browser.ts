'use client'

import type { Address, Hex } from 'viem'
import { keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { DuskConfig, OgClient, OgImageClient } from '@dusk/core'
import { isImageModel } from '@dusk/core'
import { createArkivStore } from '@dusk/arkiv'
import { createEscrowClient } from '@dusk/escrow'
import { unseal } from '@dusk/crypto'
import { createOgClient, createOgImageClient, looksKeyish, OG_KEY_SHAPED, redactKeyish } from '@dusk/og'
import { createSealedOgClient, onChainServiceReader, routeByTrust } from '@dusk/og/sealed'
import { createSwarmStore, DEFAULT_DOWNLOAD_URL, DEFAULT_UPLOAD_URL } from '@dusk/swarm'
import type { WorkerDeps } from '@dusk/worker/loop'
import { createImageProducer } from '@dusk/worker/produce-image'
import { resolvePayout } from '@dusk/worker/payout'
import { localSigner, type DuskSigner } from '@dusk/signer'
import { newBudget } from '@dusk/worker/budget'
import { browserArkivAccessKey } from './config'
import { parseSigningKey } from './keys'
import { browserAdmit, type Admit } from './ens'

export { looksKeyish, OG_KEY_SHAPED, redactKeyish }

export function scrubError(error: unknown): Error & { status?: number } {
  const text =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  const scrubbed = new Error(redactKeyish(text)) as Error & { status?: number }
  if (error instanceof Error) scrubbed.name = error.name
  const status = (error as { status?: unknown })?.status
  if (typeof status === 'number') scrubbed.status = status
  return scrubbed
}

export function keySafeOg(og: OgClient): OgClient {
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (error) {
      throw scrubError(error)
    }
  }
  return {
    models: () => guard(() => og.models()),
    complete: (req, mode) => guard(() => og.complete(req, mode)),
    balance: () => guard(() => og.balance()),
  }
}

export function keySafeOgImage(image: OgImageClient): OgImageClient {
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call()
    } catch (error) {
      throw scrubError(error)
    }
  }
  return {
    submitImage: (req, mode) => guard(() => image.submitImage(req, mode)),
    pollImage: (sub) => guard(() => image.pollImage(sub)),
  }
}

export const MIXED_MODELS_MESSAGE =
  'Serve text models or image models in one tab, not both. Start a second tab for the other kind.'

export type OgKeyKind = 'infer' | 'manage'

export type ParsedOgKey = { ok: true; kind: OgKeyKind } | { ok: false; error: string }

export function parseOgKey(raw: string, expect: OgKeyKind): ParsedOgKey {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return {
      ok: false,
      error:
        expect === 'infer'
          ? 'Paste the 0G key that spends your credits. It stays in this tab.'
          : 'Paste the 0G key that reads your balance, or leave this empty and the credit level stays unknown.',
    }
  }
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    return {
      ok: false,
      error:
        'That is a 64-character signing key, not a 0G API key. It belongs in the Arkiv or ' +
        'Galileo field below, which sign transactions and pay gas.',
    }
  }
  const kind: OgKeyKind | null = /^sk-/i.test(trimmed)
    ? 'infer'
    : /^mk-/i.test(trimmed)
      ? 'manage'
      : null

  if (kind === null) {
    return {
      ok: false,
      error:
        'That does not look like a 0G API key. Copy it from your 0G account page — the two ' +
        'keys there are the one that spends credits and the one that only reads the balance.',
    }
  }
  if (kind !== expect) {
    return {
      ok: false,
      error:
        expect === 'infer'
          ? 'That is the management key, which can only read your balance. This field wants ' +
            'the key that spends credits, because spending them is the work.'
          : 'That is the key that spends credits, and it has no spend cap. This field only ' +
            'needs the management key with account:read, so paste that one instead.',
    }
  }
  return { ok: true, kind }
}

export type BrowserWorkerArgs = {
  config: DuskConfig
  inferKey: string
  manageKey?: string
  signer?: DuskSigner
  workerKey?: Hex
  pricePer1kOut: bigint
  models: string[]
  now?: () => number
  admit?: Admit
  unsealInput?: (sealed: Hex) => string
}

export type BrowserWorker = WorkerDeps & {
  arkivAddress: Address
  paid: boolean
}

export function buildBrowserWorker(args: BrowserWorkerArgs): BrowserWorker {
  const { config, inferKey, manageKey } = args

  const signer = args.signer ?? (args.workerKey ? localSigner(args.workerKey) : undefined)
  if (!signer) throw new Error('A wallet signer or signing key is required to earn.')

  if (args.workerKey) {
    const parsed = parseSigningKey(args.workerKey)
    if (!parsed.ok) throw new Error(`Your signing key is not usable. ${parsed.error}`)
  }

  const imageCount = args.models.filter((m) => isImageModel(m, config.og.imageModels)).length
  if (imageCount > 0 && imageCount < args.models.length) throw new Error(MIXED_MODELS_MESSAGE)
  const servesImages = imageCount > 0
  const now = args.now ?? (() => Date.now())

  const accessKey = browserArkivAccessKey()
  const store = createArkivStore({
    rpc: config.arkiv.rpc,
    chainId: config.arkiv.chainId,
    signer,
    ...(accessKey ? { accessKey } : {}),
  })

  const escrow = config.escrow.address
    ? createEscrowClient({
        rpc: config.escrow.rpc,
        chainId: config.escrow.chainId,
        address: config.escrow.address,
        signer,
      })
    : undefined

  return {
    arkiv: store,
    og: keySafeOg(
      routeByTrust(
        createOgClient({ baseUrl: config.og.baseUrl, inferKey, ...(manageKey ? { manageKey } : {}) }),
        createSealedOgClient({
          baseUrl: config.og.baseUrl,
          inferKey,
          ...(manageKey ? { manageKey } : {}),
          routerUrl: config.og.teeProof.routerUrl,
          readService: onChainServiceReader({ rpc: config.og.teeProof.rpc, servingContract: config.og.teeProof.servingContract }),
        }),
      ),
    ),
    swarm: createSwarmStore({
      uploadUrl: config.swarm.endpoint ?? DEFAULT_UPLOAD_URL,
      downloadUrl: config.swarm.downloadEndpoint ?? DEFAULT_DOWNLOAD_URL,
      ...(config.swarm.batchId ? { batchId: config.swarm.batchId } : {}),
    }),
    config,
    workerId: keccak256(toHex(signer.address)),
    arkivAddress: signer.address,
    payout: resolvePayout({
      ...(escrow ? { escrowSigner: escrow.signer } : {}),
      arkivAddress: signer.address,
    }),
    pricePer1kOut: args.pricePer1kOut,
    models: args.models,
    dayStartCredits: 0n,
    now,
    ...(escrow ? { escrow } : {}),
    ...(servesImages
      ? {
          produce: createImageProducer({
            image: keySafeOgImage(createOgImageClient({ baseUrl: config.og.baseUrl, inferKey })),
            now,
          }),
        }
      : {}),
    paid: escrow !== undefined,
    deliverMarginMs: config.ttl.claim * 1000,
    ...admitOf(args.admit),
    budget: newBudget(1),
    // The sealer runs on @noble (WebCrypto has no ChaCha20-Poly1305), so the tab can
    // prove what ran and takes TEE (private-tier) jobs like a headless worker.
    provesTee: true,
    ...(signer.publicKey ? { pubkey: signer.publicKey } : {}),
    ...(args.unsealInput
      ? { unsealInput: args.unsealInput }
      : args.workerKey
        ? { unsealInput: (sealed: Hex) => unseal(sealed, args.workerKey as Hex) }
        : {}),
  }
}

function admitOf(given?: Admit): { admit?: Admit } {
  const admit = given ?? browserAdmit()
  return admit ? { admit } : {}
}

export type KeyGuardEvent = {
  reason?: unknown
  error?: unknown
  message?: string
  preventDefault: () => void
}

export type KeyGuardHost = {
  addEventListener: (type: string, listener: (event: KeyGuardEvent) => void) => void
  removeEventListener: (type: string, listener: (event: KeyGuardEvent) => void) => void
}

export function installKeyGuard(host: KeyGuardHost, report: (message: string) => void): () => void {
  const handle = (event: KeyGuardEvent): void => {
    const raw = event.reason ?? event.error ?? event.message ?? 'unknown failure'
    const text = raw instanceof Error ? raw.message : String(raw)
    const leaking = looksKeyish(text)
    report(redactKeyish(text))
    if (leaking) event.preventDefault()
  }
  host.addEventListener('unhandledrejection', handle)
  host.addEventListener('error', handle)
  return () => {
    host.removeEventListener('unhandledrejection', handle)
    host.removeEventListener('error', handle)
  }
}
