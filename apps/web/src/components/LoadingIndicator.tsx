'use client'

import { useEffect, useRef, useState } from 'react'

export function LoadingIndicator({ label = 'Loading' }: { label?: string }) {
  const element = useRef<HTMLSpanElement>(null)
  const [active, setActive] = useState(false)
  useEffect(() => {
    const node = element.current
    if (!node) return
    let visible = typeof IntersectionObserver === 'undefined'
    const update = () => setActive(visible && document.visibilityState === 'visible')
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      update()
    })
    observer?.observe(node)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])
  return (
    <span ref={element} className="black-hole-loader" data-active={active} role="status" aria-label={label}>
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <g transform="translate(16 16) rotate(-12) scale(1 .42)">
          <g className="black-hole-orbits" fill="none" stroke="currentColor" strokeLinecap="round">
            <circle r="14" strokeWidth="1.2" strokeDasharray=".4 2.1 1.6 2.4" opacity=".55" />
            <circle r="11" strokeWidth="1.5" strokeDasharray="2.2 1.4 .4 1.8" opacity=".8" />
            <circle r="8" strokeWidth="1.8" strokeDasharray=".5 1.1 2.5 1.5" />
          </g>
        </g>
        <circle cx="16" cy="16" r="4.4" fill="var(--black-hole-center, #080808)" stroke="currentColor" strokeWidth=".5" opacity=".95" />
        <path d="M3 19c5 3.5 15 4.2 26-5" fill="none" stroke="currentColor" strokeWidth=".8" strokeDasharray="1.4 1.5 .3 1" strokeLinecap="round" opacity=".8" />
      </svg>
    </span>
  )
}
