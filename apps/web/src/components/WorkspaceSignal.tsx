import { memo } from 'react'

type Destination = 'buy' | 'earn' | 'market' | 'history' | 'reputation'

export const WorkspaceSignal = memo(function WorkspaceSignal({ page }: { page: Destination }) {
  const glyphs = '+*:./=<>X'
  const marks = Array.from({ length: 270 }, (_, i) => {
    const strand = Math.floor(i / 30)
    const t = (i % 30) / 29
    const x = 16 + t * 268
    let y: number
    if (page === 'buy') {
      y = 82 + (strand - 4) * 14 * (1 - t) + Math.sin(t * Math.PI * 2 + strand * .25) * 13 * t
    } else if (page === 'earn') {
      y = 82 + Math.sin(t * Math.PI * 2.5 + strand * .36) * (18 + t * 32) + (strand - 4) * 3
    } else if (page === 'reputation') {
      y = 82 + (strand - 4) * 12 * Math.exp(-3 * t) + Math.sin(t * Math.PI * 4 + strand) * 9 * Math.exp(-2.5 * t)
    } else if (page === 'history') {
      y = 82 + (strand - 4) * 11 * (1 - t) ** 1.4 + Math.cos(t * Math.PI * 3 + strand * .4) * 6 * (1 - t)
    } else {
      y = 82 + Math.sin(t * Math.PI * 2 + (strand % 2) * Math.PI) * 42 + (strand - 4) * 5
    }
    const depth = .35 + .65 * (Math.sin(t * Math.PI + strand * .16) * .5 + .5)
    return <text key={i} x={x.toFixed(2)} y={y.toFixed(2)} opacity={depth.toFixed(2)} fontSize={i % 11 === 0 ? 10 : 7} className={strand > 5 ? 'signal-secondary' : undefined}>{glyphs[(i * 7 + strand) % glyphs.length]}</text>
  })
  return <svg className={`workspace-signal workspace-signal-${page}`} viewBox="0 0 300 164" aria-hidden="true" focusable="false">
    <g className="signal-glyphs">{marks}</g>
  </svg>
})
