// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkerStatus } from '../src/components/WorkerStatus'

describe('worker status', () => {
  it('keeps failures visible while routine diagnostics start collapsed', () => {
    const html = renderToStaticMarkup(createElement(WorkerStatus, {
      ticks: 12, intervalSeconds: 5, note: 'Waiting for jobs', readError: null,
      loopError: 'Connection interrupted', budget: { figure: '25%', note: '' },
    }))
    const container = document.createElement('div'); container.innerHTML = html
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Connection interrupted')
    expect(alert.closest('details')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Waiting for jobs')
    const details = container.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('Arkiv quota used')
    expect(details.textContent).toContain('12')
  })
})
