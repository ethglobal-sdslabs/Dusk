'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { NavIcon } from './NavIcon'

const destinations = ['market', 'buy', 'earn', 'history', 'reputation'] as const
export type AppDestination = (typeof destinations)[number]

export function AppNavLinks({ current }: { current?: AppDestination | 'home' }) {
  const tabs = useRef<HTMLDivElement>(null)
  const target = useRef<HTMLAnchorElement | null>(null)
  const [highlight, setHighlight] = useState({ left: 0, width: 0, visible: false })

  function moveTo(link: HTMLAnchorElement | null) {
    target.current = link
    if (!link || !tabs.current) {
      setHighlight(previous => ({ ...previous, visible: false }))
      return
    }
    const bounds = tabs.current.getBoundingClientRect()
    const rect = link.getBoundingClientRect()
    setHighlight({ left: rect.left - bounds.left, width: rect.width, visible: true })
  }

  function restore() {
    const focused = document.activeElement
    moveTo(focused instanceof HTMLAnchorElement && tabs.current?.contains(focused)
      ? focused
      : tabs.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]') ?? null)
  }

  useEffect(() => {
    const element = tabs.current
    if (!element) return
    moveTo(element.querySelector<HTMLAnchorElement>('[aria-current="page"]'))
    const observer = new ResizeObserver(() => moveTo(target.current))
    observer.observe(element)
    for (const link of element.querySelectorAll('a')) observer.observe(link)
    return () => observer.disconnect()
  }, [current])

  return (
    <div className="app-nav-tabs" ref={tabs} onPointerLeave={restore} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) restore()
    }} style={{ '--tab-left': `${highlight.left}px`, '--tab-width': `${highlight.width}px` } as CSSProperties}>
      <span className="app-nav-highlight" aria-hidden="true" data-visible={highlight.visible} />
      {destinations.map(destination => (
        <Link key={destination} href={`/${destination}`} aria-current={current === destination ? 'page' : undefined}
          onPointerEnter={event => { if (event.pointerType !== 'touch') moveTo(event.currentTarget) }}
          onFocus={event => moveTo(event.currentTarget)}>
          <NavIcon destination={destination} />
          <span>{destination[0]!.toUpperCase() + destination.slice(1)}</span>
        </Link>
      ))}
    </div>
  )
}
