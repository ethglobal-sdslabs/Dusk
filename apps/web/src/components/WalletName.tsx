'use client'

import { useEffect, useState } from 'react'
import type { VerifiedIdentity } from '@dusk/ens'
import { identityFor, walletLabel } from '../lib/ens'

export function WalletName({ address, className }: { address: string; className?: string }) {
  const [identity, setIdentity] = useState<VerifiedIdentity | undefined>(undefined)

  useEffect(() => {
    let live = true
    setIdentity(undefined)
    const refresh = () => identityFor(address)?.then((read) => { if (live) setIdentity(read) }, () => {})
    void refresh()
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail?.toLowerCase() === address.toLowerCase()) void refresh()
    }
    const timer = window.setInterval(() => { void refresh() }, 60_000)
    window.addEventListener('dusk:identity-changed', changed)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('dusk:identity-changed', changed) }
  }, [address])

  const label = walletLabel(address, identity)
  return (
    <span className={['wallet-name', className].filter(Boolean).join(' ')} title={label.note ? `${label.title} — ${label.note}` : label.title} data-verified={label.verified}>
      {label.text}
      {label.note && <span className="wallet-name-note"> · name unverified</span>}
    </span>
  )
}
