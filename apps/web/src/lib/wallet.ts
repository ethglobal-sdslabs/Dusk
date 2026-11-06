'use client'

import { useCallback, useEffect, useState } from 'react'
import { localSigner, type DuskSigner } from '@dusk/signer'
import { unseal as unsealWith } from '@dusk/crypto'
import type { Hex } from 'viem'

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type WalletState = {
  status: WalletStatus
  address: string | null
  signer: DuskSigner | null
  unseal: ((sealed: Hex) => string) | null
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

export function useWallet(party: 'buyer' | 'worker' = 'buyer'): WalletState {
  const [status, setStatus] = useState<WalletStatus>('connecting')
  const [signer, setSigner] = useState<DuskSigner | null>(null)
  const [unseal, setUnseal] = useState<((sealed: Hex) => string) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connect = useCallback(async () => {
    setStatus('connecting'); setError(null); setSigner(null); setUnseal(null)
    try {
      const response = await fetch(`/api/config?wallet=${party}`, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('Could not read the local configuration.')
      const data: unknown = await response.json()
      const key = data && typeof data === 'object' && 'privateKey' in data ? data.privateKey : undefined
      if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`Add ${party}.privateKey to config.json to use this account.`)
      const account = localSigner(key as Hex)
      setUnseal(() => (sealed: Hex) => unsealWith(sealed, key as Hex))
      setSigner(account); setStatus('connected')
    } catch (e) {
      setStatus('error'); setError(e instanceof Error && /^Add |^Could not read/.test(e.message) ? e.message : 'Could not load the configured wallet.')
    }
  }, [party])
  const disconnect = useCallback(() => { setSigner(null); setUnseal(null); setStatus('disconnected') }, [])
  useEffect(() => { void connect() }, [connect])
  return { status, address: signer?.address ?? null, signer, unseal, error, connect, disconnect }
}
