import { describe, expect, it } from 'vitest'
import { createRenderLoop, type RenderLoopHost, type RenderLoopState } from '../src/three/render-loop'

function fakeHost() {
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { cb: () => void; ms: number }>()
  let nextHandle = 1
  const cancelled: number[] = []

  const host: RenderLoopHost = {
    requestFrame(cb) {
      const handle = nextHandle++
      frames.set(handle, cb)
      return handle
    },
    cancelFrame(handle) {
      cancelled.push(handle)
      frames.delete(handle)
    },
    schedule(cb, ms) {
      const handle = nextHandle++
      timers.set(handle, { cb, ms })
      return handle
    },
    unschedule(handle) {
      timers.delete(handle as number)
    },
  }

  return {
    host,
    cancelled,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    timerDelays: () => [...timers.values()].map((t) => t.ms),
    pumpFrame() {
      const due = [...frames.entries()]
      for (const [handle, cb] of due) {
        frames.delete(handle)
        cb()
      }
    },
    pumpTimer() {
      const due = [...timers.entries()]
      for (const [handle, timer] of due) {
        timers.delete(handle)
        timer.cb()
      }
    },
  }
}

const visible: RenderLoopState = { hidden: false, onScreen: true, reducedMotion: false }

describe('createRenderLoop', () => {
  it('does not run before it is told the browser state', () => {
    const b = fakeHost()
    const loop = createRenderLoop(b.host, () => {})

    expect(loop.mode()).toBe('stopped')
    expect(loop.running()).toBe(false)
    expect(b.pendingFrames()).toBe(0)
  })

  it('runs per-frame when the tab is visible and the canvas is on screen', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    loop.update(visible)
    expect(loop.mode()).toBe('frames')
    expect(loop.running()).toBe(true)

    b.pumpFrame()
    b.pumpFrame()
    expect(frames).toBe(2)
  })

  it('stops when the tab is hidden, and draws nothing more', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    loop.update(visible)
    b.pumpFrame()
    loop.update({ ...visible, hidden: true })

    expect(loop.mode()).toBe('stopped')
    expect(b.pendingFrames()).toBe(0)
    expect(b.cancelled.length).toBeGreaterThan(0)

    b.pumpFrame()
    expect(frames).toBe(1)
  })

  it('stops when the canvas scrolls off screen', () => {
    const b = fakeHost()
    const loop = createRenderLoop(b.host, () => {})

    loop.update(visible)
    loop.update({ ...visible, onScreen: false })

    expect(loop.mode()).toBe('stopped')
    expect(b.pendingFrames()).toBe(0)
  })

  it('resumes once the tab is visible and the canvas is back on screen', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    loop.update(visible)
    loop.update({ hidden: true, onScreen: false, reducedMotion: false })
    expect(loop.running()).toBe(false)

    loop.update(visible)
    expect(loop.mode()).toBe('frames')
    b.pumpFrame()
    expect(frames).toBe(1)
  })

  it('recomputes on an interval instead of per frame under prefers-reduced-motion', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++, { intervalMs: 30_000 })

    loop.update({ ...visible, reducedMotion: true })

    expect(loop.mode()).toBe('interval')
    expect(loop.running()).toBe(true)
    expect(b.pendingFrames()).toBe(0)
    expect(b.timerDelays()).toEqual([30_000])

    b.pumpTimer()
    expect(frames).toBe(1)
  })

  it('keeps the interval alive across firings, so the information survives', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    loop.update({ ...visible, reducedMotion: true })
    b.pumpTimer()
    b.pumpTimer()

    expect(frames).toBe(2)
    expect(loop.mode()).toBe('interval')
  })

  it('swaps frames for the interval when reduced motion turns on mid-flight', () => {
    const b = fakeHost()
    const loop = createRenderLoop(b.host, () => {})

    loop.update(visible)
    expect(b.pendingFrames()).toBe(1)

    loop.update({ ...visible, reducedMotion: true })
    expect(b.pendingFrames()).toBe(0)
    expect(b.pendingTimers()).toBe(1)
    expect(loop.mode()).toBe('interval')
  })

  it('reduced motion still stops entirely when hidden', () => {
    const b = fakeHost()
    const loop = createRenderLoop(b.host, () => {})

    loop.update({ hidden: true, onScreen: true, reducedMotion: true })

    expect(loop.mode()).toBe('stopped')
    expect(b.pendingTimers()).toBe(0)
  })

  it('never leaves two loops running, however often it is updated', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    for (let i = 0; i < 5; i++) loop.update(visible)
    expect(b.pendingFrames()).toBe(1)

    b.pumpFrame()
    expect(frames).toBe(1)
    expect(b.pendingFrames()).toBe(1)

    for (let i = 0; i < 5; i++) loop.update({ ...visible, reducedMotion: true })
    expect(b.pendingTimers()).toBe(1)
    expect(b.pendingFrames()).toBe(0)
  })

  it('stays stopped after stop(), because a stale listener must not revive a torn-down renderer', () => {
    const b = fakeHost()
    let frames = 0
    const loop = createRenderLoop(b.host, () => frames++)

    loop.update(visible)
    loop.stop()
    expect(loop.mode()).toBe('stopped')
    expect(b.pendingFrames()).toBe(0)

    loop.update(visible)
    expect(loop.mode()).toBe('stopped')
    expect(b.pendingFrames()).toBe(0)
    expect(frames).toBe(0)
  })
})
