'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { layoutField, MAX_LIGHTS, type FieldInput } from './field'
import { useStage } from './stage'

const VERTEX_SHADER = `
precision highp float;

attribute vec2 iFrom;
attribute vec2 iTo;
attribute float iSize;
attribute vec3 iColor;
attribute float iGlow;

uniform vec2 uViewport;

varying vec2 vLocal;
varying float vHalfLen;
varying float vSize;
varying vec3 vColor;
varying float vGlow;

void main() {
  vec2 fromPx = iFrom * uViewport;
  vec2 toPx = iTo * uViewport;
  vec2 delta = toPx - fromPx;
  float len = length(delta);
  vec2 along = len > 0.0001 ? delta / len : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);

  float halfLen = len * 0.5;
  vec2 local = vec2(position.x * (halfLen + iSize), position.y * iSize);
  vec2 px = (fromPx + toPx) * 0.5 + along * local.x + across * local.y;

  vLocal = local;
  vHalfLen = halfLen;
  vSize = iSize;
  vColor = iColor;
  vGlow = iGlow;

  gl_Position = vec4(px / uViewport * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 vLocal;
varying float vHalfLen;
varying float vSize;
varying vec3 vColor;
varying float vGlow;

void main() {
  float beyond = max(abs(vLocal.x) - vHalfLen, 0.0);
  float dist = length(vec2(beyond, vLocal.y));
  float falloff = 1.0 - smoothstep(0.0, max(vSize, 0.0001), dist);
  float a = pow(falloff, 1.7) * vGlow;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor, a);
}
`

type Buffers = {
  geometry: THREE.InstancedBufferGeometry
  material: THREE.ShaderMaterial
  mesh: THREE.Mesh
  scene: THREE.Scene
  camera: THREE.Camera
  from: THREE.InstancedBufferAttribute
  to: THREE.InstancedBufferAttribute
  size: THREE.InstancedBufferAttribute
  color: THREE.InstancedBufferAttribute
  glow: THREE.InstancedBufferAttribute
}

function createBuffers(): Buffers {
  const quad = new THREE.PlaneGeometry(2, 2)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = quad.index
  geometry.setAttribute('position', quad.getAttribute('position'))
  geometry.instanceCount = 0

  const attribute = (components: number) =>
    new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS * components), components)

  const from = attribute(2)
  const to = attribute(2)
  const size = attribute(1)
  const color = attribute(3)
  const glow = attribute(1)
  geometry.setAttribute('iFrom', from)
  geometry.setAttribute('iTo', to)
  geometry.setAttribute('iSize', size)
  geometry.setAttribute('iColor', color)
  geometry.setAttribute('iGlow', glow)

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: { uViewport: { value: new THREE.Vector2(1, 1) } },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false

  const scene = new THREE.Scene()
  scene.add(mesh)

  quad.dispose()
  return { geometry, material, mesh, scene, camera: new THREE.Camera(), from, to, size, color, glow }
}

export function EntityField({ input }: { input: FieldInput }): null {
  const stage = useStage()
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    if (!stage) return
    const buffers = createBuffers()

    const unregister = stage.register((frame) => {
      const lights = layoutField({ ...latest.current, reducedMotion: frame.reducedMotion }, frame.nowMs)
      const count = Math.min(lights.length, MAX_LIGHTS)

      for (let i = 0; i < count; i++) {
        const light = lights[i]!
        buffers.from.setXY(i, light.from[0], light.from[1])
        buffers.to.setXY(i, light.to[0], light.to[1])
        buffers.size.setX(i, light.sizePx)
        buffers.color.setXYZ(i, light.color[0] / 255, light.color[1] / 255, light.color[2] / 255)
        buffers.glow.setX(i, light.glow)
      }

      for (const attr of [buffers.from, buffers.to, buffers.size, buffers.color, buffers.glow]) {
        attr.clearUpdateRanges()
        attr.addUpdateRange(0, count * attr.itemSize)
        attr.needsUpdate = true
      }

      buffers.geometry.instanceCount = count
      ;(buffers.material.uniforms['uViewport']!.value as THREE.Vector2).set(frame.widthPx, frame.heightPx)

      if (count > 0) frame.renderer.render(buffers.scene, buffers.camera)
    })

    return () => {
      unregister()
      buffers.geometry.dispose()
      buffers.material.dispose()
    }
  }, [stage])

  useEffect(() => {
    stage?.requestDraw()
  }, [stage, input.snapshot, input.burns])

  return null
}
