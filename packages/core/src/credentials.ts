import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { ConfigError, keyDefect, normaliseKey } from './config'
import { FILE_SETTINGS, parseFileSettings } from './file-settings'

export interface DuskCredentials {
  settings?: Record<string, string>
  buyerPrivateKey?: Hex
  buyerAddress?: Address
  workerPrivateKey?: Hex
  workerAddress?: Address
  ogComputeKey?: string
  ogAccessKey?: string
}

export const CREDENTIAL_ENV_NAMES = {
  buyerPrivateKey: 'DUSK_BUYER_PRIVATE_KEY',
  buyerAddress: 'DUSK_BUYER_ADDRESS',
  workerPrivateKey: 'DUSK_WORKER_PRIVATE_KEY',
  workerAddress: 'DUSK_WORKER_ADDRESS',
  ogComputeKey: 'OG_INFERE_MAIN',
  ogAccessKey: 'OG_MANAGE_MAIN',
} as const satisfies Record<Exclude<keyof DuskCredentials, 'settings'>, string>

export const CREDENTIALS_FILE = 'config.json'

const OG_KEY = /\b(sk|mk)-/
const SIGNING_KEY = /^(0x)?[0-9a-fA-F]{64}$/

const PARTY_FIELDS = ['privateKey', 'address'] as const
const OG_FIELDS = ['computeKey', 'accessKey'] as const
const TOP_LEVEL = ['sender', ...Object.keys(FILE_SETTINGS)]

function isComment(key: string): boolean {
  return key.startsWith('_') || key.startsWith('//') || key.startsWith('$')
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where} must be a JSON object. Copy config.user.example.json or config.developer.example.json and ` +
        'fill in what you have; every field in it is optional.',
    )
  }
  return value as Record<string, unknown>
}

function checkFields(object: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (isComment(key)) continue
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${CREDENTIALS_FILE}: ${where} has an unknown field ${JSON.stringify(key)}. ` +
          `Known fields here: ${allowed.join(', ')}. A misspelled field would otherwise look ` +
          'configured while everything still asked you for it by hand.',
      )
    }
  }
}

function text(object: Record<string, unknown>, field: string, where: string): string | undefined {
  const raw = object[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where}.${field} must be a string in quotes, not a ` +
        `${Array.isArray(raw) ? 'list' : typeof raw}.`,
    )
  }
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function privateKeyOf(object: Record<string, unknown>, where: string): Hex | undefined {
  const raw = text(object, 'privateKey', where)
  if (raw === undefined) return undefined
  if (OG_KEY.test(raw)) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where}.privateKey is a 0G API key, not a signing key. This field ` +
        'signs Arkiv entities and Galileo transactions, so it wants the throwaway testnet key ' +
        'that pays their gas. A 0G inference key has no spend cap and belongs in og.computeKey. ' +
        'The value is deliberately not repeated here.',
    )
  }
  const key = normaliseKey(raw)
  const defect = keyDefect(key)
  if (defect) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where}.privateKey is not a 32-byte private key: ${defect}. A ` +
        'leading "0x" is optional. The value is deliberately not repeated here.',
    )
  }
  return key as Hex
}

function addressOf(object: Record<string, unknown>, where: string): Address | undefined {
  const raw = text(object, 'address', where)
  if (raw === undefined) return undefined
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where}.address must be 0x followed by 40 hex characters — a ` +
        `wallet address, not a key. That is ${raw.length} characters.`,
    )
  }
  return raw as Address
}

function agree(key: Hex | undefined, address: Address | undefined, where: string): void {
  if (!key || !address) return
  const owned = privateKeyToAccount(key).address
  if (owned.toLowerCase() !== address.toLowerCase()) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: ${where}.address is not the account ${where}.privateKey owns. One ` +
        'of the two is a stale paste. They have to agree, because every consumer derives the ' +
        "signer from the key and reads the address for display — and Dusk's funding check " +
        'compares the Galileo deal.buyer against the Arkiv job.owner, so a divergence here ' +
        'makes every job look like a forgery with no error anywhere. Neither value is repeated.',
    )
  }
}

function ogKeyOf(
  object: Record<string, unknown>,
  field: 'computeKey' | 'accessKey',
  wrongPrefix: 'sk-' | 'mk-',
  why: string,
): string | undefined {
  const raw = text(object, field, 'og')
  if (raw === undefined) return undefined
  if (SIGNING_KEY.test(raw)) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: og.${field} is 64 hex characters, which is a wallet signing key, not ` +
        'a 0G API key. Those go in buyer.privateKey / worker.privateKey. The value is not repeated.',
    )
  }
  if (raw.startsWith(wrongPrefix)) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: og.${field} starts with "${wrongPrefix}", so the two 0G keys are the ` +
        `wrong way round. ${why} Swapped, nothing errors at load — the value is not repeated here.`,
    )
  }
  return raw
}

export function parseCredentials(raw: unknown): DuskCredentials {
  const root = asObject(raw, 'the file')
  checkFields(root, TOP_LEVEL, 'the file')

  if (root.worker !== undefined && root.sender !== undefined) {
    throw new ConfigError(
      `${CREDENTIALS_FILE}: both "worker" and "sender" are set. They are the same party — ` +
        '"sender" is accepted as an alias — so one of them is being ignored. Keep "worker".',
    )
  }

  const buyer = asObject(root.buyer ?? {}, 'buyer')
  const worker = asObject(root.worker ?? root.sender ?? {}, root.sender !== undefined ? 'sender' : 'worker')
  const og = asObject(root.og ?? {}, 'og')
  checkFields(buyer, [...PARTY_FIELDS, ...Object.keys(FILE_SETTINGS.buyer)], 'buyer')
  checkFields(worker, [...PARTY_FIELDS, ...Object.keys(FILE_SETTINGS.worker)], root.sender !== undefined ? 'sender' : 'worker')
  checkFields(og, [...OG_FIELDS, ...Object.keys(FILE_SETTINGS.og)], 'og')

  const workerWhere = root.sender !== undefined ? 'sender' : 'worker'
  const buyerPrivateKey = privateKeyOf(buyer, 'buyer')
  const buyerAddress = addressOf(buyer, 'buyer')
  const workerPrivateKey = privateKeyOf(worker, workerWhere)
  const workerAddress = addressOf(worker, workerWhere)
  agree(buyerPrivateKey, buyerAddress, 'buyer')
  agree(workerPrivateKey, workerAddress, workerWhere)

  const ogComputeKey = ogKeyOf(
    og,
    'computeKey',
    'mk-',
    'computeKey is the sk- inference key that runs completions;',
  )
  const ogAccessKey = ogKeyOf(
    og,
    'accessKey',
    'sk-',
    'accessKey is the mk- management key that reads the credit balance, and the Router answers ' +
      'an sk- key there with 403 insufficient_scope;',
  )

  const settings = parseFileSettings({ ...root, worker })

  return {
    ...(buyerPrivateKey ? { buyerPrivateKey } : {}),
    ...(buyerAddress ? { buyerAddress } : {}),
    ...(workerPrivateKey ? { workerPrivateKey } : {}),
    ...(workerAddress ? { workerAddress } : {}),
    ...(ogComputeKey ? { ogComputeKey } : {}),
    ...(ogAccessKey ? { ogAccessKey } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
  }
}

export function parseCredentialsJson(text: string, where = CREDENTIALS_FILE): DuskCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(
      `${where} is not valid JSON. ` +
        'JSON has no comments and no trailing commas — put notes under a field whose name ' +
        'starts with "_".',
    )
  }
  return parseCredentials(parsed)
}

export function credentialEnv(credentials: DuskCredentials): Record<string, string> {
  const env: Record<string, string> = { ...credentials.settings }
  if (credentials.settings?.OG_BASE_URL_MAIN !== undefined) env.OG_BASE_URL = credentials.settings.OG_BASE_URL_MAIN
  for (const [field, name] of Object.entries(CREDENTIAL_ENV_NAMES)) {
    const value = credentials[field as keyof typeof CREDENTIAL_ENV_NAMES]
    if (value) env[name] = value
  }
  return env
}

export function applyCredentials(
  credentials: DuskCredentials,
  env: Record<string, string | undefined>,
): void {
  Object.assign(env, credentialEnv(credentials))
}
