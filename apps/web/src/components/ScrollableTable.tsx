'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

export function ScrollableTable({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    measure()
    return () => observer.disconnect()
  }, [])

  return <div className="market-table">
    <div ref={container} className="scroller" role="region" aria-labelledby={labelledBy} tabIndex={overflows ? 0 : undefined}>{children}</div>
    {overflows && <p className="table-scroll-hint">Scroll to see all columns <span aria-hidden="true">↔</span></p>}
  </div>
}
