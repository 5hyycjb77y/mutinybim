import { linkedElementKey, viewModelLevel, REFERENCE_PLAN_HEIGHT_MM, type AnchorName, type LinkedReferenceIndex, type ModelState, type Vec2, type ViewElement } from '@permitzip/bim-kernel'
import type { SnapPoint } from '../views-sheets/annotation-tools'

/**
 * The points a dimension can follow on a linked model's elements in a plan:
 * each long, thin element's two faces, centre line and ends; anything else
 * its middle. The reference is the linked element's key and an anchor name,
 * so the dimension follows the element by its GlobalId when the link updates
 * (the kernel's `resolveLinkedAnchor`). Plans only: sections keep the clicked
 * point.
 */
export function linkedDimensionAnchors(index: LinkedReferenceIndex, model: ModelState, view: ViewElement, toPaper: (p: Vec2) => Vec2): SnapPoint[] {
  if (view.viewType === 'section' || view.viewType === 'detail') return []
  const level = viewModelLevel(model, view.props?.level, view.props?.levelElevationMm)
  if (!level) return []
  const z = level.elevationMm + REFERENCE_PLAN_HEIGHT_MM
  const out: SnapPoint[] = []
  const push = (key: string, anchor: AnchorName, at: Vec2, label: string) => out.push({ ref: { elementId: key, anchor }, at: toPaper(at), label })
  for (const item of index.items) {
    if (!item.rule.snap || z < item.minZ || z > item.maxZ) continue
    const key = linkedElementKey(item.ref)
    const noun = `linked ${item.rule.noun}`
    if (item.line) {
      const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
      push(key, 'edge_left', mid(item.line.faces[0].start, item.line.faces[0].end), `${noun} face`)
      push(key, 'edge_right', mid(item.line.faces[1].start, item.line.faces[1].end), `${noun} face`)
      push(key, 'mid', mid(item.line.axis.start, item.line.axis.end), `${noun} centre line`)
      push(key, 'start', item.line.axis.start, `${noun} end`)
      push(key, 'end', item.line.axis.end, `${noun} end`)
    } else {
      let x = 0
      let y = 0
      for (const p of item.outline) {
        x += p.x
        y += p.y
      }
      push(key, 'center', { x: x / item.outline.length, y: y / item.outline.length }, `${noun} middle`)
    }
  }
  return out
}
