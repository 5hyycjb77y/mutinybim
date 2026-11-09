'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { TriangleMesh } from '@permitzip/bim-geometry'
import type { Plane3D } from './draft'
import { WHEEL_GAIN } from '@permitzip/bim-viewer-3d/wheel-zoom'

/**
 * The part in 3D: the solid, every reference plane drawn as a labelled
 * translucent sheet, and the insertion point's three directions. Orbits about
 * the part; the wheel zooms toward the pointer (an internal design note §7).
 *
 * One WebGL context for the editor's whole life: the parent keeps this mounted
 * and hides it while a flat view shows. A context per visit to the 3D tab ran
 * the browser out of contexts (Chrome keeps 16), and the one it then throws
 * away is the oldest: the Building Model's own 3D view behind the editor.
 * Frames are drawn only when something changes, never in a loop.
 */

interface Props {
  mesh: TriangleMesh | null
  planes: readonly Plane3D[]
  selectedPlane: string | null
  /** Shown or hidden by the parent (hidden: nothing is drawn). */
  visible: boolean
  /** Changing it fits the camera to the part again. */
  fitKey: number
}

interface Ctx {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  solid: THREE.Group
  guides: THREE.Group
  labels: Array<{ el: HTMLElement; at: THREE.Vector3 }>
  request: () => void
  frames: number
}

/** Model millimetres (z up, y left) to scene metres (y up). */
const toScene = (x: number, y: number, z: number) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000)

const PLANE_COLOR = 0x2563eb
const SELECTED_COLOR = 0xd97706

export function PartView3D({ mesh, planes, selectedPlane, visible, fitKey }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const labelHost = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<Ctx | null>(null)
  const visibleRef = useRef(visible)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setClearColor(0x000000, 0)
    el.prepend(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(3, 5, 4)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000)
    camera.position.set(2, 1.5, 2.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.zoomToCursor = true
    // OrbitControls zooms by 0.95^(zoomSpeed × px / 100) per wheel event: this makes a mouse notch the same ~17% as every other view.
    controls.zoomSpeed = (WHEEL_GAIN * 100) / -Math.log(0.95)
    // The middle button pans, as in the building model's views.
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
    controls.enableDamping = false
    const solid = new THREE.Group()
    const guides = new THREE.Group()
    scene.add(solid, guides)
    let pending = 0
    const ctx: Ctx = {
      renderer,
      scene,
      camera,
      controls,
      solid,
      guides,
      labels: [],
      frames: 0,
      request: () => {
        if (pending || !visibleRef.current) return
        pending = requestAnimationFrame(() => {
          pending = 0
          draw(ctx, el)
        })
      },
    }
    ctxRef.current = ctx
    controls.addEventListener('change', ctx.request)
    const resize = () => {
      const w = el.clientWidth || 1
      const h = el.clientHeight || 1
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      ctx.request()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(pending)
      ro.disconnect()
      controls.removeEventListener('change', ctx.request)
      controls.dispose()
      clear(solid)
      clear(guides)
      renderer.dispose()
      // Give the context back now; waiting for garbage collection is what exhausted them.
      renderer.forceContextLoss()
      renderer.domElement.remove()
      ctxRef.current = null
    }
  }, [])

  useEffect(() => {
    visibleRef.current = visible
    if (visible) ctxRef.current?.request()
  }, [visible])

  // The solid.
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    clear(ctx.solid)
    if (mesh && mesh.triangleCount > 0) {
      const positions = new Float32Array(mesh.positions.length)
      for (let i = 0; i < mesh.positions.length; i += 3) {
        positions[i] = (mesh.positions[i] ?? 0) / 1000
        positions[i + 1] = (mesh.positions[i + 2] ?? 0) / 1000
        positions[i + 2] = -(mesh.positions[i + 1] ?? 0) / 1000
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      g.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
      g.computeVertexNormals()
      const body = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb8c4d0, metalness: 0.1, roughness: 0.7, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }))
      body.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 25), new THREE.LineBasicMaterial({ color: 0x334155 })))
      ctx.solid.add(body)
    }
    ctx.request()
  }, [mesh])

  // Reference planes, their labels and the insertion point's directions.
  const extentKey = extentsOf(planes, mesh)
  useEffect(() => {
    const ctx = ctxRef.current
    const labelsEl = labelHost.current
    if (!ctx || !labelsEl) return
    clear(ctx.guides)
    labelsEl.replaceChildren()
    ctx.labels = []
    const ext = extentKey
    const pad = (lo: number, hi: number) => {
      const half = Math.max((hi - lo) / 2, 150) * 1.15
      const mid = (lo + hi) / 2
      return [mid - half, mid + half] as const
    }
    const [x0, x1] = pad(ext.min[0], ext.max[0])
    const [y0, y1] = pad(ext.min[1], ext.max[1])
    const [z0, z1] = [Math.min(0, ext.min[2]) - 0.08 * (ext.max[2] - ext.min[2] || 300), pad(ext.min[2], ext.max[2])[1]]
    for (const p of planes) {
      const corners =
        p.axis === 'x'
          ? [toScene(p.value, y0, z0), toScene(p.value, y1, z0), toScene(p.value, y1, z1), toScene(p.value, y0, z1)]
          : p.axis === 'y'
            ? [toScene(x0, p.value, z0), toScene(x1, p.value, z0), toScene(x1, p.value, z1), toScene(x0, p.value, z1)]
            : [toScene(x0, y0, p.value), toScene(x1, y0, p.value), toScene(x1, y1, p.value), toScene(x0, y1, p.value)]
      const selected = p.id === selectedPlane
      const color = selected ? SELECTED_COLOR : PLANE_COLOR
      const sheet = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]].filter((c): c is THREE.Vector3 => c !== undefined))
      ctx.guides.add(new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: selected ? 0.16 : p.builtin ? 0.035 : 0.07, side: THREE.DoubleSide, depthWrite: false })))
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.025, transparent: true, opacity: p.builtin ? 0.35 : 0.8 }))
      outline.computeLineDistances()
      ctx.guides.add(outline)
      const label = document.createElement('span')
      label.textContent = p.name
      label.dataset.testid = `pe-3d-plane-${p.id}`
      label.className = `pointer-events-none absolute -translate-y-full whitespace-nowrap rounded px-1 text-[11px] ${selected ? 'bg-warning-100 text-warning-800' : p.builtin ? 'text-muted-foreground' : 'bg-background/80 text-primary'}`
      labelsEl.appendChild(label)
      const at = corners[3]
      if (at) ctx.labels.push({ el: label, at })
    }
    // Insertion point: forward (x), left (y), up (z).
    const len = Math.max(x1 - x0, y1 - y0, z1 - z0) * 0.18
    const axes: Array<[THREE.Vector3, number, string]> = [
      [toScene(len, 0, 0), 0xdc2626, 'Front'],
      [toScene(0, len, 0), 0x16a34a, 'Left'],
      [toScene(0, 0, len), 0x2563eb, 'Up'],
    ]
    for (const [end, color, name] of axes) {
      ctx.guides.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end]), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })))
      const label = document.createElement('span')
      label.textContent = name
      label.className = 'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-[10px] font-medium text-muted-foreground'
      labelsEl.appendChild(label)
      ctx.labels.push({ el: label, at: end })
    }
    ctx.request()
  }, [planes, selectedPlane, extentKey])

  // Fit the camera to the part: on open and when asked (fitKey). Not on every
  // edit: a refit then would yank the camera while someone works.
  const extentRef = useRef(extentKey)
  useEffect(() => {
    extentRef.current = extentKey
  }, [extentKey])
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const ext = extentRef.current
    const lo = toScene(ext.min[0], ext.max[1], Math.min(0, ext.min[2]))
    const hi = toScene(ext.max[0], ext.min[1], ext.max[2])
    const box = new THREE.Box3().setFromPoints([lo, hi])
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length() || 1
    ctx.controls.target.copy(center)
    ctx.camera.position.copy(center).add(new THREE.Vector3(size * 1.1, size * 0.8, size * 1.3))
    ctx.camera.near = size / 200
    ctx.camera.far = size * 200
    ctx.camera.updateProjectionMatrix()
    ctx.controls.update()
    ctx.request()
  }, [fitKey])

  return (
    <div ref={host} className={`relative size-full overflow-hidden ${visible ? '' : 'hidden'}`} data-testid="part-view-3d" data-planes={planes.length} role="img" aria-label="3D view of the part with its reference planes">
      <div ref={labelHost} className="pointer-events-none absolute inset-0" />
    </div>
  )
}

function draw(ctx: Ctx, el: HTMLElement) {
  ctx.renderer.render(ctx.scene, ctx.camera)
  ctx.frames += 1
  el.dataset.frames = String(ctx.frames)
  const w = el.clientWidth
  const h = el.clientHeight
  const v = new THREE.Vector3()
  for (const { el: label, at } of ctx.labels) {
    v.copy(at).project(ctx.camera)
    const shown = v.z > -1 && v.z < 1
    label.style.display = shown ? '' : 'none'
    label.style.left = `${((v.x + 1) / 2) * w}px`
    label.style.top = `${((1 - v.y) / 2) * h}px`
  }
}

function clear(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child)
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        const m = o.material
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else m.dispose()
      }
    })
  }
}

interface Extents {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

const extentCache = new Map<string, Extents>()

/** The part's extent from its planes and solid, as a stable object per distinct value (an effect dependency). */
function extentsOf(planes: readonly Plane3D[], mesh: TriangleMesh | null): Extents {
  const min: [number, number, number] = [0, 0, 0]
  const max: [number, number, number] = [0, 0, 0]
  const k = { x: 0, y: 1, z: 2 } as const
  for (const p of planes) {
    const i = k[p.axis]
    min[i] = Math.min(min[i], p.value)
    max[i] = Math.max(max[i], p.value)
  }
  if (mesh) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const value = mesh.positions[i + j] ?? 0
        min[j] = Math.min(min[j] ?? 0, value)
        max[j] = Math.max(max[j] ?? 0, value)
      }
    }
  }
  const key = [...min, ...max].map((n) => Math.round(n)).join(',')
  const hit = extentCache.get(key)
  if (hit) return hit
  const ext: Extents = { min, max }
  if (extentCache.size > 200) extentCache.clear()
  extentCache.set(key, ext)
  return ext
}
