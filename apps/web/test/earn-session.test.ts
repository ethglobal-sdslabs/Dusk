import { describe, expect, it } from 'vitest'
import { clearSession, loadSession, saveSession, SESSION_KEY, type EarnSession } from '../src/lib/earn-session'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

function throwingStorage(): Storage {
  const die = (): never => {
    throw new DOMException('SecurityError')
  }
  return { get length(): number { return die() }, clear: die, getItem: die, key: die, removeItem: die, setItem: die }
}

const SESSION: EarnSession = {
  models: ['0gm-1.0-35b-a3b'],
  pricePer1kOut: 1n,
  worker: '0x8860c950aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  startedAt: 1_700_000_000_000,
}

describe('the earn session', () => {
  it('round-trips, price included as a bigint', () => {
    const s = memoryStorage()
    saveSession(SESSION, s)
    expect(loadSession(s)).toEqual(SESSION)
  })

  it('is gone after Stop', () => {
    const s = memoryStorage()
    saveSession(SESSION, s)
    clearSession(s)
    expect(loadSession(s)).toBeNull()
  })

  it('stores nothing key-shaped, whatever extra fields a caller passes', () => {
    const s = memoryStorage()
    saveSession({ ...SESSION, inferKey: 'sk-live-abcdefghijklmnopqrstuvwxyz', workerKey: `0x${'ab'.repeat(32)}` } as never, s)
    const raw = s.getItem(SESSION_KEY) ?? ''
    expect(raw).not.toMatch(/\b(sk|mk)-/)
    expect(raw).not.toContain('ab'.repeat(32))
  })

  it.each([
    ['not JSON', '{'],
    ['no models', JSON.stringify({ ...SESSION, models: [], pricePer1kOut: '1' })],
    ['a price that is not a whole number', JSON.stringify({ ...SESSION, pricePer1kOut: '1.5' })],
    ['no start time', JSON.stringify({ ...SESSION, pricePer1kOut: '1', startedAt: 'soon' })],
  ])('reads %s as no session at all', (_, raw) => {
    const s = memoryStorage()
    s.setItem(SESSION_KEY, raw)
    expect(loadSession(s)).toBeNull()
  })

  it('survives storage that throws, as in private browsing', () => {
    expect(() => saveSession(SESSION, throwingStorage())).not.toThrow()
    expect(loadSession(throwingStorage())).toBeNull()
    expect(() => clearSession(throwingStorage())).not.toThrow()
  })
})
