export const SESSION_KEY = 'dusk.earn.session.v1'

export type EarnSession = {
  models: string[]
  pricePer1kOut: bigint
  worker: string
  startedAt: number
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function saveSession(session: EarnSession, storage: Storage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(
      SESSION_KEY,
      JSON.stringify({
        models: [...session.models],
        pricePer1kOut: session.pricePer1kOut.toString(),
        worker: session.worker.toLowerCase(),
        startedAt: session.startedAt,
      }),
    )
  } catch {
  }
}

export function loadSession(storage: Storage | undefined = defaultStorage()): EarnSession | null {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (!raw) return null
    return sessionFrom(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export function sessionFrom(value: unknown): EarnSession | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const models = v['models']
  if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === 'string' && m !== '')) return null
  if (typeof v['pricePer1kOut'] !== 'string' || !/^\d+$/.test(v['pricePer1kOut'])) return null
  if (typeof v['worker'] !== 'string' || typeof v['startedAt'] !== 'number') return null
  return {
    models: models as string[],
    pricePer1kOut: BigInt(v['pricePer1kOut']),
    worker: v['worker'],
    startedAt: v['startedAt'],
  }
}

export function clearSession(storage: Storage | undefined = defaultStorage()): void {
  try {
    storage?.removeItem(SESSION_KEY)
  } catch {
  }
}
