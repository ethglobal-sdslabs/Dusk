'use client'


import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { browserClock } from '../lib/config'
import { createRenderLoop, type RenderLoopState } from './render-loop'
import { groundColors, panelSurfaceCss, skyGradientCss, skyProgress } from './sky'
import { HORIZON_Y, SKY_FRAGMENT_SHADER, SKY_VERTEX_SHADER } from './sky.glsl'
import { StageContext, type Stage, type StageOverlay } from './stage'
import { rgbToCss } from '../lib/color'

const AMBIENT_STEP = 0.002

const INTRO_MS = 1200

function webglContext(canvas: HTMLCanvasElement): WebGLRenderingContext | WebGL2RenderingContext | null {
  try {
    const attrs: WebGLContextAttributes = {
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    }
    return (canvas.getContext('webgl2', attrs) ??
      canvas.getContext('webgl', attrs)) as WebGL2RenderingContext | WebGLRenderingContext | null
  } catch {
    return null
  }
}

export function SkyCanvas({ children }: { children?: ReactNode }): ReactNode {
  const clock = useMemo(() => browserClock(), [])
  const skyRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [intro, setIntro] = useState<'covering' | 'lifting' | 'gone'>('covering')

  const overlays = useRef<Set<StageOverlay>>(new Set())
  const drawRef = useRef<() => void>(() => {})

  const stage = useMemo<Stage>(
    () => ({
      register(overlay) {
        overlays.current.add(overlay)
        drawRef.current()
        return () => {
          overlays.current.delete(overlay)
          drawRef.current()
        }
      },
      requestDraw() {
        drawRef.current()
      },
    }),
    [],
  )

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setIntro('lifting'))
    const done = window.setTimeout(() => setIntro('gone'), INTRO_MS + 100)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(done)
    }
  }, [])

  useEffect(() => {
    const sky = skyRef.current
    const canvas = canvasRef.current
    if (!sky || !canvas) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const gl = webglContext(canvas)

    const haveWebgl = gl !== null
    canvas.style.display = haveWebgl ? 'block' : 'none'

    let renderer: THREE.WebGLRenderer | undefined
    let material: THREE.ShaderMaterial | undefined
    let geometry: THREE.BufferGeometry | undefined
    let scene: THREE.Scene | undefined
    let camera: THREE.Camera | undefined
    let dustTexture: THREE.Texture | undefined
    let dustMaterial: THREE.MeshBasicMaterial | undefined
    let dustGeometry: THREE.PlaneGeometry | undefined
    let dustScene: THREE.Scene | undefined
    let disposed = false

    if (gl) {
      renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false })
      material = new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        uniforms: { uProgress: { value: skyProgress(clock, new Date()) } },
        depthTest: false,
        depthWrite: false,
      })
      geometry = new THREE.PlaneGeometry(2, 2)
      const quad = new THREE.Mesh(geometry, material)
      quad.frustumCulled = false
      scene = new THREE.Scene()
      scene.add(quad)
      camera = new THREE.Camera()
      dustScene = new THREE.Scene()
      dustGeometry = new THREE.PlaneGeometry(2, 2)
      dustMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending })
      const dust = new THREE.Mesh(dustGeometry, dustMaterial)
      dust.frustumCulled = false
      dustScene.add(dust)
      new THREE.TextureLoader().load('/cosmic-dust.png', (texture) => {
        if (disposed) { texture.dispose(); return }
        dustTexture = texture
        texture.colorSpace = THREE.SRGBColorSpace
        if (dustMaterial) { dustMaterial.map = texture; dustMaterial.needsUpdate = true }
        drawRef.current()
      })
    }

    const resize = (): void => {
      if (!renderer) return
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(window.innerWidth, window.innerHeight, false)
    }

    let lastAmbient = Number.NaN

    const draw = (): void => {
      const progress = skyProgress(clock, new Date())
      if (material) material.uniforms['uProgress']!.value = progress
      if (renderer && scene && camera) {
        renderer.autoClear = true
        renderer.render(scene, camera)
        if (dustScene && dustTexture) {
          renderer.autoClear = false
          renderer.render(dustScene, camera)
        }
        if (overlays.current.size > 0) {
          renderer.autoClear = false
          const frame = {
            renderer,
            widthPx: window.innerWidth,
            heightPx: window.innerHeight,
            progress,
            nowMs: Date.now(),
            reducedMotion: reduceMotion.matches,
          }
          for (const overlay of overlays.current) overlay(frame)
        }
      }

      if (!(Math.abs(progress - lastAmbient) < AMBIENT_STEP)) {
        lastAmbient = progress
        sky.style.background = skyGradientCss(progress)
        const root = document.documentElement.style
        root.setProperty('--panel', panelSurfaceCss(progress))
        root.setProperty('--ground', rgbToCss(groundColors(progress)[0]))
      }
    }

    const loop = createRenderLoop(
      {
        requestFrame: (cb) => window.requestAnimationFrame(cb),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        schedule: (cb, ms) => window.setTimeout(cb, ms),
        unschedule: (handle) => window.clearTimeout(handle as number),
      },
      draw,
    )

    const state: RenderLoopState = {
      hidden: document.visibilityState === 'hidden',
      onScreen: true,
      reducedMotion: reduceMotion.matches || !haveWebgl,
    }

    const report = (patch: Partial<RenderLoopState>): void => {
      Object.assign(state, patch)
      loop.update(state)
    }

    const onVisibility = () => report({ hidden: document.visibilityState === 'hidden' })
    const onReduceMotion = () => report({ reducedMotion: reduceMotion.matches || !haveWebgl })
    const onResize = () => {
      resize()
      draw()
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) report({ onScreen: entry.isIntersecting })
      },
      { threshold: 0 },
    )
    observer.observe(sky)

    document.addEventListener('visibilitychange', onVisibility)
    reduceMotion.addEventListener('change', onReduceMotion)
    window.addEventListener('resize', onResize)

    document.documentElement.style.setProperty('--sky-band', `${((1 - HORIZON_Y) * 100).toFixed(2)}vh`)

    resize()
    draw()
    loop.update(state)
    drawRef.current = draw

    return () => {
      disposed = true
      drawRef.current = () => {}
      loop.stop()
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      reduceMotion.removeEventListener('change', onReduceMotion)
      window.removeEventListener('resize', onResize)
      geometry?.dispose()
      material?.dispose()
      dustTexture?.dispose()
      dustMaterial?.dispose()
      dustGeometry?.dispose()
      renderer?.dispose()
    }
  }, [clock])

  return (
    <>
      <div ref={skyRef} className="sky" aria-hidden="true">
        <canvas ref={canvasRef} className="sky-canvas" />
        {intro !== 'gone' && (
          <div
            className="sky-intro"
            data-done={intro === 'lifting' ? 'yes' : 'no'}
            style={{ transitionDuration: `${INTRO_MS}ms` }}
          />
        )}
      </div>
      <StageContext.Provider value={stage}>{children}</StageContext.Provider>
    </>
  )
}
