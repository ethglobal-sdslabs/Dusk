import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JobSummary } from '../src/components/JobSummary'
import type { RawJobForm } from '../src/lib/buy-form'

const form: RawJobForm = { prompt: 'Hello', model: 'text', maxPricePer1kOut: '1000', maxTokens: '8', deadlineMinutes: '10', visibility: 'public' }
const render = (value: RawJobForm) => renderToStaticMarkup(createElement(JobSummary, { form: value, maxMinutes: 60, funded: true }))

describe('job summary', () => {
  it('keeps the payment and deadline visible without a redundant single-job label', () => {
    const html = render(form)
    expect(html).toContain('Maximum job payment')
    expect(html).toContain('10 minutes')
    expect(html).not.toContain('Runs as')
  })
  it('still explains when a prompt is split into multiple jobs', () => {
    const html = render({ ...form, prompt: 'Answer briefly.\n1. First question\n2. Second question\n3. Third question' })
    expect(html).toContain('Runs as')
    expect(html).toContain('3 pieces, run at once')
  })
})
