import {
  elementsOfKind, hostSolidBlocks, levelOf, lineJoinsOf, pointInPolygon, tiltedZ, wallBodyProfile,
  type HostBlock, type Level, type ModelState, type Vec2, type Wall,
} from '@permitzip/bim-kernel'
import type { CameraPose } from './camera-paths'

const RADIUS = 200
const CELL = 4000
const EYE_HEIGHT = 1600

export interface Walker extends Vec2 {
  readonly yaw: number
  readonly pitch: number
}

function wallOutline(wall: Wall): Vec2[] {
  const { start, end, thickness } = wall
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  if (!length) return []
  const dx = -(end.y - start.y) * thickness / (2 * length)
  const dy = (end.x - start.x) * thickness / (2 * length)
  return [start, end].map(p => ({ x: p.x + dx, y: p.y + dy }))
    .concat([end, start].map(p => ({ x: p.x - dx, y: p.y - dy })))
}

function touches(block: HostBlock, p: Vec2): boolean {
  if (tiltedZ(block.z0, block.tilt0, p) >= 1750 || tiltedZ(block.z1, block.tilt1, p) <= 50) return false
  const outline = block.outline
  if (pointInPolygon(p, outline)) return true
  return outline.some((a, i) => {
    const b = outline[(i + 1) % outline.length]!
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < RADIUS
  })
}

/** Index the selected floor once. A step only queries the cell the walker enters. */
export function walkFloor(model: ModelState, level: Level) {
  const cells = new Map<string, HostBlock[]>()
  const large: HostBlock[] = []
  const walls = elementsOfKind(model.elements, 'wall').filter(w => levelOf(model.elements, w)?.id === level.id)
  for (const wall of walls) {
    const blocks = hostSolidBlocks(model.elements, wall, wall.height, wallBodyProfile(wall))
      ?? [{ outline: lineJoinsOf(model.elements, wall.id)?.outline ?? wallOutline(wall), z0: 0, z1: wall.height }]
    for (const block of blocks) {
      if (!block.outline.length) continue
      const xs = block.outline.map(p => p.x), ys = block.outline.map(p => p.y)
      const x0 = Math.floor((Math.min(...xs) - RADIUS) / CELL), x1 = Math.floor((Math.max(...xs) + RADIUS) / CELL)
      const y0 = Math.floor((Math.min(...ys) - RADIUS) / CELL), y1 = Math.floor((Math.max(...ys) + RADIUS) / CELL)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 256) {
        large.push(block)
        continue
      }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`
        const group = cells.get(key)
        if (group) group.push(block)
        else cells.set(key, [block])
      }
    }
  }
  const clear = (p: Vec2) => {
    const nearby = cells.get(`${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`)
    return !nearby?.some(block => touches(block, p)) && !large.some(block => touches(block, p))
  }
  const spawn = (camera: CameraPose): Walker | null => {
    const doors = elementsOfKind(model.elements, 'opening').filter(o => o.openingType === 'door' && levelOf(model.elements, o)?.id === level.id)
    for (const door of doors) {
      const wall = model.elements[door.hostId]
      if (wall?.kind !== 'wall' || !clear(door.position)) continue
      const angle = Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x)
      for (const yaw of [angle + Math.PI / 2 + 0.18, angle - Math.PI / 2 - 0.18]) {
        const dx = Math.cos(yaw), dy = Math.sin(yaw)
        // Approach far enough back to see the facade, shortening the approach in a tight room.
        let back = 0
        while (back < 4200 && clear({ x: door.position.x - (back + 100) * dx, y: door.position.y - (back + 100) * dy })) back += 100
        if (back >= 800) return { x: door.position.x - back * dx, y: door.position.y - back * dy, yaw, pitch: 0 }
      }
    }
    const yaw = Math.atan2(camera.target.y - camera.eye.y, camera.target.x - camera.eye.x)
    for (const p of [camera.target, camera.eye]) {
      if (clear(p)) return { x: p.x, y: p.y, yaw, pitch: 0 }
    }
    for (const w of walls) {
      const angle = Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x)
      const offset = w.thickness / 2 + 1000
      const p = { x: (w.start.x + w.end.x) / 2 - Math.sin(angle) * offset, y: (w.start.y + w.end.y) / 2 + Math.cos(angle) * offset }
      if (clear(p)) return { ...p, yaw: angle, pitch: 0 }
    }
    return null
  }
  return { clear, spawn }
}

/** Swept in short steps so a slow frame cannot jump a thin wall. Slide along its face. */
export function advanceWalker(start: Walker, dx: number, dy: number, clear: (p: Vec2) => boolean): Walker {
  let x = start.x, y = start.y
  const steps = Math.ceil(Math.hypot(dx, dy) / (RADIUS / 2))
  for (let i = 0; i < steps; i++) {
    const nx = x + dx / steps, ny = y + dy / steps
    if (clear({ x: nx, y: ny })) { x = nx; y = ny }
    else if (clear({ x: nx, y })) x = nx
    else if (clear({ x, y: ny })) y = ny
  }
  return { ...start, x, y }
}

export function walkingPose(w: Walker, level: Level): CameraPose {
  const eye = { x: w.x, y: w.y, z: level.elevationMm + EYE_HEIGHT }
  const range = 2000 * Math.cos(w.pitch)
  return { eye, target: { x: w.x + range * Math.cos(w.yaw), y: w.y + range * Math.sin(w.yaw), z: eye.z + 2000 * Math.sin(w.pitch) } }
}
