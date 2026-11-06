'use client'

import { useEffect, useRef, useState } from 'react'
import { AsciiVortex } from '../three/AsciiVortex'

export function AsciiMastheadScene() {
  const container = useRef<HTMLDivElement>(null)
  const progress = useRef(0)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!container.current) return
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: '200px' })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])

  return <div ref={container} className="ascii-masthead-scene" aria-hidden="true">{visible && <AsciiVortex progress={progress} />}</div>
}
