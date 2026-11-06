'use client'

import { useEffect, useRef } from 'react'
import type { WalletState } from '../lib/wallet'
import { useRequiredIdentity } from '../lib/use-required-identity'
import { EnsIdentity } from './EnsIdentity'

export function WalletNameOnboarding({ wallet }: { wallet: WalletState }) {
  const identity = useRequiredIdentity(wallet.signer)
  const dialog = useRef<HTMLDialogElement>(null)
  const required = !!wallet.signer && !identity.checking && !identity.ready
  useEffect(() => {
    const element = dialog.current
    if (required && element && !element.open) element.showModal()
    return () => { if (element?.open) element.close() }
  }, [required])

  if (!required) return null
  return (
    <dialog ref={dialog} className="ens-onboarding" aria-label="Register this wallet’s Dusk name"
      onCancel={(event) => { event.preventDefault(); wallet.disconnect() }}>
      <div className="stack">
        <p className="meta">Register one Dusk name for this wallet to buy or sell compute. Registration is signed by your configured wallet.</p>
        <EnsIdentity signer={wallet.signer ?? undefined} />
        <button type="button" className="ghost" onClick={wallet.disconnect}>Browse without registering</button>
      </div>
    </dialog>
  )
}
