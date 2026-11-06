'use client'

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'

type SceneProps = { progress: MutableRefObject<number>; intro: MutableRefObject<number>; smallTokens?: boolean }
type CursorField = { pointer: THREE.Vector2; velocity: THREE.Vector2; previous: THREE.Vector2; raycaster: THREE.Raycaster; active: boolean }

const DISK_REST_Y = -5.2
const diskCenterY = (progress: number) => DISK_REST_Y * (1 - THREE.MathUtils.smoothstep(progress, .38, .69))

function glyphTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')!
  context.clearRect(0, 0, 256, 256)
  context.fillStyle = 'white'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = 'bold 45px monospace'
  const glyphs = ['*', '+', '#', '@', '%', '&', 'X', 'G', 'E', 'T', 'H', '/', '=', '>', '~', '?']
  glyphs.forEach((glyph, i) => context.fillText(glyph, (i % 4) * 64 + 32, Math.floor(i / 4) * 64 + 32))
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function ethGlowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')!
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  glow.addColorStop(0, 'rgba(255,255,255,.9)')
  glow.addColorStop(.2, 'rgba(255,255,255,.6)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function Accretion({ progress, intro, texture, cursor }: SceneProps & { texture: THREE.Texture; cursor: CursorField }) {
  const material = useRef<THREE.ShaderMaterial>(null)
  const disk = useRef<THREE.Points>(null)
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uSpin: { value: 0 }, uFlow: { value: 0 }, uInward: { value: 0 }, uFeedPhase: { value: 0 }, uFeedSpin: { value: 0 }, uProgress: { value: 0 }, uIntro: { value: 0 }, uPixelRatio: { value: 1 }, uGlyph: { value: texture }, uPointer: { value: new THREE.Vector2() }, uForce: { value: 0 }, uCursor: { value: new THREE.Vector2(3, 3) }, uArcForce: { value: 0 }, uAspect: { value: 1 } }), [texture])
  const { camera, size, gl } = useThree()
  const compact = size.width < 700
  const hit = useMemo(() => new THREE.Vector3(), [])
  const normal = useMemo(() => new THREE.Vector3(), [])
  const origin = useMemo(() => new THREE.Vector3(), [])
  const plane = useMemo(() => new THREE.Plane(), [])
  const attributes = useMemo(() => {
    const arms = 12
    const samples = compact ? 425 : 700
    const arcCount = compact ? 1400 : 2600
    const feedCount = compact ? 900 : 1800
    const count = arms * samples + arcCount * 2 + feedCount
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count * 4)
    const bands = new Float32Array(count)
    const arcs = new Float32Array(count)
    let i = 0
    for (let arm = 0; arm < arms; arm++) {
      for (let sample = 0; sample < samples; sample++, i++) {
        const random = (n: number) => { const x = Math.sin(i * n + 1.73) * 43758.5453; return x - Math.floor(x) }
        const along = (sample + random(78.233) * .7) / samples
        const angle = arm * Math.PI * 2 / arms + along * Math.PI * 1.65 + (random(12.9898) - .5) * .13
        const radius = 1.8 + along * 5.2 + (random(91.91) - .5) * .28
        positions[i * 3] = Math.cos(angle) * radius
        positions[i * 3 + 1] = (random(37.719) - .5) * .12 + Math.pow(random(53.29), 16) * .5
        positions[i * 3 + 2] = Math.sin(angle) * radius
        seeds.set([angle, radius, random(19.19), random(41.22)], i * 4)
        bands[i] = arm % 6
      }
    }
    for (let j = 0; j < arcCount * 2; j++, i++) {
      const random = (n: number) => { const x = Math.sin(i * n + 1.73) * 43758.5453; return x - Math.floor(x) }
      const index = j % arcCount
      const stripe = index % 9
      const angle = (Math.floor(index / 9) + random(12.3) * .5) / Math.ceil(arcCount / 9) * Math.PI * 2
      const radius = 1.87 + random(91.91) * .87
      positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius * 1.6, -.3], i * 3)
      seeds.set([angle, radius, random(19.19), random(41.22)], i * 4)
      bands[i] = stripe % 6
      arcs[i] = j < arcCount ? 1 : 2
    }
    for (let j = 0; j < feedCount; j++, i++) {
      const random = (n: number) => { const x = Math.sin(i * n + 1.73) * 43758.5453; return x - Math.floor(x) }
      const angle = random(12.9898) * Math.PI * 2
      seeds.set([angle, 1.8 + random(78.233) * 5, random(19.19), random(41.22)], i * 4)
      positions[i * 3 + 1] = (random(37.719) - .5) * .35
      bands[i] = j % 6
      arcs[i] = 3
    }
    return { positions, seeds, bands, arcs }
  }, [compact])
  useFrame((_, delta) => {
    if (!material.current || !disk.current) return
    const liveUniforms = material.current.uniforms
    const step = Math.min(delta, .05)
    const opening = intro.current
    disk.current.position.y = THREE.MathUtils.lerp(-.7, diskCenterY(progress.current), opening)
    disk.current.rotation.x = THREE.MathUtils.lerp(1.39, -.2, opening)
    const openingScale = THREE.MathUtils.lerp(.68, 1, opening)
    disk.current.scale.set(THREE.MathUtils.lerp(1.2, 1.65, opening) * openingScale, openingScale, 1.2 * openingScale)
    material.current.uniforms.uTime!.value += step
    material.current.uniforms.uProgress!.value = progress.current
    material.current.uniforms.uIntro!.value = opening
    const contraction = THREE.MathUtils.smoothstep(progress.current, .24, .69)
    const spinStep = -contraction * 1.25 * step
    const flowStep = -THREE.MathUtils.lerp(.27, .9, contraction) * step
    liveUniforms.uSpin!.value = THREE.MathUtils.euclideanModulo(liveUniforms.uSpin!.value + spinStep, Math.PI * 2)
    liveUniforms.uFlow!.value = THREE.MathUtils.euclideanModulo(liveUniforms.uFlow!.value + flowStep, Math.PI * 2)
    liveUniforms.uInward!.value = THREE.MathUtils.euclideanModulo(liveUniforms.uInward!.value + flowStep * .055, 1)
    liveUniforms.uFeedPhase!.value = THREE.MathUtils.euclideanModulo(liveUniforms.uFeedPhase!.value - step * .075, 1)
    liveUniforms.uFeedSpin!.value = THREE.MathUtils.euclideanModulo(liveUniforms.uFeedSpin!.value - step * .10, Math.PI * 2)
    material.current.uniforms.uPixelRatio!.value = gl.getPixelRatio()
    liveUniforms.uCursor!.value.copy(cursor.pointer)
    liveUniforms.uAspect!.value = size.width / Math.max(1, size.height)
    liveUniforms.uArcForce!.value = THREE.MathUtils.damp(liveUniforms.uArcForce!.value, cursor.active ? .28 + .72 * Math.min(cursor.velocity.length(), 1) : 0, 8, step)
    let force = 0
    if (cursor.active) {
      disk.current.updateWorldMatrix(true, false)
      normal.set(0, 1, 0).transformDirection(disk.current.matrixWorld)
      disk.current.getWorldPosition(origin)
      plane.setFromNormalAndCoplanarPoint(normal, origin)
      cursor.raycaster.setFromCamera(cursor.pointer, camera)
      if (cursor.raycaster.ray.intersectPlane(plane, hit)) {
        disk.current.worldToLocal(hit)
        if (Math.hypot(hit.x, hit.z) < 9) {
          material.current.uniforms.uPointer!.value.set(hit.x, hit.z)
          force = .6 + Math.min(cursor.velocity.length(), 2) * .3
        }
      }
    }
    const strength = material.current.uniforms.uForce!
    strength.value = THREE.MathUtils.damp(strength.value, force, 8, Math.min(delta, .05))
  })
  return (
    <points ref={disk} position={[0, DISK_REST_Y, 0]} rotation={[-.2, 0, 0]} scale={[1.65, 1, 1.2]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[attributes.positions, 3]} />
        <bufferAttribute attach="attributes-aSeed" args={[attributes.seeds, 4]} />
        <bufferAttribute attach="attributes-aBand" args={[attributes.bands, 1]} />
        <bufferAttribute attach="attributes-aArc" args={[attributes.arcs, 1]} />
      </bufferGeometry>
      <shaderMaterial ref={material} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={uniforms} vertexShader={`
        attribute vec4 aSeed; attribute float aBand; attribute float aArc; uniform float uTime; uniform float uSpin; uniform float uFlow; uniform float uInward; uniform float uFeedPhase; uniform float uFeedSpin; uniform float uProgress; uniform float uIntro; uniform float uPixelRatio; uniform vec2 uPointer; uniform float uForce; uniform vec2 uCursor; uniform float uArcForce; uniform float uAspect; varying float vGlyph; varying float vHeat; varying float vAlpha; varying float vBand; varying float vArc; varying float vBridge;
        void main() {
          float collapse = smoothstep(.38,.69,uProgress); float burst = smoothstep(.70,.80,uProgress);
          float a = aSeed.x - uTime * (.025 + .15 / aSeed.y) + uSpin;
          float diskFade = 1.0;
          float diskRadius = aSeed.y;
          if (aArc < .5) {
            float start = (aSeed.y-1.8)/5.2;
            float inward = fract(start + uInward);
            diskRadius = 1.8 + inward * 5.2;
            a += (inward-start) * 5.18;
            diskFade = smoothstep(0.0,.035,inward) * (1.0-smoothstep(.95,1.0,inward));
          }
          vec3 rest = vec3(cos(a)*diskRadius, position.y, sin(a)*diskRadius);
          float farSide = smoothstep(-.08,.55,-sin(a));
          float lens = exp(-pow((diskRadius-2.35)/.48,2.0)) * farSide;
          rest.y += lens * .45;
          float feedAlpha = 1.0;
          float feedLift = 0.0;
          float heatRadius = diskRadius;
          vBridge = 1.0;
          if (aArc > 2.5) {
            float phase = fract((aSeed.y-1.8)/5.0 + uFeedPhase);
            float feedRadius = 1.8 + phase * 10.0;
            heatRadius = feedRadius;
            float feedAngle = aSeed.x + uFeedSpin + uSpin - (1.0-phase) * 2.4;
            rest = vec3(cos(feedAngle)*feedRadius, position.y, sin(feedAngle)*feedRadius);
            feedLift = (1.0-smoothstep(.08,.30,phase)) * smoothstep(.65,1.0,uIntro);
            float rim = 1.9 + aSeed.z * .7;
            float wave = sin(feedAngle);
            float bend = sqrt(wave*wave + .018);
            float rise = (wave+bend)*.5;
            float flare = 1.25 * (1.0-smoothstep(.04,.58,rise));
            vec3 lensed = vec3(cos(feedAngle)*(rim+flare), rise*rim*1.4, -.3+(wave-bend)*.5*rim*.8);
            rest = mix(rest,lensed,feedLift);
            feedAlpha = smoothstep(0.0,.045,phase) * (1.0-smoothstep(.83,.98,phase));
          } else if (aArc > .5) {
            float flow = aSeed.x + uFlow;
            float radius = aSeed.y + .018 * sin(flow * 5.0 - uTime * .35 + aBand);
            heatRadius = radius;
            float wave = sin(flow);
            vBridge = mix(.58,1.24,smoothstep(.04,.55,abs(wave)));
            vBridge *= 1.0 + .2 * exp(-pow(cos(flow)*radius/1.8,2.0));
            float bend = sqrt(wave*wave + .018);
            float raised = (wave+bend)*.5;
            float diskSide = (wave-bend)*.5;
            float flare = 1.25 * (1.0-smoothstep(.04,.58,raised));
            rest = vec3(cos(flow)*(radius+flare), raised*radius*1.4 * (aArc > 1.5 ? -1.0 : 1.0), -.3 + diskSide*radius*.8);
          }
          vec3 p = rest;
          p *= 1.0 - collapse * .999;
          vec3 ray = normalize(vec3(cos(aSeed.x)*(.3+aSeed.z), (aSeed.w-.35)*1.2, sin(aSeed.x)*(.3+aSeed.z)));
          p += ray * burst * (5.0 + aSeed.y * 2.0);
          p.xy += vec2(sin(uTime*61.0),cos(uTime*57.0)) * collapse * (1.0-burst) * .012;
          if (uForce > .001 && (aArc < .5 || aArc > 2.5)) {
            float stable = 1.0-smoothstep(.30,.55,uProgress);
            vec2 away = p.xz - uPointer;
            float distanceToPointer = length(away);
            float influence = (1.0-smoothstep(.2,2.4,distanceToPointer)) * uForce * stable;
            p.xz += away / max(distanceToPointer,.001) * influence;
            p.y += influence * .5;
          }
          p.y *= smoothstep(0.0,.9,uIntro);
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          if (aArc > .5 && aArc < 2.5 && uArcForce > .001) {
            vec4 projected = projectionMatrix * mv;
            vec2 away = projected.xy / projected.w - uCursor;
            away.x *= uAspect;
            float proximity = 1.0-smoothstep(.025,.24,length(away));
            float stable = 1.0-smoothstep(.30,.55,uProgress);
            vec2 direction = away / max(length(away),.01);
            mv.xy += (direction*.22 + vec2(-direction.y,direction.x)*.14) * proximity * uArcForce * stable;
          }
          gl_Position = projectionMatrix * mv;
          float glyphSize = mix(15.0,21.0,smoothstep(.24,.76,aSeed.z)) + 7.0 * step(.88,aSeed.z);
          glyphSize *= aArc > 2.5 ? .7 : (aArc > .5 ? .78 : 1.0);
          gl_PointSize = clamp(glyphSize * (10.0 / -mv.z), 4.0, 31.0) * uPixelRatio * (1.0 - collapse * (1.0-burst) * .78);
          float streak = pow(.5 + .5 * sin(heatRadius * 2.0 - uTime * .18 + aBand), 2.0);
          float innerHeat = 1.0 - smoothstep(1.8,4.5,heatRadius);
          float gathering = smoothstep(.48,.67,uProgress) * (1.0-smoothstep(.72,.82,uProgress));
          vHeat = clamp(.30 + streak * .33 + innerHeat * .25 + lens * .16 + .10 * max(0.0,cos(a)) + gathering * (.10 + .16 * aSeed.z) + feedLift * .18,0.0,1.0);
          vBand = aBand;
          vArc = aArc;
          vGlyph = floor(aSeed.w*16.0);
          vAlpha = (.64 + .22 * vHeat) * (1.0-smoothstep(.78,.82,uProgress));
          vAlpha *= mix(.42,1.0,smoothstep(0.0,.85,uIntro));
          vAlpha *= diskFade;
          if (aArc > 2.5) {
            vAlpha *= feedAlpha * (1.0-smoothstep(.62,.80,uProgress)) * .75;
          } else if (aArc > .5) {
            float lower = aArc > 1.5 ? smoothstep(.38,.54,uProgress) : 1.0;
            vAlpha *= lower * .9 * smoothstep(.65,1.0,uIntro);
          }
        }`}
        fragmentShader={`
          uniform sampler2D uGlyph; varying float vGlyph; varying float vHeat; varying float vAlpha; varying float vBand; varying float vArc; varying float vBridge;
          void main() { vec2 cell = vec2(mod(vGlyph,4.0),floor(vGlyph/4.0)); vec2 uv=(cell+vec2(gl_PointCoord.x,1.0-gl_PointCoord.y))/4.0;
          float glyph=texture2D(uGlyph,uv).a;
          vec3 pigment=vec3(1.0,.57,.09);
          if(vBand>0.5) pigment=vec3(.95,.20,.025);
          if(vBand>1.5) pigment=vec3(1.0,.39,.06);
          if(vBand>2.5) pigment=vec3(.77,.16,.035);
          if(vBand>3.5) pigment=vec3(1.0,.88,.60);
          if(vBand>4.5) pigment=vec3(1.0,.32,.06);
          vec3 luminous=pigment * mix(.73,1.38,vHeat);
          luminous=mix(luminous,vec3(1.35,1.18,.78),smoothstep(.76,.97,vHeat)*.48);
          if(vArc>.5 && vArc<2.5) luminous=mix(luminous,vec3(1.42,1.22,1.02),.58 + .2 * step(3.5,vBand));
          luminous *= vBridge;
          gl_FragColor=vec4(luminous,glyph * vAlpha * .9);
          #include <colorspace_fragment>
          }`} />
    </points>
  )
}

const TOKEN_POSITIONS: [number, number, number, number][] = [
  [-6,3.0,0,.67],[-3.5,4.1,-2,.9],[0,3.1,-3,.48],[3.7,4.0,-2,.85],[6.2,2.3,-1,.68],
  [-7,1,-3,.3],[-4.8,.6,-1,.35],[-1.6,2,-4,.36],[1.8,2.2,-1,.43],[5,.3,-3,.3],
  [-6,-.9,-4,.23],[-2.8,1,-4,.25],[2.9,.4,-4,.24],[6.7,4.4,-4,.24],
  [-7.8,4.2,-7,.13],[-5.6,2.4,-8,.12],[-3.8,-.1,-7,.14],[-1.0,4.6,-8,.12],
  [1.3,.4,-7,.13],[3.1,3,-8,.12],[5.3,4.4,-7,.14],[7.4,.8,-8,.12],
  [-.76,3.9,-5,.16],[.64,3.3,-5,.14],[-.84,1.8,-5,.12],[.79,.9,-5,.17],
  [-.61,-.8,-5,.14],[.86,-1.3,-5,.12],
  [-.94,-3.2,-6,.14],[.95,-3.1,-7,.14],[-.58,-2.1,-7,.12],[.59,-2.4,-7,.12],
]

function Token({ position, index, progress, intro, smallTokens = false, texture, glow, cursor }: { position: [number, number, number, number]; index: number; texture: THREE.Texture; glow: THREE.Texture; cursor: CursorField } & SceneProps) {
  const group = useRef<THREE.Group>(null)
  const distant = index >= 14
  const trailMaterial = useRef<THREE.ShaderMaterial>(null)
  const dustMaterial = useRef<THREE.PointsMaterial>(null)
  const impulse = useRef(new THREE.Vector3())
  const momentum = useRef(new THREE.Vector3())
  const worldPoint = useMemo(() => new THREE.Vector3(), [])
  const closest = useMemo(() => new THREE.Vector3(), [])
  const geometry = useMemo(() => {
    const verts = smallTokens
      ? [[0,1.3,0],[-.68,0,0],[0,-.29,0],[.68,0,0],[0,-.48,0],[-.68,-.18,0],[0,-.58,0],[.68,-.18,0],[0,-1.25,0]]
      : [[0,1.3,0],[-.68,0,0],[0,-.12,.43],[.68,0,0],[0,-.12,-.43],[0,-.42,0],[-.68,-.15,0],[0,-.46,.43],[.68,-.15,0],[0,-.46,-.43],[0,-1.25,0]]
    const pairs = smallTokens
      ? [[0,1],[0,3],[0,2],[1,2],[2,3],[1,4],[4,3],[2,4],[5,6],[6,7],[5,8],[7,8],[6,8]]
      : [[0,1],[0,2],[0,3],[0,4],[1,2],[2,3],[3,4],[4,1],[5,1],[5,2],[5,3],[5,4],[6,7],[7,8],[8,9],[9,6],[10,6],[10,7],[10,8],[10,9]]
    const line: number[] = []
    for (const [a,b] of pairs) line.push(...verts[a!]!, ...verts[b!]!)
    const g = new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(line,3)); return g
  }, [smallTokens])
  const dust = useMemo(() => {
    const source = geometry.getAttribute('position')
    const samples: number[] = []
    for (let i = 0; i < source.count; i += 2) {
      const length = Math.hypot(source.getX(i + 1) - source.getX(i), source.getY(i + 1) - source.getY(i), source.getZ(i + 1) - source.getZ(i))
      const count = Math.max(2, Math.ceil(length / .035))
      for (let j = 0; j < count; j++) {
        const t = (j + .5) / count
        samples.push(THREE.MathUtils.lerp(source.getX(i),source.getX(i+1),t), THREE.MathUtils.lerp(source.getY(i),source.getY(i+1),t), THREE.MathUtils.lerp(source.getZ(i),source.getZ(i+1),t))
      }
    }
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.Float32BufferAttribute(samples, 3))
    return result
  }, [geometry])
  const trail = useMemo(() => {
    const result = new THREE.BufferGeometry()
    const attribute = new THREE.BufferAttribute(new Float32Array(24 * 3), 3)
    attribute.setUsage(THREE.DynamicDrawUsage)
    result.setAttribute('position', attribute)
    const along = new THREE.BufferAttribute(new Float32Array(24), 1)
    along.setUsage(THREE.DynamicDrawUsage)
    result.setAttribute('aAlong', along)
    const glyphs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    result.setAttribute('aGlyph', new THREE.Float32BufferAttribute(Array.from({ length: 24 }, (_, i) => glyphs[(i * 7 + index * 5) % glyphs.length]!), 1))
    return result
  }, [index])
  useEffect(() => () => { geometry.dispose(); dust.dispose(); trail.dispose() }, [geometry, dust, trail])
  useFrame(({ clock, camera }, delta) => {
    if (!group.current) return
    const t = clock.elapsedTime
    const stagger = (index % 5) * .018
    const fall = THREE.MathUtils.smoothstep(progress.current, .03 + stagger, .37 + stagger)
    const collapse = THREE.MathUtils.smoothstep(progress.current, .44, .69)
    const centerY = diskCenterY(progress.current)
    const burst = THREE.MathUtils.smoothstep(progress.current, .70, .81)
    const dissolve = THREE.MathUtils.smoothstep(progress.current, .27 + stagger, .43 + stagger)
    const linePhase = THREE.MathUtils.smoothstep(progress.current, .27 + stagger, .56 + stagger)
    const perspective = camera as THREE.PerspectiveCamera
    const homeX = index >= 22 ? position[0] * (15 - position[2]) * Math.tan(perspective.fov * Math.PI / 360) * perspective.aspect * .9 : position[0]
    worldPoint.set(homeX + impulse.current.x, position[1] + impulse.current.y, position[2])
    if (cursor.active) cursor.raycaster.ray.closestPointToPoint(worldPoint, closest)
    const distance = cursor.active ? worldPoint.distanceTo(closest) : Infinity
    const near = Math.max(0, 1 - distance / 2.5) * (1 - fall)
    const step = Math.min(delta, .04)
    const spread = Math.max(.25, Math.hypot(worldPoint.x - closest.x, worldPoint.y - closest.y))
    const pushX = cursor.active ? (worldPoint.x - closest.x) / spread : 0
    const pushY = cursor.active ? (worldPoint.y - closest.y) / spread : 0
    momentum.current.x += ((cursor.velocity.x * 18 + pushX * 12) * near - impulse.current.x * 12 - momentum.current.x * 5) * step
    momentum.current.y += ((cursor.velocity.y * 18 + pushY * 12) * near - impulse.current.y * 12 - momentum.current.y * 5) * step
    impulse.current.x += momentum.current.x * step
    impulse.current.y += momentum.current.y * step
    const spiral = index * 2.4
    const approachAngle = spiral - (1 - fall) * Math.PI * 1.5
    const swirl = smallTokens ? Math.sin(Math.PI * fall) : 0
    const swirlAngle = spiral - fall * Math.PI * 2
    group.current.position.set(THREE.MathUtils.lerp(homeX, Math.cos(approachAngle)*1.3, fall)+Math.cos(swirlAngle)*swirl*1.3+impulse.current.x*(1-fall),
      THREE.MathUtils.lerp(position[1], centerY + 2.8, fall)+swirl*(.8+.4*Math.sin(swirlAngle))+Math.sin(t*.5+index)*.08*(1-fall)+impulse.current.y*(1-fall),
      THREE.MathUtils.lerp(position[2], Math.sin(approachAngle)*1.3, fall)+Math.sin(swirlAngle)*swirl*.6 + burst*8)
    const s = (smallTokens ? Math.min(position[3], .2) : position[3]) * (index >= 14 ? 1 : THREE.MathUtils.smoothstep(intro.current, .25, .85)) * (1-collapse) * (1-burst)
    const vanish = 1 - THREE.MathUtils.smoothstep(dissolve, .55, 1)
    const tokenScale = s * (1 - fall * .65) * vanish
    group.current.visible = tokenScale > .001
    group.current.scale.setScalar(tokenScale)
    group.current.rotation.set(smallTokens ? 0 : .08 + Math.sin(t*.18+index)*.08 - impulse.current.y*.25,
      smallTokens ? Math.sin(t*.18+index)*.16 : t*.10+index*.3+fall*2 + impulse.current.x*.15,
      Math.sin(t*.15+index)*.07 - impulse.current.x*.25)
    if (dustMaterial.current) dustMaterial.current.opacity = (smallTokens ? (distant ? .035 : .06) : (.48 + .06 * Math.sin(t * .8 + index * 1.7))) * vanish * (1 - collapse) * (1 - burst)
    if (distant) return
    const vertices = trail.getAttribute('position') as THREE.BufferAttribute
    const along = trail.getAttribute('aAlong') as THREE.BufferAttribute
    const tail = Math.max(0, (linePhase - .55) / .45)
    for (let j = 0; j < 24; j++) {
      const a = 1 - Math.pow(1 - j / 23, 2.2)
      const q = THREE.MathUtils.lerp(tail, linePhase, a)
      const radius = 1.3 * (1-q)
      const angle = index * 2.4 + q * 7
      const y = centerY+(1-q)*2.8
      const attachment = (1-a) * (1-tail)
      vertices.setXYZ(j,
        Math.cos(angle)*radius + (group.current.position.x - Math.cos(spiral)*1.3)*attachment,
        y + (group.current.position.y - (centerY + 2.8))*attachment,
        Math.sin(angle)*radius + (group.current.position.z - Math.sin(spiral)*1.3)*attachment)
      along.setX(j, q)
    }
    vertices.needsUpdate = true
    along.needsUpdate = true
    if (trailMaterial.current) {
      trailMaterial.current.uniforms.uOpacity!.value = Math.sin(linePhase * Math.PI) * .95
    }
  })
  return <><group ref={group}><lineSegments geometry={geometry}><lineBasicMaterial color={smallTokens ? "#9da1a8" : (distant ? "#809cce" : "#b8d3ff")} transparent opacity={smallTokens ? .55 : (distant ? .48 : .68)} /></lineSegments>{(!distant || smallTokens) && <points geometry={dust}><pointsMaterial ref={dustMaterial} map={glow} color={smallTokens ? "#c6cbd3" : "#528fff"} size={smallTokens ? .12 : .18} transparent opacity={.2} blending={THREE.AdditiveBlending} depthWrite={false} /></points>}</group>{!distant && <points geometry={trail} frustumCulled={false}><shaderMaterial ref={trailMaterial} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={{ uGlyph: { value: texture }, uOpacity: { value: 0 } }} vertexShader={`attribute float aAlong; attribute float aGlyph; varying float vGlyph; varying float vWarm; void main(){ vec4 p=modelViewMatrix*vec4(position,1.); gl_Position=projectionMatrix*p; gl_PointSize=clamp(mix(4.,19.,1.-aAlong)*15./-p.z,2.,24.); vGlyph=aGlyph; vWarm=smoothstep(.12,.92,aAlong); }`} fragmentShader={`uniform sampler2D uGlyph; uniform float uOpacity; varying float vGlyph; varying float vWarm;
      void main(){
        vec2 cell=vec2(mod(vGlyph,4.),floor(vGlyph/4.));
        vec2 uv=(cell+vec2(gl_PointCoord.x,1.-gl_PointCoord.y))/4.;
        float a=texture2D(uGlyph,uv).a;
        vec3 cold=mix(vec3(.055,.18,.7),vec3(.22,.46,1.),vWarm);
        vec3 hot=mix(vec3(1.,.40,.055),vec3(1.,.74,.18),vWarm);
        vec3 color=mix(cold,hot,smoothstep(.24,.82,vWarm));
        gl_FragColor=vec4(color,a*uOpacity);
        #include <colorspace_fragment>
      }`} /></points>}</>
}

function Scene({ progress, intro, smallTokens = false }: SceneProps) {
  const { camera, gl } = useThree()
  const starField = useRef<THREE.Points>(null)
  const starMaterial = useRef<THREE.PointsMaterial>(null)
  const backgroundStarField = useRef<THREE.Points>(null)
  const backgroundStars = useRef<THREE.PointsMaterial>(null)
  const lowPower = useMemo(() => {
    const context = gl.getContext()
    const extension = context.getExtension('WEBGL_debug_renderer_info')
    const renderer = extension ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : ''
    return /swiftshader|llvmpipe|software/i.test(renderer)
  }, [gl])
  const texture = useMemo(glyphTexture, [])
  const glow = useMemo(ethGlowTexture, [])
  const cursor = useMemo<CursorField>(() => ({ pointer: new THREE.Vector2(3, 3), velocity: new THREE.Vector2(), previous: new THREE.Vector2(3, 3), raycaster: new THREE.Raycaster(), active: false }), [])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const bounds = gl.domElement.getBoundingClientRect()
      if (!bounds.width || !bounds.height || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        cursor.active = false
        cursor.velocity.set(0, 0)
        return
      }
      cursor.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2)
      if (cursor.active) cursor.velocity.set(THREE.MathUtils.clamp((cursor.pointer.x - cursor.previous.x) * 20, -3, 3), THREE.MathUtils.clamp((cursor.pointer.y - cursor.previous.y) * 20, -3, 3))
      cursor.previous.copy(cursor.pointer)
      cursor.active = true
    }
    const leave = () => { cursor.active = false; cursor.velocity.set(0, 0) }
    window.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerleave', leave)
    return () => { window.removeEventListener('pointermove', move); document.removeEventListener('pointerleave', leave) }
  }, [cursor, gl])
  useEffect(() => () => { texture.dispose(); glow.dispose() }, [texture, glow])
  useFrame((_, delta) => {
    const approach = THREE.MathUtils.smoothstep(progress.current, .38, .69)
    const release = THREE.MathUtils.smoothstep(progress.current, .70, .81)
    const starHandoff = THREE.MathUtils.smoothstep(progress.current, .18, .38)
    camera.position.z = 15 - 2 * approach * (1 - release)
    camera.position.y = 1.8
    if (starField.current && starMaterial.current) {
      starField.current.position.y = -5.2 * approach * (1 - approach)
      starField.current.rotation.z = approach * 1.5
      starField.current.scale.setScalar(1 - approach + release * 2.5)
      starMaterial.current.opacity = .6 * (1 - starHandoff)
      starField.current.visible = starMaterial.current.opacity > .001
    }
    if (backgroundStars.current && backgroundStarField.current) {
      backgroundStars.current.opacity = .6 * starHandoff * (1 - THREE.MathUtils.smoothstep(progress.current, .65, .82))
      backgroundStarField.current.visible = backgroundStars.current.opacity > .001
    }
    if (cursor.active) cursor.raycaster.setFromCamera(cursor.pointer, camera)
    cursor.velocity.multiplyScalar(Math.exp(-delta * 4))
  })
  const stars = useMemo(() => {
    const count = 5000
    const values = new Float32Array(count * 3)
    const random = (n: number) => { const value = Math.sin(n) * 43758.5453; return value - Math.floor(value) }
    for (let i = 0; i < count; i++) {
      values[i * 3] = (random(i * 127.1 + 1) * 2 - 1) * 17
      values[i * 3 + 1] = (random(i * 311.7 + 2) * 2 - 1) * 10
      values[i * 3 + 2] = -5 - random(i * 91.3 + 3) * 8
    }
    return values
  }, [])
  const wideStars = useMemo(() => {
    const values = new Float32Array(10500 * 3)
    const random = (n: number) => { const value = Math.sin(n) * 43758.5453; return value - Math.floor(value) }
    for (let i = 0; i < 10500; i++) {
      values[i * 3] = (random(i * 141.7 + 4) * 2 - 1) * 24
      values[i * 3 + 1] = (random(i * 271.9 + 5) * 2 - 1) * 15
      values[i * 3 + 2] = -5 - random(i * 83.1 + 6) * 8
    }
    return values
  }, [])
  useEffect(() => { camera.position.set(0, 1.8, 15); camera.lookAt(0, -1, 0) }, [camera])
  return <><color attach="background" args={['#03050a']} /><fog attach="fog" args={['#03050a', 13, 32]} /><ambientLight intensity={1} /><points ref={starField} frustumCulled={false}><bufferGeometry><bufferAttribute attach="attributes-position" args={[stars, 3]} /></bufferGeometry><pointsMaterial ref={starMaterial} color="#8295b5" size={.035} transparent opacity={.6} /></points><points ref={backgroundStarField} visible={false} frustumCulled={false}><bufferGeometry><bufferAttribute attach="attributes-position" args={[wideStars, 3]} /></bufferGeometry><pointsMaterial ref={backgroundStars} color="#8295b5" size={.035} transparent opacity={0} depthWrite={false} /></points><Accretion progress={progress} intro={intro} texture={texture} cursor={cursor} />{TOKEN_POSITIONS.map((p, i) => <Token key={i} position={p} index={i} progress={progress} intro={intro} smallTokens={smallTokens} texture={texture} glow={glow} cursor={cursor} />)}{!lowPower && <EffectComposer multisampling={0} resolutionScale={.75}><Bloom intensity={.45} luminanceThreshold={.65} mipmapBlur /></EffectComposer>}</>
}

export function AsciiVortex({ progress, intro, paused = false }: Omit<SceneProps, 'intro'> & { intro?: MutableRefObject<number>; paused?: boolean }) {
  const defaultIntro = useRef(1)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [webglAvailable, setWebglAvailable] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    try {
      const probe = document.createElement('canvas')
      const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
      if (gl) {
        gl.getExtension('WEBGL_lose_context')?.loseContext()
        setWebglAvailable(true)
      }
    } catch { setWebglAvailable(false) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  if (!webglAvailable) return <div className="vortex-fallback" aria-hidden="true" />
  return <Canvas className="vortex-canvas" dpr={[1, 1.5]} frameloop={reducedMotion || paused ? 'demand' : 'always'} camera={{ fov: 48, near: .1, far: 80 }} gl={{ antialias: true, powerPreference: 'high-performance' }} fallback={<div className="vortex-fallback" />}><Scene progress={progress} intro={intro ?? defaultIntro} smallTokens={!!intro} /></Canvas>
}
