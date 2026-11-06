'use client'

import { useEffect, useMemo, useState } from 'react'
import { admission, createEnsReader } from '@dusk/ens'
import type { DuskSigner } from '@dusk/signer'
import { browserEnsSetup } from './config'

type RequiredIdentity = { ready: boolean; checking: boolean; message: string }

export function useRequiredIdentity(signer: DuskSigner | null | undefined): RequiredIdentity {
  const setup = useMemo(() => browserEnsSetup(), [])
  const reader = useMemo(() => setup.config?.controller ? createEnsReader(setup.config) : null, [setup])
  const address = signer?.address
  const [state, setState] = useState<RequiredIdentity & { wallet?: string }>({ ready: false, checking: false, message: 'Configure a wallet and register its Dusk name to start new work.' })
  useEffect(() => {
    if (!address) { setState({ ready: false, checking: false, message: 'Configure a wallet and register its Dusk name to start new work.' }); return }
    if (setup.status === 'disabled') { setState({ wallet: address, ready: true, checking: false, message: 'ENS names are off on this instance.' }); return }
    if (!reader || !setup.config?.registry) {
      setState({ wallet: address, ready: false, checking: false, message: 'A registered Dusk name is required. Registration is not available on this instance yet.' }); return
    }
    const config = setup.config
    let live = true
    let running = false
    let verifiedOnce = false
    setState({ wallet: address, ready: false, checking: true, message: 'Checking this wallet’s Dusk name…' })
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const snapshot = await reader.identityOf(address)
        if (snapshot.status === 'unknown' && verifiedOnce) return
        const verdict = admission({ mode: 'application-enforced', action: 'new-job', wallet: address, chainId: config.chainId, registry: config.registry!, snapshot, now: Date.now() })
        verifiedOnce = verdict.allowed
        if (live) setState({ wallet: address, ready: verdict.allowed, checking: false,
          message: verdict.allowed ? `Using ${snapshot.name}.` : snapshot.status === 'unnamed' || snapshot.status === 'expired'
            ? 'Register one Dusk name for this wallet before posting jobs or starting a worker.' : verdict.reason ?? 'This wallet’s Dusk name could not be verified.' })
      } catch {
        if (verifiedOnce) return
        if (live) setState({ wallet: address, ready: false, checking: false, message: 'This wallet’s Dusk name could not be verified. Retry before starting new work.' })
      } finally { running = false }
    }
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail?.toLowerCase() === address.toLowerCase()) void refresh() }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    window.addEventListener('dusk:identity-changed', changed)
    window.addEventListener('focus', refresh)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('dusk:identity-changed', changed); window.removeEventListener('focus', refresh) }
  }, [address, reader, setup])
  return state.wallet?.toLowerCase() === address?.toLowerCase() ? state : { ready: false, checking: !!address, message: address ? 'Checking this wallet’s Dusk name…' : 'Configure a wallet and register its Dusk name to start new work.' }
}
