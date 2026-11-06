'use client'

import { useEffect } from 'react'
import * as THREE from 'three'
import { useStage } from './stage'

export function OrbitalScene() {
  const stage = useStage()
  useEffect(() => {
    if (!stage) return
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    camera.position.z = 9
    const world = new THREE.Group()
    scene.add(world)
    const pointer = new THREE.Vector2()
    const easedPointer = new THREE.Vector2()
    const moonControl = document.querySelector<HTMLButtonElement>('.moon-control')
    let turnTarget = 0
    let turnCurrent = 0
    let dragX: number | undefined
    let didDrag = false
    const onMoonDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return
      dragX = event.clientX
      didDrag = false
      moonControl?.setPointerCapture(event.pointerId)
    }
    const onMoonMove = (event: PointerEvent) => {
      if (dragX === undefined) return
      const distance = event.clientX - dragX
      if (Math.abs(distance) > 0.5) didDrag = true
      turnTarget += distance * 0.012
      dragX = event.clientX
      stage.requestDraw()
    }
    const onMoonUp = () => { dragX = undefined }
    const onMoonCancel = () => { dragX = undefined; didDrag = false }
    const onMoonClick = () => {
      if (!didDrag) turnTarget += Math.PI / 4
      didDrag = false
      stage.requestDraw()
    }
    moonControl?.addEventListener('pointerdown', onMoonDown)
    moonControl?.addEventListener('pointermove', onMoonMove)
    moonControl?.addEventListener('pointerup', onMoonUp)
    moonControl?.addEventListener('pointercancel', onMoonCancel)
    moonControl?.addEventListener('click', onMoonClick)
    let scrollProgress = 0
    let journeyBlend = 0
    let journeyX = 0.5
    let journeyY = 0.5
    let journeyHandoff = 0
    let sceneVisible = true
    const sceneAreas = document.querySelectorAll('.orbital-hero, .orbital-story, .orbital-journey, .space-masthead')
    const visibleAreas = new Set<Element>()
    const visibilityObserver = sceneAreas.length ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleAreas.add(entry.target)
        else visibleAreas.delete(entry.target)
      }
      sceneVisible = visibleAreas.size > 0
      stage.requestDraw()
    }) : undefined
    sceneAreas.forEach((area) => visibilityObserver?.observe(area))
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      pointer.set((event.clientX / window.innerWidth - 0.5) * 2, (event.clientY / window.innerHeight - 0.5) * 2)
    }
    const onPointerLeave = () => pointer.set(0, 0)
    const onScroll = () => {
      scrollProgress = Math.min(window.scrollY / window.innerHeight, 1)
      const diagram = document.querySelector('.orbital-diagram')
      if (!diagram) return
      const rect = diagram.getBoundingClientRect()
      journeyX = (rect.left + rect.width / 2) / window.innerWidth
      journeyY = THREE.MathUtils.clamp((rect.top + rect.height / 2) / window.innerHeight, 0.27, 0.72)
      const story = document.querySelector('.orbital-journey')
      const distance = story ? Math.max(story.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.55, 1) : 1
      journeyBlend = THREE.MathUtils.smoothstep(window.scrollY / distance, 0.08, 1)
      journeyHandoff = story ? 1 - THREE.MathUtils.smoothstep(story.getBoundingClientRect().top / window.innerHeight, 0.15, 0.9) : 0
      const diagramCenterY = (rect.top + rect.height / 2) / window.innerHeight
      const alignment = 1 - THREE.MathUtils.smoothstep(Math.abs(diagramCenterY - journeyY), 0.005, 0.1)
      ;(diagram as HTMLElement).style.setProperty('--planet-reveal', String(alignment * THREE.MathUtils.smoothstep(journeyBlend, 0.85, 1)))
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    onScroll()
    const coreGeometry = new THREE.SphereGeometry(1.08, 64, 48)
    const coreMaterial = new THREE.MeshStandardMaterial({ color: 0xe1e5ef, metalness: 0.02, roughness: 0.95 })
    let moonTexture: THREE.Texture | undefined
    let disposed = false
    new THREE.TextureLoader().load('/moon-surface.jpg', (texture) => {
      if (disposed) { texture.dispose(); return }
      moonTexture = texture
      texture.colorSpace = THREE.SRGBColorSpace
      coreMaterial.map = texture
      coreMaterial.bumpMap = texture
      coreMaterial.bumpScale = 0.035
      coreMaterial.needsUpdate = true
      stage.requestDraw()
    })
    const core = new THREE.Mesh(coreGeometry, coreMaterial)
    world.add(core)
    const rings = new THREE.Group()
    const ringGeometry = new THREE.TorusGeometry(1.62, 0.008, 6, 160)
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xc9d9f4, transparent: true, opacity: 0.7, depthWrite: false })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    rings.add(ring)
    const dustGeometry = new THREE.BufferGeometry()
    const dustPositions = new Float32Array(420 * 3)
    for (let i = 0; i < 420; i++) {
      const angle = i * 2.399963
      const noise = Math.sin(i * 81.173) * 43758.5453
      const fraction = noise - Math.floor(noise)
      const radius = 1.4 + fraction * 0.55
      dustPositions[i * 3] = Math.cos(angle) * radius
      dustPositions[i * 3 + 1] = Math.sin(angle) * radius
      dustPositions[i * 3 + 2] = Math.sin(i * 13.7) * 0.09
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    const dustMaterial = new THREE.PointsMaterial({ color: 0xb8c8e1, size: 0.018, transparent: true, opacity: 0.7, depthWrite: false })
    rings.add(new THREE.Points(dustGeometry, dustMaterial))
    const debrisGeometry = new THREE.IcosahedronGeometry(1, 0)
    const debrisMaterial = new THREE.MeshStandardMaterial({ color: 0x8794a8, roughness: 1, transparent: true })
    for (let i = 0; i < 9; i++) {
      const pebble = new THREE.Mesh(debrisGeometry, debrisMaterial)
      const angle = i * 2.399963 + 0.4
      const radius = 1.48 + (i % 4) * 0.12
      pebble.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, Math.sin(i * 3) * 0.08)
      pebble.scale.setScalar(0.018 + (i % 3) * 0.008)
      rings.add(pebble)
    }
    rings.rotation.set(1.2, 0.1, -0.32)
    world.add(rings)
    scene.add(new THREE.AmbientLight(0x8194c0, 0.4))
    const light = new THREE.DirectionalLight(0xd9e6ff, 3.2)
    light.position.set(-4, 3, 5)
    scene.add(light)
    const rim = new THREE.DirectionalLight(0x759dff, 2)
    rim.position.set(4, -2, -2)
    scene.add(rim)
    const starGeometry = new THREE.BufferGeometry()
    const points = new Float32Array(500 * 3)
    for (let i = 0; i < 500; i++) {
      const n = i * 3
      points[n] = Math.sin(i * 127.1) * 12
      points[n + 1] = Math.sin(i * 311.7) * 7
      points[n + 2] = -3 - (i % 13) * 0.35
    }
    starGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3))
    const starMaterial = new THREE.PointsMaterial({ color: 0xc8d6fa, size: 0.026, transparent: true, opacity: 0.75, sizeAttenuation: true })
    scene.add(new THREE.Points(starGeometry, starMaterial))
    let lastFrameMs: number | undefined
    const unregister = stage.register(({ renderer, widthPx, heightPx, nowMs, reducedMotion }) => {
      if (!sceneVisible) { lastFrameMs = undefined; return }
      camera.aspect = widthPx / heightPx
      camera.updateProjectionMatrix()
      const delta = lastFrameMs === undefined ? 0 : Math.min(Math.max((nowMs - lastFrameMs) / 1000, 0), 0.1)
      lastFrameMs = nowMs
      if (reducedMotion) easedPointer.set(0, 0)
      else {
        easedPointer.x = THREE.MathUtils.damp(easedPointer.x, pointer.x, 2.14, delta)
        easedPointer.y = THREE.MathUtils.damp(easedPointer.y, pointer.y, 2.14, delta)
      }
      light.position.set(-4 + easedPointer.x * 0.8, 3 - easedPointer.y * 0.5, 5)
      const journey = reducedMotion ? 0 : scrollProgress
      const baseX = (widthPx < 760 ? 0.35 : 2.15) + easedPointer.x * 0.22
      const baseY = (widthPx < 760 ? 1.05 : -0.05) - easedPointer.y * 0.16 + journey * 0.9
      const blend = reducedMotion ? 0 : journeyBlend
      const unfold = Math.sin(Math.PI * blend)
      const depth = 9 + journey * 1.8
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(19)) * depth
      const mobile = widthPx < 760
      const destinationX = mobile ? THREE.MathUtils.lerp(0.84, journeyX, journeyHandoff) : journeyX
      const destinationY = mobile ? THREE.MathUtils.lerp(0.38, journeyY, journeyHandoff) : journeyY
      const targetX = (destinationX * 2 - 1) * halfHeight * camera.aspect
      const targetY = (1 - destinationY * 2) * halfHeight
      const arcX = (mobile ? 0.06 : 0.22) * unfold
      const arcY = (mobile ? 0.12 : 0.34) * unfold
      world.position.set(THREE.MathUtils.lerp(baseX, targetX, blend) + arcX, THREE.MathUtils.lerp(baseY, targetY, blend) + arcY, -journey * 1.8)
      const destinationScale = mobile ? THREE.MathUtils.lerp(0.28, 0.58, journeyHandoff) : 0.72
      world.scale.setScalar(THREE.MathUtils.lerp((mobile ? 0.72 : 1) * (1 - journey * 0.1), destinationScale, blend))
      world.rotation.y = reducedMotion ? 0.15 : nowMs * 0.000025 + easedPointer.x * 0.32 + blend * 1.4
      world.rotation.x = -easedPointer.y * 0.2 + unfold * 0.32
      world.rotation.z = unfold * -0.18
      turnCurrent = reducedMotion ? turnTarget : THREE.MathUtils.damp(turnCurrent, turnTarget, 7, delta)
      core.rotation.y = turnCurrent
      rings.rotation.z = -0.32 + unfold * 0.25
      ringMaterial.opacity = 0.7 * (1 - THREE.MathUtils.smoothstep(blend, 0.55, 0.95))
      dustMaterial.opacity = ringMaterial.opacity
      debrisMaterial.opacity = ringMaterial.opacity / 0.7
      rings.visible = reducedMotion || blend < 0.95
      renderer.clearDepth()
      renderer.render(scene, camera)
    })
    return () => {
      disposed = true
      unregister()
      visibilityObserver?.disconnect()
      moonControl?.removeEventListener('pointerdown', onMoonDown)
      moonControl?.removeEventListener('pointermove', onMoonMove)
      moonControl?.removeEventListener('pointerup', onMoonUp)
      moonControl?.removeEventListener('pointercancel', onMoonCancel)
      moonControl?.removeEventListener('click', onMoonClick)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      coreGeometry.dispose()
      coreMaterial.dispose()
      moonTexture?.dispose()
      ringGeometry.dispose()
      ringMaterial.dispose()
      dustGeometry.dispose()
      dustMaterial.dispose()
      debrisGeometry.dispose()
      debrisMaterial.dispose()
      starGeometry.dispose()
      starMaterial.dispose()
    }
  }, [stage])
  return null
}
