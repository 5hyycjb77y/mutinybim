import {
  ORIGIN_POINT_LABEL,
  formatSharedFt,
  modelToShared,
  originPointPosition,
  type Command,
  type ModelState,
  type OriginPoint,
  type SiteFrame,
  type SitePoint,
  elementValues,
} from '@permitzip/bim-kernel'
import type { SnapCandidate } from '@permitzip/bim-viewer-3d'

/** Move the origin marker only, or move the building on the site. Worded the same everywhere the choice appears. */
export type OriginMoveMode = 'move_point' | 'relocate_project'

export const MOVE_MODE_LABEL: Readonly<Record<OriginMoveMode, string>> = {
  move_point: 'Move the origin marker only',
  relocate_project: 'Move the building on the site',
}

export const MOVE_MODE_HELP: Readonly<Record<OriginMoveMode, string>> = {
  move_point: 'Coordinates of everything else stay the same.',
  relocate_project: 'Site coordinates of everything change; geometry stays put.',
}

/** The undo / toast wording for a committed move ("Move the origin marker (project origin)"). */
export function moveOriginLabel(which: OriginPoint, mode: OriginMoveMode): string {
  const point = which === 'survey_point' ? 'site point' : 'project origin'
  return mode === 'move_point' ? `move the origin marker (${point})` : `move the building on the site (${point})`
}

/** The point Reset and Move act on: the marker's point, or the project base point when the marker shows the fixed internal origin. */
export function movableOriginPoint(which: OriginPoint): Exclude<OriginPoint, 'internal_origin'> {
  return which === 'internal_origin' ? 'project_base_point' : which
}

/** Put a movable point back on the internal origin (0, 0, 0). Only the marker moves; nothing else's coordinates change. Null when it is already there. */
export function resetOriginCommand(site: SiteFrame, which: OriginPoint): Command | null {
  const target = movableOriginPoint(which)
  const at = originPointPosition(site, target)
  if (Math.hypot(at.x, at.y, at.z) < 0.5) return null
  return moveOriginCommand(target, 'move_point', { position: { x: 0, y: 0, z: 0 } })
}

/** The marker's label: which point it is and its site coordinates, in feet. */
export function originLabel(site: SiteFrame, which: OriginPoint, at: SitePoint = originPointPosition(site, which)): { title: string; lines: readonly { readonly key: string; readonly value: string }[] } {
  const s = modelToShared(site, at)
  return {
    title: ORIGIN_POINT_LABEL[which],
    lines: [
      { key: 'N/S', value: formatSharedFt(s.northSouth) },
      { key: 'E/W', value: formatSharedFt(s.eastWest) },
      { key: 'Elev', value: formatSharedFt(s.elevation) },
    ],
  }
}

/** Where a dragged origin may snap: the other origin points, parts and equipment, and run ends. Kernel plan mm. */
export function originSnapCandidates(model: ModelState, site: SiteFrame, dragging: OriginPoint): SnapCandidate[] {
  const out: SnapCandidate[] = []
  for (const which of ['internal_origin', 'project_base_point', 'survey_point'] as const) {
    if (which === dragging) continue
    const p = originPointPosition(site, which)
    out.push({ x: p.x, y: p.y, label: ORIGIN_POINT_LABEL[which] })
  }
  for (const el of elementValues(model.elements)) {
    switch (el.kind) {
      case 'part':
        out.push({ x: el.position.x, y: el.position.y, label: el.mark || 'part' })
        break
      case 'equipment':
        out.push({ x: el.position.x, y: el.position.y, label: el.mark })
        break
      case 'run_segment':
        out.push({ x: el.start.x, y: el.start.y, label: 'run end' }, { x: el.end.x, y: el.end.y, label: 'run end' })
        break
      case 'wall':
      case 'grid':
        out.push({ x: el.start.x, y: el.start.y, label: el.kind }, { x: el.end.x, y: el.end.y, label: el.kind })
        break
      default:
        break
    }
  }
  return out
}

/** The command that moves one of the movable points; null for the internal origin, which never moves. */
export function moveOriginCommand(which: OriginPoint, mode: OriginMoveMode, change: { readonly position?: SitePoint; readonly shared?: { eastWest: number; northSouth: number; elevation: number } }): Command | null {
  if (which === 'internal_origin') return null
  const type = which === 'project_base_point' ? 'set_project_origin' : 'set_survey_point'
  return { type, mode, ...(change.position ? { position: change.position } : {}), ...(change.shared ? { shared: change.shared } : {}) }
}

export const INTERNAL_ORIGIN_FIXED = 'Model zero is the model’s own 0, 0, 0 and never moves. Move the project origin instead.'
