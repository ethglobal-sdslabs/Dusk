'use client'

import { useId, useState, type FormEvent } from 'react'
import type { WalletState } from '../lib/wallet'

export function WalletKeyField({ wallet, label = 'Wallet private key' }: { wallet: WalletState; label?: string }) {
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const hint = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    const problem = wallet.pasteKey(raw)
    setError(problem)
    if (problem === null) setRaw('')
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>{label}</span>
        <input
          type="password"
          className="figure"
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setError(null) }}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={hint}
        />
        <span id={hint} className="meta">
          Use a throwaway testnet key. It stays in this tab&rsquo;s memory and is gone when you reload.
        </span>
        {error !== null && <span className="field-error" role="alert">{error}</span>}
      </label>
      <p><button type="submit" disabled={raw.trim() === ''}>Use this key</button></p>
    </form>
  )
}
