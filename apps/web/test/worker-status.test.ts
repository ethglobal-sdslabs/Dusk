// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkerStatus } from '../src/components/WorkerStatus'

describe('worker status', () => {
  it('shows a useful status when there is no recent activity or error', () => {
    for (const [ticks, expected] of [[0, 'Starting worker'], [1, 'Worker running']] as const) {
      const html = renderToStaticMarkup(createElement(WorkerStatus, {
        ticks, intervalSeconds: 5, note: null, readError: null,
        loopError: null, budget: { figure: '—', note: '' },
      }))
      const container = document.createElement('div'); container.innerHTML = html
      expect(container.querySelector('[role="status"]')?.textContent).toContain(expected)
    }
  })

  it('does not show a healthy status when a read or worker error is present', () => {
    for (const error of ['readError', 'loopError'] as const) {
      const html = renderToStaticMarkup(createElement(WorkerStatus, {
        ticks: 1, intervalSeconds: 5, note: null, readError: null,
        loopError: null, budget: { figure: '—', note: '' }, [error]: 'Connection interrupted',
      }))
      expect(html).not.toContain('Worker running')
      expect(html).toContain('Connection interrupted')
    }
  })

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
