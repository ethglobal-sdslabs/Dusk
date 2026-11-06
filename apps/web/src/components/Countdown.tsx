'use client'


import { useEffect, useMemo, useState } from 'react'
import { browserClock } from '../lib/config'
import { timeToReset } from '../lib/countdown'

const PLACEHOLDER = '--:--:--'

export function Countdown({ className }: { className?: string }): React.ReactNode {
  const clock = useMemo(() => browserClock(), [])
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    const tick = () => setLabel(timeToReset(clock, new Date()).label)
    tick()
    const handle = window.setInterval(tick, 1000)
    return () => window.clearInterval(handle)
  }, [clock])

  return (
    <div
      className={className ? `countdown ${className}` : 'countdown'}
      role="timer"
      aria-live="off"
      aria-label="Time until tonight's credits are destroyed"
    >
      <span className="countdown-label">Credits reset in</span>
      <span className="figure money countdown-figure">{label ?? PLACEHOLDER}</span>
    </div>
  )
}
