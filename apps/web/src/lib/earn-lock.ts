export type LockLike = {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: Lock | null) => Promise<unknown> | unknown,
  ): Promise<unknown>
}

export const WORKER_LOCK = 'dusk.earn.worker'

export type Leadership = {
  release(): void
}

export function holdLeadership(locks: LockLike | undefined, name: string, onLead: () => void): Leadership {
  let released = false
  if (!locks) {
    queueMicrotask(() => {
      if (!released) onLead()
    })
    return {
      release() {
        released = true
      },
    }
  }
  const ctl = new AbortController()
  let letGo: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    letGo = resolve
  })
  locks
    .request(name, { signal: ctl.signal }, async () => {
      if (released) return
      onLead()
      await held
    })
    .catch(() => {
    })
  return {
    release() {
      if (released) return
      released = true
      ctl.abort()
      letGo()
    },
  }
}

export function browserLocks(): LockLike | undefined {
  return typeof navigator !== 'undefined' && 'locks' in navigator ? (navigator.locks as LockLike) : undefined
}
