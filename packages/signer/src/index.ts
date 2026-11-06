import {
  custom,
  getTypesForEIP712Domain,
  type Address,
  type EIP1193Provider,
  type Hex,
  type Transport,
  type TypedDataDefinition,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export type WalletChainRequest = {
  chainId: number
  name: string
  rpcUrl: string
  nativeCurrency?: { name: string; symbol: string; decimals: number }
}

export type DuskSigner = {
  address: Address
  type: 'local' | 'json-rpc'
  publicKey?: Hex
  provider?: EIP1193Provider
  switchChain?: (req: WalletChainRequest) => Promise<void>
  signTypedData: (parameters: TypedDataDefinition) => Promise<Hex>
}

export class WalletChainError extends Error {
  readonly expectedChainId: number
  readonly actualChainId: number
  constructor(message: string, expectedChainId: number, actualChainId: number) {
    super(message)
    this.name = 'WalletChainError'
    this.expectedChainId = expectedChainId
    this.actualChainId = actualChainId
  }
}

function errorCode(error: unknown): number | undefined {
  return (error as { code?: number } | null)?.code
}

function unsupportedMethod(error: unknown): boolean {
  if (errorCode(error) === -32601 || errorCode(error) === 4200) return true
  const message = error instanceof Error ? error.message : ''
  return /does not exist|not (?:be )?(?:found|supported|available)|unsupported method/i.test(message)
}

async function activeChainId(provider: EIP1193Provider): Promise<number> {
  const raw = (await provider.request({ method: 'eth_chainId' })) as string | number
  return typeof raw === 'number' ? raw : Number(raw)
}

export async function ensureWalletChain(
  provider: EIP1193Provider,
  req: WalletChainRequest,
): Promise<void> {
  if ((await activeChainId(provider)) === req.chainId) return

  const chainId = `0x${req.chainId.toString(16)}`
  const switchTo = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] as never })

  try {
    await switchTo()
  } catch (error) {
    if (errorCode(error) !== 4902) {
      const stuckOn = await activeChainId(provider).catch(() => -1)
      throw new WalletChainError(
        `Your wallet is on chain ${stuckOn} and would not switch to ${req.name} (chain ` +
          `${req.chainId}): ${error instanceof Error ? error.message : String(error)}. Dusk ` +
          `writes the escrow deal on 0G Galileo and the job record on Arkiv, so both ` +
          `networks have to be approved. Nothing was sent.`,
        req.chainId,
        stuckOn,
      )
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: req.name,
          rpcUrls: [req.rpcUrl],
          nativeCurrency: req.nativeCurrency ?? { name: 'Native token', symbol: 'ETH', decimals: 18 },
        },
      ] as never,
    })
    if ((await activeChainId(provider)) !== req.chainId) await switchTo()
  }

  const landed = await activeChainId(provider)
  if (landed !== req.chainId) {
    throw new WalletChainError(
      `Your wallet is on chain ${landed} and this write needs ${req.name} (chain ` +
        `${req.chainId}). It was asked to switch and did not. Switch networks in the ` +
        `wallet and try again — nothing was sent.`,
      req.chainId,
      landed,
    )
  }
}

export async function requestWalletAccounts(provider: EIP1193Provider): Promise<Address[]> {
  try {
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] as never })
  } catch (error) {
    if (!unsupportedMethod(error)) throw error
  }
  return (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
}

export async function revokeWalletAccess(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] as never })
  } catch {
  }
}

export function localSigner(privateKey: Hex): DuskSigner {
  return privateKeyToAccount(privateKey) as DuskSigner
}

export async function browserWalletSigner(provider: EIP1193Provider): Promise<DuskSigner> {
  const accounts = await requestWalletAccounts(provider)
  const address = accounts[0]
  if (!address) throw new Error('The wallet returned no account to sign with.')
  return walletSignerFor(provider, address)
}

export function walletSignerFor(provider: EIP1193Provider, address: Address): DuskSigner {
  return {
    address,
    type: 'json-rpc',
    provider,
    publicKey: undefined,
    signTypedData: async (parameters: TypedDataDefinition): Promise<Hex> => {
      await ensureWalletAccount(provider, address)
      const { domain, types, primaryType, message } = parameters
      const fullTypes = {
        EIP712Domain: getTypesForEIP712Domain({ domain }),
        ...(types as Record<string, unknown>),
      }
      return (await provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify({ domain, types: fullTypes, primaryType, message })] as never,
      })) as Hex
    },
    switchChain: (req: WalletChainRequest) => ensureWalletChain(provider, req),
  }
}

export async function ensureWalletAccount(provider: EIP1193Provider, expected: Address): Promise<void> {
  const accounts = await provider.request({ method: 'eth_accounts' })
  if (!accounts[0] || accounts[0].toLowerCase() !== expected.toLowerCase()) {
    throw new Error('The connected wallet changed or disconnected. Reconnect the intended account before signing; nothing was sent.')
  }
}

const WALLET_ONLY = new Set([
  'eth_accounts',
  'eth_requestAccounts',
  'eth_chainId',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'personal_sign',
])

export function walletHandles(method: string): boolean {
  return WALLET_ONLY.has(method) || method.startsWith('wallet_')
}

export function hybridTransport(provider: Pick<EIP1193Provider, 'request'>, read: Transport): Transport {
  const wallet = custom(provider)
  return ((config) => {
    const walletLeg = wallet(config)
    const readLeg = read(config)
    return {
      ...readLeg,
      request: ((args: { method: string; params?: unknown }) =>
        walletHandles(args.method)
          ? walletLeg.request(args as never)
          : readLeg.request(args as never)) as typeof readLeg.request,
    }
  }) as Transport
}

export function signerTransport(signer: DuskSigner, read: Transport): Transport {
  if (!signer.provider) return read
  const provider = signer.provider
  const guarded = {
    request: (async (args: { method: string }) => {
      if (args.method.startsWith('eth_sign') || ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign'].includes(args.method)) {
        await ensureWalletAccount(provider, signer.address)
      }
      return provider.request(args as never)
    }) as EIP1193Provider['request'],
  }
  return hybridTransport(guarded, read)
}
