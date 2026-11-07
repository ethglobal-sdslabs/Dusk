'use client'

import { useCallback, useEffect, useState } from 'react'
import { localSigner, type DuskSigner } from '@dusk/signer'
import { unseal as unsealWith } from '@dusk/crypto'
import type { Hex } from 'viem'

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type WalletParty = 'buyer' | 'worker'
export type WalletState = {
  status: WalletStatus
  address: string | null
  signer: DuskSigner | null
  unseal: ((sealed: Hex) => string) | null
  error: string | null
  local: boolean | null
  connect: () => Promise<void>
  pasteKey: (raw: string) => string | null
  disconnect: () => void
}

const pasted: Partial<Record<WalletParty, Hex>> = {}
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

export function checkSigningKey(raw: string): { ok: true; key: Hex } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: 'Paste a wallet private key.' }
  if (/\b(sk|mk)-/i.test(trimmed)) {
    return { ok: false, error: 'That is a 0G API key, not a wallet key. Paste it in the 0G field instead.' }
  }
  const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    return { ok: false, error: 'A wallet private key is 64 hex characters, with or without a leading 0x.' }
  }
  return { ok: true, key: `0x${hex.toLowerCase()}` as Hex }
}

export function forgetPastedKeys(): void {
  delete pasted.buyer
  delete pasted.worker
  notify()
}

export function useWallet(party: WalletParty = 'buyer'): WalletState {
  const [status, setStatus] = useState<WalletStatus>('connecting')
  const [signer, setSigner] = useState<DuskSigner | null>(null)
  const [unseal, setUnseal] = useState<((sealed: Hex) => string) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<boolean | null>(null)

  const adopt = useCallback((key: Hex) => {
    setUnseal(() => (sealed: Hex) => unsealWith(sealed, key))
    setSigner(localSigner(key)); setError(null); setStatus('connected')
  }, [])

  const connect = useCallback(async () => {
    setStatus('connecting'); setError(null); setSigner(null); setUnseal(null)
    try {
      const response = await fetch(`/api/config?wallet=${party}`, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (response.status === 403) {
        setLocal(false)
        const held = pasted[party]
        if (held) adopt(held)
        else setStatus('disconnected')
        return
      }
      setLocal(true)
      if (!response.ok) throw new Error('Could not read the local configuration.')
      const data: unknown = await response.json()
      const key = data && typeof data === 'object' && 'privateKey' in data ? data.privateKey : undefined
      if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`Add ${party}.privateKey to config.json to use this account.`)
      adopt(key as Hex)
    } catch (e) {
      setStatus('error'); setError(e instanceof Error && /^Add |^Could not read/.test(e.message) ? e.message : 'Could not load the configured wallet.')
    }
  }, [party, adopt])

  const pasteKey = useCallback((raw: string): string | null => {
    const checked = checkSigningKey(raw)
    if (!checked.ok) return checked.error
    pasted[party] = checked.key
    notify()
    return null
  }, [party])

  const disconnect = useCallback(() => {
    delete pasted[party]
    setSigner(null); setUnseal(null); setStatus('disconnected')
    notify()
  }, [party])

  useEffect(() => { void connect() }, [connect])

  useEffect(() => {
    if (local !== false) return
    const sync = () => {
      const held = pasted[party]
      if (held) adopt(held)
      else { setSigner(null); setUnseal(null); setStatus('disconnected') }
    }
    listeners.add(sync)
    return () => { listeners.delete(sync) }
  }, [local, party, adopt])

  return { status, address: signer?.address ?? null, signer, unseal, error, local, connect, pasteKey, disconnect }
}
