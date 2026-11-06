import type { Address } from 'viem'
import type { VerifiedIdentity } from './read'

export function createIdentityCache(
  reader: { identityOf(wallet: Address): Promise<VerifiedIdentity> },
  opts: { ttlMs?: number; maxConcurrent?: number; now?: () => number } = {},
) {
  const ttlMs = opts.ttlMs ?? 60_000
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4)
  const now = opts.now ?? Date.now
  const done = new Map<string, { value: VerifiedIdentity; at: number }>()
  const pending = new Map<string, Promise<VerifiedIdentity>>()
  const epoch = new Map<string, number>()
  const queue: Array<() => void> = []
  let running = 0

  const slot = () => new Promise<void>((resolve) => {
    if (running < maxConcurrent) { running++; resolve() } else queue.push(() => { running++; resolve() })
  })
  const free = () => { running--; queue.shift()?.() }

  function get(wallet: Address): Promise<VerifiedIdentity> {
    const key = wallet.toLowerCase()
    const hit = done.get(key)
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
    const inFlight = pending.get(key)
    if (inFlight) return inFlight
    const started = epoch.get(key) ?? 0
    const read = (async () => {
      await slot()
      try {
        const value = await reader.identityOf(wallet)
        if ((epoch.get(key) ?? 0) === started) {
          if (value.status === 'unknown') done.delete(key)
          else done.set(key, { value, at: now() })
        }
        return value
      } finally {
        free()
        if ((epoch.get(key) ?? 0) === started) pending.delete(key)
      }
    })()
    pending.set(key, read)
    return read
  }

  function forget(wallet: Address) {
    const key = wallet.toLowerCase()
    epoch.set(key, (epoch.get(key) ?? 0) + 1)
    done.delete(key)
    pending.delete(key)
  }

  return { get, forget }
}
