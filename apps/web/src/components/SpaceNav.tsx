'use client'

import Link from 'next/link'
import { Countdown } from './Countdown'
import { AppNavLinks, type AppDestination } from './AppNavLinks'

type SpaceNavProps = {
  current: 'home' | AppDestination
  className?: string
}

export function SpaceNav({ current, className = '' }: SpaceNavProps) {
  return (
    <nav className={`space-nav ${className}`} aria-label="Main navigation">
      <Link className="space-nav-brand" href="/" aria-label="Dusk home">dusk<span className="space-nav-dot">.</span></Link>
      <div className="space-nav-links">
        <AppNavLinks current={current} />
      </div>
      <div className="workspace-tools">
        <aside className="workspace-clock" aria-label="Credit reset countdown"><Countdown /></aside>
      </div>
    </nav>
  )
}
