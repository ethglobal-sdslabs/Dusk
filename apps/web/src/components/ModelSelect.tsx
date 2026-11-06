'use client'

import { useMemo, useState } from 'react'
import type { ModelInfo } from '@dusk/core'
import { modelOptionGroups } from '../lib/model-groups'
import { LoadingIndicator } from './LoadingIndicator'

const CUSTOM = '\u0000custom'

export function ModelSelect(props: {
  id?: string
  value: string
  onChange: (v: string) => void
  catalog: readonly ModelInfo[] | null | undefined
  extras: readonly string[]
  served?: readonly string[]
  placeholder?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  const { value, onChange } = props
  const groups = useMemo(
    () => modelOptionGroups(props.catalog, [...props.extras, value]),
    [props.catalog, props.extras, value],
  )
  const served = useMemo(() => new Set(props.served ?? []), [props.served])
  const [typing, setTyping] = useState(false)
  const free = typing || props.catalog === undefined || value.includes(',')
  const aria = {
    'aria-invalid': props['aria-invalid'],
    'aria-describedby': props['aria-describedby'],
  }

  if (free) {
    const listId = props.id ? `${props.id}-list` : undefined
    return (
      <span className="stack" style={{ gap: '0.25rem' }}>
        <input
          id={props.id}
          list={listId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete="off"
          {...aria}
        />
        {listId && (
          <datalist id={listId}>
            {groups.flatMap((g) => g.models).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
        {props.catalog === null && <LoadingIndicator label="Reading 0G models" />}
        {props.catalog !== undefined && (
          <button type="button" className="ghost" onClick={() => setTyping(false)}>
            Pick from 0G&rsquo;s list instead
          </button>
        )}
      </span>
    )
  }

  return (
    <span className="model-select-control">
    <select
      id={props.id}
      value={value}
      onChange={(e) => {
        if (e.target.value === CUSTOM) setTyping(true)
        else onChange(e.target.value)
      }}
      {...aria}
    >
      {groups.map((g) => (
        <optgroup key={g.tier} label={`${g.label} (${g.models.length})`}>
          {g.models.map((m) => (
            <option key={m} value={m}>
              {served.has(m) ? `${m} — on offer now` : m}
            </option>
          ))}
        </optgroup>
      ))}
      <option value={CUSTOM}>Other — type a model id&hellip;</option>
    </select>
    {props.catalog === null && <LoadingIndicator label="Reading 0G models" />}
    </span>
  )
}
