import {
  DEFAULT_SETTINGS,
  enlargedPlanCommands,
  planCommit,
  withUpgradePolicy,
  type Command,
  type DrawingItem,
  type ModelState,
  type Vec2,
  type ViewElement,
} from '@permitzip/bim-kernel'
import { buildGraphicsSnapIndex, snapToGraphics } from '../src/editor/views-sheets/annotation-tools'
import { annotationGrips, gripCommand } from '../src/editor/views-sheets/draft/grips'

let seq = 0
function emptyModel(): ModelState {
  return { modelId: 'm-callout-editor', revision: 0 as ModelState['revision'], elements: {}, connections: [], settings: DEFAULT_SETTINGS }
}

function runAll(model: ModelState, cmds: readonly Command[]): ModelState {
  let cur = model
  for (const cmd of cmds) {
    const res = withUpgradePolicy(
      () => true,
      () =>
        planCommit(
          cur,
          [],
          { idempotencyKey: `ce-${++seq}`, baseRevision: cur.revision, actor: { id: 'tester', name: 'Tester', kind: 'human' }, command: cmd },
          () => '2026-11-22T00:00:00.000Z',
        ),
    )
    if (!res.ok) throw new Error(`Command ${cmd.type} refused: ${res.error.code} — ${res.error.message}`)
    cur = res.model
  }
  return cur
}

const FT = 304.8
const pt = (xFt: number, yFt: number): Vec2 => ({ x: Math.round(xFt * FT), y: Math.round(yFt * FT) })

// 1:100 paper transform (100 model mm = 1 paper mm, y flipped)
const toPaper = (p: Vec2): Vec2 => ({ x: p.x / 100, y: 200 - p.y / 100 })
const toStored = (p: Vec2): Vec2 => ({ x: p.x * 100, y: (200 - p.y) * 100 })

describe('Revit-style callout grips, live crop sync, and graphics snapping', () => {
  test('rectangular callout emits 4 corner + 4 edge + 1 head grip and dragging an edge syncs the enlarged plan crop', () => {
    let m = emptyModel()
    m = runAll(m, [
      { type: 'create_level', levelId: 'L1', name: 'Level 1', elevationMm: 0 },
      { type: 'create_view', viewId: 'v-plan', name: 'Level 1 Plan', viewType: 'floor_plan', crop: { min: pt(-2, -2), max: pt(30, 30) }, props: { level: 'Level 1', scale: 96 } },
    ])
    const init = enlargedPlanCommands(m, {
      parentViewId: 'v-plan',
      viewId: 'v-enlarged',
      calloutId: 'co-rect',
      name: 'Enlarged Restroom',
      box: { min: pt(0, 0), max: pt(12, 10) },
      scale: 48,
    })
    if (typeof init === 'string') throw new Error(init)
    m = runAll(m, init)

    const view = m.elements['v-plan'] as ViewElement
    const item = m.elements['co-rect'] as DrawingItem
    const grips = annotationGrips(m, view, item, toPaper)
    expect(grips.filter((g) => g.kind === 'callout-corner')).toHaveLength(4)
    expect(grips.filter((g) => g.kind === 'callout-edge')).toHaveLength(4)
    expect(grips.filter((g) => g.kind === 'callout-head')).toHaveLength(1)

    // Drag the east edge grip (`e1`) out from 12' to 18'
    const eastGrip = grips.find((g) => g.key === 'e1')!
    const cmd = gripCommand({ model: m, view, item, grip: eastGrip, to: toPaper(pt(18, 5)), snap: null, toPaper, toStored })
    expect(cmd).not.toBeNull()
    expect(typeof cmd).toBe('object')
    if (!cmd || typeof cmd === 'string') throw new Error('expected command')
    expect(cmd.type).toBe('batch_documents')
    m = runAll(m, [cmd])

    const updatedEnlarged = m.elements['v-enlarged'] as ViewElement
    expect(updatedEnlarged.cropMax.x).toBeCloseTo(18 * FT, 0)
  })

  test('polygonal L-shape callout emits vertex grips and dragging a vertex updates both boundary and cropPolygon', () => {
    let m = emptyModel()
    m = runAll(m, [
      { type: 'create_level', levelId: 'L1', name: 'Level 1', elevationMm: 0 },
      { type: 'create_view', viewId: 'v-plan', name: 'Level 1 Plan', viewType: 'floor_plan', crop: { min: pt(-2, -2), max: pt(30, 30) }, props: { level: 'Level 1', scale: 96 } },
    ])
    const poly = [pt(0, 0), pt(16, 0), pt(16, 8), pt(10, 8), pt(10, 14), pt(0, 14)]
    const init = enlargedPlanCommands(m, {
      parentViewId: 'v-plan',
      viewId: 'v-enlarged',
      calloutId: 'co-l',
      name: 'Enlarged Wet Core',
      polygon: poly,
      scale: 48,
    })
    if (typeof init === 'string') throw new Error(init)
    m = runAll(m, init)

    const view = m.elements['v-plan'] as ViewElement
    const item = m.elements['co-l'] as DrawingItem
    const grips = annotationGrips(m, view, item, toPaper)
    expect(grips.filter((g) => g.kind === 'callout-vertex')).toHaveLength(6)
    expect(grips.filter((g) => g.kind === 'callout-head')).toHaveLength(1)

    // Drag vertex 1 from (16', 0) to (20', 0)
    const v1 = grips.find((g) => g.key === 'v1')!
    const cmd = gripCommand({ model: m, view, item, grip: v1, to: toPaper(pt(20, 0)), snap: null, toPaper, toStored })
    if (!cmd || typeof cmd === 'string') throw new Error('expected command')
    m = runAll(m, [cmd])
    const updatedCallout = m.elements['co-l'] as DrawingItem
    const updatedView = m.elements['v-enlarged'] as ViewElement
    expect(updatedCallout.callout?.boundary?.[1]?.x).toBeCloseTo(20 * FT, 0)
    expect(updatedView.props?.cropPolygon?.[1]?.x).toBeCloseTo(20 * FT, 0)
  })

  test('graphics snap index snaps to wall outer face corners, wall face segments, and grid intersections', () => {
    let m = emptyModel()
    m = runAll(m, [
      { type: 'create_level', levelId: 'L1', name: 'Level 1', elevationMm: 0 },
      {
        type: 'add_architecture',
        levelId: 'L1',
        walls: [{ wallId: 'w1', start: { x: 0, y: 0 }, end: { x: 6000, y: 0 }, heightMm: 3000, thicknessMm: 200 }],
        openings: [],
        rooms: [],
        casework: [],
      },
      { type: 'create_element', elementId: 'g-a', levelId: 'L1', kind: 'grid', label: 'A', placement: { kind: 'line', start: { x: 3000, y: -1000 }, end: { x: 3000, y: 5000 } } },
      { type: 'create_element', elementId: 'g-1', levelId: 'L1', kind: 'grid', label: '1', placement: { kind: 'line', start: { x: -1000, y: 2000 }, end: { x: 7000, y: 2000 } } },
      { type: 'create_view', viewId: 'v-plan', name: 'Level 1 Plan', viewType: 'floor_plan', crop: { min: { x: -1000, y: -1000 }, max: { x: 7000, y: 5000 } }, props: { level: 'Level 1', scale: 96 } },
    ])

    const view = m.elements['v-plan'] as ViewElement
    const index = buildGraphicsSnapIndex(m, view, toPaper)

    // 1. Near wall north face corner (0, +100 mm)
    const wallCornerNear = toPaper({ x: 40, y: 130 })
    const cornerHit = snapToGraphics(index, wallCornerNear, 3)
    expect(cornerHit).not.toBeNull()
    expect(cornerHit!.label).toBe('wall corner')
    expect(toStored(cornerHit!.at).y).toBeCloseTo(100, 0)

    // 2. Near grid intersection A × 1 at (3000, 2000)
    const gridNear = toPaper({ x: 3050, y: 1960 })
    const gridHit = snapToGraphics(index, gridNear, 3)
    expect(gridHit).not.toBeNull()
    expect(gridHit!.kind).toBe('intersection')
    expect(gridHit!.label).toBe('grid intersection')
    expect(toStored(gridHit!.at).x).toBeCloseTo(3000, 0)
    expect(toStored(gridHit!.at).y).toBeCloseTo(2000, 0)

    // 3. Near mid-wall outer face at (4500, +150) -> snaps onto wall face at y = +100
    const wallFaceNear = toPaper({ x: 4500, y: 160 })
    const faceHit = snapToGraphics(index, wallFaceNear, 3)
    expect(faceHit).not.toBeNull()
    expect(faceHit!.kind).toBe('edge')
    expect(faceHit!.label).toBe('wall face')
    expect(toStored(faceHit!.at).y).toBeCloseTo(100, 0)
  })
})
