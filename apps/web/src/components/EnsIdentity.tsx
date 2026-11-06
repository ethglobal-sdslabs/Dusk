'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  createEnsReader, describeEnsError, EnsInputError, isTerminalEnsError, newRegistration, normalizeLabel, registrationStage,
  type RegistrationOp, type RegistrationStage, type VerifiedIdentity,
} from '@dusk/ens'
import type { DuskSigner } from '@dusk/signer'
import { browserEnsSetup } from '../lib/config'
import { invalidateWalletIdentity } from '../lib/ens'
import { LoadingIndicator } from './LoadingIndicator'
import { createEnrollClient, enrollDraftKey, enrollStorageKey, identityLine, latestOnly, loadNameDraft, loadOp, saveNameDraft, saveOp } from '../lib/enroll'

const storage = () => { try { return window.localStorage } catch { return undefined } }

export function EnsIdentity({ signer, onConnect, connecting = false }: { signer: DuskSigner | undefined; onConnect?: () => Promise<void>; connecting?: boolean }) {
  const setup = useMemo(() => browserEnsSetup(), [])
  const config = setup.config
  const id = useId()
  const headingId = `${id}-ens-heading`
  const hintId = `${id}-ens-hint`
  const reader = useMemo(() => (config ? createEnsReader(config) : null), [config])
  const client = useMemo(() => {
    if (!config?.controller || !signer) return null
    try { return createEnrollClient(config, signer) } catch { return null }
  }, [config, signer])

  const [identity, setIdentity] = useState<VerifiedIdentity | undefined>(undefined)
  const [op, setOp] = useState<RegistrationOp | null>(null)
  const [stage, setStage] = useState<RegistrationStage>('choosing')
  const [label, setLabel] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [description, setDescription] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const timing = useRef<{ minAgeSec: number; maxAgeSec: number } | null>(null)
  const busyRef = useMemo(() => ({ current: false }), [client])
  const storeKey = client && config ? enrollStorageKey(config.chainId, client.controller, client.address) : null
  const draftKey = signer ? enrollDraftKey(setup.chainId, setup.parentName, signer.address) : null
  const activeWallet = useRef(signer?.address)
  const activeStore = useRef(storeKey)
  activeWallet.current = signer?.address
  activeStore.current = storeKey

  const refresh = useCallback(async () => {
    if (!reader || !signer) return
    const address = signer.address
    const value = await reader.identityOf(address)
    if (activeWallet.current !== address) return
    setIdentity(value)
    invalidateWalletIdentity(address)
  }, [reader, signer])

  useEffect(() => {
    setIdentity(undefined); setError(null); setSaved(null); setLabel(loadNameDraft(storage(), draftKey)); setHint(null); setDescription(''); setBusy(false)
    timing.current = null
    setOp(storeKey ? loadOp(storage(), storeKey, config?.parentName) : null)
    void refresh()
  }, [storeKey, draftKey, refresh, config?.parentName])

  const persist = useCallback((next: RegistrationOp | null) => {
    if (activeStore.current === storeKey) setOp((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    if (storeKey) saveOp(storage(), storeKey, next)
  }, [storeKey])

  useEffect(() => {
    if (identity?.status === 'active' && identity.wallet.toLowerCase() === signer?.address.toLowerCase()) {
      persist(null)
      saveNameDraft(storage(), draftKey, '')
    }
  }, [identity, signer?.address, draftKey, persist])

  const check = useMemo(() => latestOnly(async (raw: string) => {
    const canonical = normalizeLabel(raw)
    return { canonical, free: client ? await client.available(canonical) : undefined }
  }), [client])
  useEffect(() => {
    if (!label) { setHint(null); return }
    let live = true
    const timer = setTimeout(() => {
      check(label).then((r) => {
        if (!live || r.stale) return
        setHint(r.value.free === undefined ? `Your choice: ${r.value.canonical}.${setup.parentName}. Availability will be checked when registration opens.` :
          r.value.free ? `${r.value.canonical}.${setup.parentName} is available.` : `${r.value.canonical}.${setup.parentName} is taken or reserved.`)
      }, (e: unknown) => { if (live) setHint(e instanceof Error && e.name === 'EnsInputError' ? e.message : describeEnsError(e)) })
    }, 400)
    return () => { live = false; clearTimeout(timer) }
  }, [label, check, setup.parentName])

  useEffect(() => {
    if (!client || !op || op.registeredAt !== undefined) return
    if (op.wallet.toLowerCase() !== client.address.toLowerCase() || op.controller.toLowerCase() !== client.controller.toLowerCase() || op.chainId !== config?.chainId) return
    let live = true
    const fail = (e: unknown) => {
      if (activeStore.current !== storeKey) return
      if (isTerminalEnsError(e)) { persist(null); void refresh().catch(() => {}) }
      setError(describeEnsError(e))
    }
    const step = async () => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        timing.current ??= await client.timing()
        const s = registrationStage(op, await client.chainNowMs(), timing.current)
        if (!live || activeStore.current !== storeKey) return
        setStage(s)
        const stale = s === 'committing' && Date.now() - op.createdAt > timing.current.maxAgeSec * 1000
        if (s === 'expired' || stale) {
          persist(null)
          setError('The reservation expired before it was confirmed. Reserve the name again.')
          return
        }
        if (s !== 'committing' && s !== 'reveal-ready' && s !== 'registering') return
        setBusy(true)
        if (s === 'committing') persist(await client.commit(op, persist))
        else { persist(await client.register(op, persist)); await refresh() }
        if (activeStore.current === storeKey) setError(null)
      } catch (e) {
        fail(e)
      } finally {
        busyRef.current = false
        if (activeStore.current === storeKey) setBusy(false)
      }
    }
    void step().catch(fail)
    const timer = setInterval(() => { void step().catch(fail) }, 5_000)
    return () => { live = false; clearInterval(timer) }
  }, [client, op, persist, refresh, config, busyRef, storeKey])

  useEffect(() => {
    if (!reader || identity?.status !== 'active' || identity.wallet !== signer?.address) return
    let live = true
    void reader.profileOf(identity).then((profile) => {
      if (live) setDescription((typed) => typed || profile.description || '')
    })
    return () => { live = false }
  }, [reader, identity, signer?.address])

  const line = !signer ? { tone: 'muted', text: 'Add the wallet to config.json to register a Dusk name.' } : !config
    ? { tone: 'warn', text: setup.status === 'disabled' ? 'Dusk name registration is not available yet.' : 'Dusk names are temporarily unavailable.' }
    : identityLine(identity)
  const enrollable = (config?.mode === 'enrollment' || config?.mode === 'application-enforced') && client !== null &&
    (identity?.status === 'unnamed' || identity?.status === 'expired')
  const pending = op !== null && op.registeredAt === undefined
  const canChoose = identity?.status !== 'active' && identity?.status !== 'banned' && identity?.status !== 'revoked'

  async function reserve(existing?: RegistrationOp) {
    if (!client || !config || !reader || !signer || !enrollable || busyRef.current) return
    setError(null)
    busyRef.current = true
    setBusy(true)
    let sent = false
    const ownStore = storeKey
    try {
      const next = existing ?? newRegistration({ chainId: config.chainId, controller: client.controller, wallet: client.address, label, parentName: config.parentName, now: Date.now() })
      const current = await reader.identityOf(client.address)
      if (activeStore.current !== ownStore) return
      setIdentity(current)
      if (current.status !== 'unnamed' && current.status !== 'expired') throw new EnsInputError('This wallet cannot register another name. Refresh its identity before continuing.')
      if (!(await client.available(next.label))) throw new EnsInputError('That name is taken or reserved. Choose another name.')
      if (await client.registrationPaused()) throw new EnsInputError('Name registration is paused. Your choice is saved; try again later.')
      if (activeStore.current !== ownStore) return
      persist(next)
      persist(await client.commit(next, (pending) => { sent = true; persist(pending) }))
    } catch (e) {
      if (!sent || isTerminalEnsError(e)) persist(null)
      if (activeStore.current === ownStore) setError(e instanceof Error && e.name === 'EnsInputError' ? e.message : describeEnsError(e))
    } finally {
      busyRef.current = false
      if (activeStore.current === ownStore) setBusy(false)
    }
  }

  function cancel() {
    if (op?.registerTx) return
    persist(null)
    setError(null)
  }

  async function saveDescription() {
    if (!client || !identity?.name || busyRef.current) return
    const ownStore = storeKey
    busyRef.current = true
    setError(null); setSaved(null); setBusy(true)
    try {
      const result = await client.setDescription(identity.name, description.trim())
      if (activeStore.current === ownStore) setSaved(result.verified ? 'Saved on-chain and verified.' : `Transaction ${result.hash} confirmed. Profile readback is unavailable; refresh to check it.`)
    } catch (e) {
      if (activeStore.current === ownStore) setError(describeEnsError(e))
    } finally {
      busyRef.current = false
      if (activeStore.current === ownStore) setBusy(false)
    }
  }

  async function renew() {
    if (!client || busyRef.current) return
    const ownStore = storeKey
    busyRef.current = true
    setError(null); setBusy(true)
    try { await client.renew(); await refresh() }
    catch (e) { if (activeStore.current === ownStore) setError(describeEnsError(e)) }
    finally { busyRef.current = false; if (activeStore.current === ownStore) setBusy(false) }
  }

  return (
    <section className="panel stack ens-identity" aria-labelledby={headingId}>
      <h2 id={headingId}>Your Dusk name</h2>
      <p className="ens-status" data-tone={line.tone}>{signer && config && !identity ? <LoadingIndicator label={line.text} /> : line.text}</p>
      {identity?.status !== 'active' && <p className="meta">Registered on {setup.chainId === 1 ? 'Ethereum' : 'Sepolia'}.</p>}

      {op && pending && (
        <p className="notice" role="status">
          {op.commitTx && <LoadingIndicator label="Confirming name registration" />}{' '}
          {!op.commitTx ? `Continue the reservation for ${op.name}.` : stage === 'waiting' || stage === 'committing' ? `Reserving ${op.name}… the name is confirmed about a minute after the reservation lands.`
            : `Confirming ${op.name}…`}
          {' '}
          {!op.commitTx && <button type="button" onClick={() => void reserve(op)} disabled={busy || !enrollable}>Continue reservation</button>}
          {!op.registerTx && <button type="button" className="ghost" onClick={cancel} disabled={busy}>Start over</button>}
        </p>
      )}

      {identity?.status === 'expired' && client && (
        <div className="surface-actions"><button type="button" onClick={() => void renew()} disabled={busy}>Renew name</button></div>
      )}

      {canChoose && (
        <>
          <label className="field">
            <span>Choose your Dusk name</span>
            <input name="ens-label" value={pending ? op!.label : label} onChange={(e) => { setLabel(e.target.value); saveNameDraft(storage(), draftKey, e.target.value) }} disabled={!signer || busy || pending} spellCheck={false} autoComplete="off" maxLength={32} placeholder="ashura" aria-describedby={hintId} />
          </label>
          <p id={hintId} className="meta">{hint ?? `3–32 letters or digits; becomes <name>.${setup.parentName}. Names are not transferable.`}</p>
          {signer && !config && <p className="meta">You can save a name preference on this device. It becomes your registered name only after on-chain registration is available and the configured wallet signs it.</p>}
          {config?.mode === 'display' && <p className="meta">Names are currently read-only. Registration will be enabled separately.</p>}
          {identity?.status === 'unknown' && <p className="meta">This wallet's name could not be verified. Your draft is kept while you retry.</p>}
          <div className="surface-actions">
            {!signer && onConnect && <button type="button" onClick={() => void onConnect()} disabled={connecting}>{connecting ? <LoadingIndicator label="Loading configured wallet" /> : 'Load configured wallet'}</button>}
            {!op && <button type="button" onClick={() => void reserve()} disabled={!enrollable || busy || !label}>Reserve name</button>}
            {signer && reader && (identity?.status === 'unknown' || op?.registeredAt !== undefined) && <button type="button" className="ghost" onClick={() => void refresh()}>Check again</button>}
          </div>
        </>
      )}

      {identity?.status === 'active' && client && (
        <>
          <details className="ens-profile">
            <summary>Edit profile</summary>
            <label className="field">
              <span>Description (public, plain text)</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} />
            </label>
            <div className="surface-actions">
              <button type="button" className="ghost" onClick={() => void saveDescription()} disabled={busy || !description.trim()}>Save description</button>
            </div>
            {saved && <p className="meta" role="status">{saved}</p>}
          </details>
        </>
      )}

      {error && <p className="notice" role="alert">{error}</p>}
    </section>
  )
}
