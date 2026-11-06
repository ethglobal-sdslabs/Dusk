'use client'

import { WalletName } from './WalletName'

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import gsap from 'gsap'
import Link from 'next/link'
import { AppNavLinks } from './AppNavLinks'
import { Countdown } from './Countdown'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { LoadingIndicator } from './LoadingIndicator'
import { AsciiVortex } from '../three/AsciiVortex'
import { ensDisplayCache } from '../lib/ens'
import { useWallet } from '../lib/wallet'
import { WalletNameOnboarding } from './WalletNameOnboarding'

gsap.registerPlugin(ScrollTrigger)

const asciiField = Array.from({ length: 48 }, (_, row) =>
  Array.from({ length: 100 }, (_, column) => {
    const glyphs = '+.:*'
    return glyphs[(row + column) % glyphs.length]
  }).join('')
).join('\n')
function moveAsciiField(event: PointerEvent<HTMLAnchorElement>) {
  if (event.pointerType === 'touch') return
  const card = event.currentTarget
  const grid = card.offsetParent
  if (!(grid instanceof HTMLElement)) return
  const bounds = grid.getBoundingClientRect()
  const x = Math.max(0, Math.min(card.offsetWidth, event.clientX - bounds.left - card.offsetLeft))
  const y = Math.max(0, Math.min(card.offsetHeight, event.clientY - bounds.top - card.offsetTop))
  card.dataset.pointer = 'true'
  card.style.setProperty('--pointer-x', `${x}px`)
  card.style.setProperty('--pointer-y', `${y}px`)
  card.style.setProperty('--tilt-x', `${(.5 - y / card.offsetHeight) * 7}deg`)
  card.style.setProperty('--tilt-y', `${(x / card.offsetWidth - .5) * 7}deg`)
}

function resetAsciiField(event: PointerEvent<HTMLAnchorElement>) {
  delete event.currentTarget.dataset.pointer
  event.currentTarget.style.setProperty('--tilt-x', '0deg')
  event.currentTarget.style.setProperty('--tilt-y', '0deg')
}

export function VortexLanding() {
  const sequence = useRef<HTMLElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const descend = useRef<HTMLAnchorElement>(null)
  const progress = useRef(0)
  const intro = useRef(0)
  const covered = useRef(false)
  const [sceneCovered, setSceneCovered] = useState(false)
  const ensEnabled = ensDisplayCache() !== null
  const [reducedMotion, setReducedMotion] = useState(false)
  const wallet = useWallet()
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const section = sequence.current
    const viewport = frame.current
    if (!section || !viewport) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const output = section.querySelector<HTMLElement>('.vortex-output')
    if (reducedMotion || media.matches) return
    covered.current = false
    setSceneCovered(false)
    const spacer = section.querySelector<HTMLElement>('.vortex-spacer')
    if (!spacer) return
    const trigger = ScrollTrigger.create({
      trigger: section,
      start: 'top top',
      end: () => `+=${Math.max(1, spacer.offsetHeight - window.innerHeight)}`,
      scrub: true,
      onUpdate(self) {
        const opening = Math.min(1, self.progress / .16)
        intro.current = opening * opening * (3 - 2 * opening)
        const p = Math.max(0, Math.min(1, (self.progress - .16) / .84))
        progress.current = Math.min(p, .82)
        viewport.style.setProperty('--vortex-progress', String(p))
        const pull = Math.max(0, Math.min(1, (p - .04) / .38))
        const easedPull = pull * pull * (3 - 2 * pull)
        viewport.style.setProperty('--copy-opacity', String(1 - Math.max(0, Math.min(1, (pull - .65) / .35))))
        descend.current?.toggleAttribute('inert', p >= .42)
        viewport.style.setProperty('--copy-drop', `${easedPull * 27}vh`)
        viewport.style.setProperty('--copy-pull', String(easedPull))
        const flashIn = Math.max(0, Math.min(1, (p - .70) / .12))
        const flashOut = 1 - Math.max(0, Math.min(1, (p - .82) / .1))
        viewport.style.setProperty('--flash', String(flashIn * flashOut))
      },
    })
    const outputTrigger = output ? ScrollTrigger.create({
      trigger: output,
      start: 'top bottom',
      end: () => `top ${navigation.current?.offsetHeight ?? 72}px`,
      scrub: true,
      onUpdate(self) {
        output.style.setProperty('--output-reveal', String(self.progress))
        const isCovered = self.progress >= 1
        if (isCovered !== covered.current) {
          covered.current = isCovered
          setSceneCovered(isCovered)
        }
      },
    }) : undefined
    return () => {
      trigger.kill()
      outputTrigger?.kill()
      progress.current = 0
      intro.current = 0
      for (const name of ['--vortex-progress', '--copy-opacity', '--copy-drop', '--copy-pull', '--flash']) viewport.style.removeProperty(name)
      output?.style.removeProperty('--output-reveal')
      descend.current?.removeAttribute('inert')
    }
  }, [reducedMotion])
  useEffect(() => {
    if (reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !sequence.current) return
    const context = gsap.context(() => {
      gsap.from('.vortex-lifecycle li', {
        y: 18, opacity: 0, duration: .65, stagger: .1, ease: 'power2.out',
        scrollTrigger: { trigger: '.vortex-lifecycle ol', start: 'top 88%', once: true },
      })
    }, sequence)
    return () => context.revert()
  }, [reducedMotion])
  return (
    <main className="vortex-page">
      <Link className="skip-link" href="/#how-it-works">Skip to content</Link>
      <header className="vortex-nav isolate" ref={navigation}>
        <Link href="/" className="vortex-brand" aria-label="Dusk home">dusk<span>.</span></Link>
        <div className="vortex-nav-end">
          <nav aria-label="Main navigation"><AppNavLinks current="home" /></nav>
          <div className="vortex-wallet">
            {wallet.status === 'connected' && wallet.address ? (
              <span
                className="vortex-wallet-button"
                data-connected="true"
                title={`${wallet.address} — configured wallet`}
              >
                <span className="vortex-wallet-dot" aria-hidden="true" />
                <span className="vortex-wallet-address">
                  <WalletName address={wallet.address} />
                </span>
                <span className="vortex-wallet-action">Configured</span>
              </span>
            ) : (
              <button
                type="button"
                className="vortex-wallet-button"
                onClick={() => void wallet.connect()}
                disabled={wallet.status === 'connecting'}
              >
                {wallet.status === 'connecting' ? <LoadingIndicator label="Loading configured wallet" /> : 'Load configured wallet'}
              </button>
            )}
          </div>
        </div>
      </header>
      <WalletNameOnboarding wallet={wallet} />
      <section className="vortex-sequence" ref={sequence} aria-label="From unused credits to inference">
        <div className="vortex-frame" ref={frame}>
          <AsciiVortex progress={progress} intro={intro} paused={sceneCovered} />
          <div className="vortex-glow" aria-hidden="true" />
          <div className="vortex-copy">
            <h1><strong>Your Idle Tokens,</strong>{' '}<em>Unleashed.</em></h1>
          </div>
          <Link className="vortex-descend" href="/#how-it-works" ref={descend}>Scroll to explore <span aria-hidden="true">↓</span></Link>
          <div className="vortex-corner vortex-corner-left" aria-hidden="true">+</div>
          <div className="vortex-corner vortex-corner-right" aria-hidden="true">⌝</div>
          <div className="vortex-flash" aria-hidden="true" />
        </div>
        <div className="vortex-spacer" aria-hidden="true" />
        <section id="how-it-works" className="vortex-output">
        <div className="vortex-light-eth" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => <svg key={i} viewBox="0 0 32 48" fill="none"><path d="M16 2 3 24 16 31 29 24 16 2ZM3 28 16 46 29 28 16 35 3 28ZM16 2V31M3 24 16 18 29 24M16 35V46" /></svg>)}
        </div>
        <div className="vortex-output-content">
          <div className="vortex-output-head"><span>Dusk / Inference marketplace</span><Link href="/market">Explore the market <span aria-hidden="true">↗</span></Link></div>
          <div className="vortex-intro">
            <p className="vortex-intro-label">0G inference credits · Reset daily</p>
            <h2>Buy inference.<br /><span>Earn with idle credits.</span></h2>
            <div className="vortex-intro-aside">
              <p>Post an inference job or run a worker using your unused 0G credits. Credits reset at midnight UTC.</p>
              <Countdown className="vortex-intro-clock" />
            </div>
          </div>
          <section className="vortex-lifecycle" aria-labelledby="job-journey">
            <div className="vortex-lifecycle-heading"><h2 id="job-journey">From request to result</h2><p>Three steps, with no server in the middle.</p></div>
            <ol>
              <li><div className="vortex-step-top"><span aria-hidden="true">01</span><em>Recorded on Arkiv</em></div><h3>Post a job</h3><p>Choose a model, add your prompt, and set a price and deadline.</p></li>
              <li><div className="vortex-step-top"><span aria-hidden="true">02</span><em>Inference on 0G</em></div><h3>A worker runs it</h3><p>A worker claims your job and runs it using 0G credits. Arkiv records the claim.</p></li>
              <li><div className="vortex-step-top"><span aria-hidden="true">03</span><em>Stored on Swarm</em></div><h3>Receive the result</h3><p>Download the output and check the job receipt. Funded jobs settle through escrow.</p></li>
            </ol>
          </section>
          <div className="vortex-paths" aria-label="Choose how to use Dusk">
            <Link href="/buy" className="vortex-door" onPointerMove={moveAsciiField} onPointerLeave={resetAsciiField} onPointerCancel={resetAsciiField}>
              <pre className="vortex-door-ascii" aria-hidden="true">{asciiField}</pre>
              <span className="vortex-door-orbit" aria-hidden="true">⊹ &nbsp; · &nbsp; +</span>
              <span className="vortex-door-label">For builders</span>
              <h3>Buy <em>inference</em></h3>
              <p>Choose a model, set your budget, and track your job through completion.</p>
              <span className="vortex-door-action">Post a job <span aria-hidden="true">↗</span></span>
            </Link>
            <Link href="/earn" className="vortex-door" onPointerMove={moveAsciiField} onPointerLeave={resetAsciiField} onPointerCancel={resetAsciiField}>
              <pre className="vortex-door-ascii" aria-hidden="true">{asciiField}</pre>
              <span className="vortex-door-orbit" aria-hidden="true">+ &nbsp; · &nbsp; ⊹</span>
              <span className="vortex-door-label">For credit holders</span>
              <h3>Earn with <em>idle credits</em></h3>
              <p>Run a worker to complete paid jobs using your available 0G credits.</p>
              <span className="vortex-door-action">Start earning <span aria-hidden="true">↗</span></span>
            </Link>
          </div>
          <div className="vortex-market-link"><p>Browse before you start.</p><Link href="/market">Explore jobs and offers <span aria-hidden="true">↗</span></Link></div>
          <div className="vortex-protocols"><span>Built with</span><div><p><strong>0G</strong> provides inference credits. <strong>Arkiv</strong> coordinates time-limited market records. <strong>Swarm</strong> carries job data and results.</p><p className="vortex-ens-note">{ensEnabled ? 'Wallets with a verified dusk.eth name on Sepolia show it in place of the address. The address stays the identity.' : 'ENS can make wallet identities easier to recognize. Name resolution is not enabled in this build.'}</p></div></div>
          <footer><Link href="/">dusk.</Link><span>A marketplace for unused inference credits.</span><Link href="/market">Enter the market ↗</Link></footer>
        </div>
        </section>
      </section>
    </main>
  )
}
