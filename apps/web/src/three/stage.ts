'use client'

import { createContext, useContext } from 'react'
import type * as THREE from 'three'

export type StageFrame = {
  renderer: THREE.WebGLRenderer
  widthPx: number
  heightPx: number
  progress: number
  nowMs: number
  reducedMotion: boolean
}

export type StageOverlay = (frame: StageFrame) => void

export type Stage = {
  register: (overlay: StageOverlay) => () => void
  requestDraw: () => void
}

export const StageContext = createContext<Stage | null>(null)

export function useStage(): Stage | null {
  return useContext(StageContext)
}
