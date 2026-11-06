
export type RenderLoopHost = {
  requestFrame: (cb: () => void) => number
  cancelFrame: (handle: number) => void
  schedule: (cb: () => void, ms: number) => unknown
  unschedule: (handle: unknown) => void
}

export type RenderLoopState = {
  hidden: boolean
  onScreen: boolean
  reducedMotion: boolean
}

export type RenderLoopMode = 'frames' | 'interval' | 'stopped'

export type RenderLoop = {
  update: (state: RenderLoopState) => void
  running: () => boolean
  mode: () => RenderLoopMode
  stop: () => void
}

export const REDUCED_MOTION_INTERVAL_MS = 60_000

function modeFor(state: RenderLoopState): RenderLoopMode {
  if (state.hidden || !state.onScreen) return 'stopped'
  return state.reducedMotion ? 'interval' : 'frames'
}

export function createRenderLoop(
  host: RenderLoopHost,
  onFrame: () => void,
  options: { intervalMs?: number } = {},
): RenderLoop {
  const intervalMs = options.intervalMs ?? REDUCED_MOTION_INTERVAL_MS

  let mode: RenderLoopMode = 'stopped'
  let frameHandle: number | undefined
  let timerHandle: unknown
  let disposed = false

  function pump(): void {
    onFrame()
    if (mode === 'frames') frameHandle = host.requestFrame(pump)
  }

  function halt(): void {
    if (frameHandle !== undefined) {
      host.cancelFrame(frameHandle)
      frameHandle = undefined
    }
    if (timerHandle !== undefined) {
      host.unschedule(timerHandle)
      timerHandle = undefined
    }
    mode = 'stopped'
  }

  function enter(next: RenderLoopMode): void {
    if (next === mode) return
    halt()
    mode = next
    if (next === 'frames') {
      frameHandle = host.requestFrame(pump)
    } else if (next === 'interval') {
      const tick = () => {
        onFrame()
        if (mode === 'interval') timerHandle = host.schedule(tick, intervalMs)
      }
      timerHandle = host.schedule(tick, intervalMs)
    }
  }

  return {
    update(state) {
      if (disposed) return
      enter(modeFor(state))
    },
    running: () => mode !== 'stopped',
    mode: () => mode,
    stop() {
      disposed = true
      halt()
    },
  }
}
