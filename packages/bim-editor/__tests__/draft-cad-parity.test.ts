import {
  asElementId,
  layoutNote,
  noteAutoShoulderPaper,
  noteLeadersAfterMove,
  type DrawingItem,
  type ModelState,
  type TextBlock,
} from '@permitzip/bim-kernel'
import { annotationBox } from '../src/editor/views-sheets/annotation-tools'
import {
  DEFAULT_DRAFT_SETTINGS,
  DEFAULT_MODIFY_PARAMS,
  constrainPoint,
  listeningPoint,
  marqueeHits,
  modifyRequest,
  shapeCommand,
  type Constrained,
} from '../src/editor/views-sheets/draft/draft-input'

const id = (s: string) => asElementId(s)
const identity = (p: { x: number; y: number }) => p
const pick = (x: number, y: number, itemId: string | null = null): Constrained => ({
  at: { x, y },
  snapLabel: null,
  snapKind: null,
  snapRef: null,
  tracking: null,
  itemId,
})

function lineItem(itemId: string, x1: number, y1: number, x2: number, y2: number): DrawingItem {
  return {
    id: id(itemId),
    ownerId: id('view-1'),
    kind: 'drawing_item',
    shape: 'line',
    points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
    version: 0,
    authoredRev: {},
  }
}

describe('bim-editor CAD drafting parity (slice b)', () => {
  test('filled region propagates extended hatch pattern and halftone/screened tone', () => {
    const cmd = shapeCommand({
      tool: 'region',
      paper: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }],
      settings: { ...DEFAULT_DRAFT_SETTINGS, hatch: 'metal_deck', regionTone: 'screened', masking: false },
      toStored: identity,
      storedPerPaperMm: 1,
      ownerId: 'view-1',
      itemId: 'reg-1',
    })
    expect(typeof cmd).toBe('object')
    if (typeof cmd === 'object' && cmd.type === 'add_drawing_item') {
      expect(cmd.fill).toEqual({ pattern: 'metal_deck', tone: 'screened' })
    }
  })

  test('arc_radius and arc_tangent compile cleanly to arc commands', () => {
    const radCmd = shapeCommand({
      tool: 'arc_radius',
      paper: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 50 }],
      settings: DEFAULT_DRAFT_SETTINGS,
      toStored: identity,
      storedPerPaperMm: 1,
      ownerId: 'view-1',
      itemId: 'arc-r',
    })
    expect(typeof radCmd).toBe('object')
    if (typeof radCmd === 'object' && radCmd.type === 'add_drawing_item') {
      expect(radCmd.shape).toBe('arc')
      expect(radCmd.points).toHaveLength(3)
    }

    const tanCmd = shapeCommand({
      tool: 'arc_tangent',
      paper: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 50, y: 50 }],
      settings: DEFAULT_DRAFT_SETTINGS,
      toStored: identity,
      storedPerPaperMm: 1,
      ownerId: 'view-1',
      itemId: 'arc-t',
    })
    expect(typeof tanCmd).toBe('object')
    if (typeof tanCmd === 'object' && tanCmd.type === 'add_drawing_item') {
      expect(tanCmd.shape).toBe('arc')
      expect(tanCmd.points).toHaveLength(3)
    }
  })

  test('quadrant and tangent snaps return distinct snapKind values', () => {
    const circle: DrawingItem = {
      id: id('circ-1'),
      ownerId: id('view-1'),
      kind: 'drawing_item',
      shape: 'circle',
      points: [{ x: 100, y: 100 }, { x: 150, y: 100 }],
      version: 0,
      authoredRev: {},
    }
    const quad = constrainPoint({
      at: { x: 100.5, y: 149.2 },
      from: null,
      items: [circle],
      toPaper: identity,
      settings: { ...DEFAULT_DRAFT_SETTINGS, snaps: ['quadrant'] },
      reachMm: 5,
    })
    expect(quad.snapKind).toBe('quadrant')
    expect(quad.at.x).toBeCloseTo(100, 3)
    expect(quad.at.y).toBeCloseTo(150, 3)

    // From (0, 100) to circle centered at (100, 100) r=50: tangent angles are 120° and 240° → (75, 100 ± 25√3)
    const tan = constrainPoint({
      at: { x: 76, y: 142 },
      from: { x: 0, y: 100 },
      items: [circle],
      toPaper: identity,
      settings: { ...DEFAULT_DRAFT_SETTINGS, snaps: ['tangent'] },
      reachMm: 5,
    })
    expect(tan.snapKind).toBe('tangent')
    expect(tan.snapLabel).toBe('tangent')
    expect(tan.at.x).toBeCloseTo(75, 3)
    expect(tan.at.y).toBeCloseTo(100 + 25 * Math.sqrt(3), 3)
  })

  test('chamfer, match_type, and mirror_pick build valid kernel ModifyOp requests', () => {
    const l1 = lineItem('l1', 0, 0, 100, 0)
    const l2 = lineItem('l2', 0, 0, 0, 100)
    const axis = lineItem('axis', 50, 0, 50, 100)

    const ch = modifyRequest('chamfer', [pick(80, 0, 'l1'), pick(0, 80, 'l2')], { ...DEFAULT_MODIFY_PARAMS, chamferD1: '2"', chamferD2: '3"' }, identity, [], [l1, l2])
    expect(typeof ch).toBe('object')
    if (typeof ch === 'object') {
      expect(ch.operation.op).toBe('chamfer')
      expect(ch.ids).toEqual(['l1', 'l2'])
    }

    const mt = modifyRequest('match_type', [pick(10, 0, 'l1'), pick(0, 10, 'l2')], DEFAULT_MODIFY_PARAMS, identity, [], [l1, l2])
    expect(typeof mt).toBe('object')
    if (typeof mt === 'object') {
      expect(mt.operation).toEqual({ op: 'match_type', sourceId: 'l1' })
      expect(mt.ids).toEqual(['l2'])
    }

    const mp = modifyRequest('mirror_pick', [pick(50, 40, 'axis')], { ...DEFAULT_MODIFY_PARAMS, copy: true }, identity, ['l1'], [l1, axis])
    expect(typeof mp).toBe('object')
    if (typeof mp === 'object') {
      expect(mp.operation).toEqual({ op: 'mirror', a: { x: 50, y: 0 }, b: { x: 50, y: 100 }, copy: true })
      expect(mp.ids).toEqual(['l1'])
    }
  })

  test('listeningPoint computes exact ray endpoint and marqueeHits distinguishes window vs crossing', () => {
    const pt = listeningPoint({ x: 10, y: 20 }, { x: 40, y: 60 }, 25)
    expect(pt).not.toBeNull()
    expect(pt!.x).toBeCloseTo(25, 4)
    expect(pt!.y).toBeCloseTo(40, 4)

    const inside = lineItem('in', 20, 20, 40, 40)
    const straddling = lineItem('cross', 40, 40, 120, 40)
    // Left-to-right (window): only fully enclosed item
    expect(marqueeHits([inside, straddling], identity, { x: 10, y: 10 }, { x: 60, y: 60 })).toEqual(['in'])
    // Right-to-left (crossing): both enclosed and straddling items
    expect(marqueeHits([inside, straddling], identity, { x: 60, y: 60 }, { x: 10, y: 10 })).toEqual(['in', 'cross'])
  })

  test('moving a note preserves a dead-level horizontal leader shoulder and flips side when dragged past arrow tip', () => {
    const paragraphs = [{ runs: [{ text: 'EXTERIOR WALL ASSEMBLY' }] }]
    const layout = layoutNote(paragraphs, { width: 60, height: null, size: 2.5 })
    const item: DrawingItem = {
      id: id('note-1'),
      ownerId: id('view-1'),
      kind: 'drawing_item',
      shape: 'text',
      points: [{ x: 100, y: 50 }],
      note: {
        space: 'paper',
        box: { width: 60, height: null, rotation: 0 },
        paragraphs,
        lineSpacing: 1,
        mask: true,
        leaders: [{ to: { x: 40, y: 80 }, elbow: { x: 95, y: 51.5 }, arrow: 'filled_arrow' }],
      },
      version: 0,
      authoredRev: {},
    }
    const movedRight: TextBlock = { itemId: item.id, origin: { x: 120, y: 20 }, rotation: 0, layout }
    const leadersRight = noteLeadersAfterMove(item, movedRight, identity, identity)
    const firstMid = layout.lines[0]!.top + layout.lines[0]!.height / 2
    // Shoulder sits left of the moved box, dead-level with the first line's center
    expect(leadersRight[0]!.elbow!.x).toBeLessThan(movedRight.origin.x)
    expect(leadersRight[0]!.elbow!.y).toBeCloseTo(movedRight.origin.y + firstMid, 4)

    // Drag the note across the arrowhead to the LEFT of x=40 → shoulder flips to the RIGHT edge of the box
    const movedLeft: TextBlock = { itemId: item.id, origin: { x: -50, y: 30 }, rotation: 0, layout }
    const leadersLeft = noteLeadersAfterMove(item, movedLeft, identity, identity)
    expect(leadersLeft[0]!.elbow!.x).toBeGreaterThan(movedLeft.origin.x + layout.width)
    expect(leadersLeft[0]!.elbow!.y).toBeCloseTo(movedLeft.origin.y + firstMid, 4)
    expect(noteAutoShoulderPaper(movedLeft, { x: 40, y: 80 }).y).toBeCloseTo(movedLeft.origin.y + firstMid, 4)
  })

  test('annotationBox for aligned/linear dimensions wraps the offset dimension line and label', () => {
    const dimItem: DrawingItem = {
      id: id('dim-1'),
      ownerId: id('view-1'),
      kind: 'drawing_item',
      shape: 'dimension',
      points: [{ x: 0, y: 100 }, { x: 80, y: 100 }],
      dim: { kind: 'aligned', offsetMm: -12, suffix: ' SERVICE CLR.' },
      version: 0,
      authoredRev: {},
    }
    const stubModel = { elements: {} } as unknown as ModelState
    const box = annotationBox(stubModel, null, dimItem, identity)
    expect(box).not.toBeNull()
    // Dimension line sits at y = 100 - 12 = 88 (since axis = (1,0), normal = (0,1), offset = -12)
    expect(box!.y).toBeLessThan(88)
    expect(box!.y + box!.h).toBeGreaterThan(88)
    expect(box!.x).toBeLessThanOrEqual(0)
    expect(box!.x + box!.w).toBeGreaterThanOrEqual(80)
  })

  test('Revit-style drafting: rect & line compile through shapeCommand, polar 90° is on by default, and P-line snaps to graphics & close-loop', () => {
    expect(DEFAULT_DRAFT_SETTINGS.polarDeg).toBe(90)
    const rectCmd = shapeCommand({
      tool: 'rect',
      paper: [{ x: 10, y: 20 }, { x: 60, y: 45 }],
      settings: DEFAULT_DRAFT_SETTINGS,
      toStored: identity,
      storedPerPaperMm: 1,
      ownerId: 'view-1',
      itemId: 'rect-1',
    })
    expect(typeof rectCmd).toBe('object')
    if (typeof rectCmd === 'object' && rectCmd.type === 'batch_documents') {
      expect(rectCmd.commands).toHaveLength(4)
    }

    const lineCmd = shapeCommand({
      tool: 'line',
      paper: [{ x: 0, y: 0 }, { x: 50, y: 0 }],
      settings: DEFAULT_DRAFT_SETTINGS,
      toStored: identity,
      storedPerPaperMm: 1,
      ownerId: 'view-1',
      itemId: 'line-1',
    })
    expect(typeof lineCmd).toBe('object')
    if (typeof lineCmd === 'object' && lineCmd.type === 'add_drawing_item') {
      expect(lineCmd.shape).toBe('line')
    }

    // P-line snaps back to start corner to close loop
    const closeSnap = constrainPoint({
      at: { x: 1.2, y: 0.8 },
      from: { x: 0, y: 40 },
      items: [],
      toPaper: identity,
      settings: DEFAULT_DRAFT_SETTINGS,
      reachMm: 3,
      chainPoints: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }],
      allowCloseLoop: true,
    })
    expect(closeSnap.closeLoop).toBe(true)
    expect(closeSnap.snapLabel).toBe('close loop')
    expect(closeSnap.at).toEqual({ x: 0, y: 0 })

    // P-line snaps to rendered model graphics (wall corners/intersections)
    const wallSnap = constrainPoint({
      at: { x: 100.8, y: 50.6 },
      from: { x: 0, y: 50 },
      items: [],
      toPaper: identity,
      settings: DEFAULT_DRAFT_SETTINGS,
      reachMm: 3,
      graphicsIndex: {
        points: [{ at: { x: 100, y: 50 }, label: 'wall corner', kind: 'corner' }],
        segments: [],
      },
    })
    expect(wallSnap.at).toEqual({ x: 100, y: 50 })
    expect(wallSnap.snapLabel).toBe('wall corner')
  })

  test('detail CAD endpoint snap wins over detail-item anchor label, and polar 90° does not hard-lock diagonals', () => {
    const existing = lineItem('ln-1', 0, 0, 50, 0)
    const endSnap = constrainPoint({
      at: { x: 50.8, y: 0.6 },
      from: null,
      items: [existing],
      toPaper: identity,
      settings: DEFAULT_DRAFT_SETTINGS,
      reachMm: 3,
      anchors: [{ at: { x: 50, y: 0 }, label: 'line corner', ref: { elementId: 'ln-1', anchor: 'end' } }],
    })
    expect(endSnap.snapLabel).toBe('endpoint')
    expect(endSnap.at).toEqual({ x: 50, y: 0 })

    // 28° diagonal stays diagonal under default polarDeg: 90 (4° magnetic tolerance, not 45° ortho lock)
    const diag = constrainPoint({
      at: { x: 228, y: 122 },
      from: { x: 0, y: 0 },
      items: [],
      toPaper: identity,
      settings: DEFAULT_DRAFT_SETTINGS,
      reachMm: 3,
    })
    expect(diag.tracking).toBeNull()
    expect(diag.at).toEqual({ x: 228, y: 122 })

    // Within 2° of horizontal still tracks cleanly at 0°
    const nearHoriz = constrainPoint({
      at: { x: 100, y: 2 },
      from: { x: 0, y: 0 },
      items: [],
      toPaper: identity,
      settings: DEFAULT_DRAFT_SETTINGS,
      reachMm: 3,
    })
    expect(nearHoriz.tracking?.angleDeg).toBe(0)
    expect(nearHoriz.at.y).toBeCloseTo(0, 3)

    // Explicit ortho: true still locks 28° to 0°
    const orthoSnap = constrainPoint({
      at: { x: 228, y: 122 },
      from: { x: 0, y: 0 },
      items: [],
      toPaper: identity,
      settings: { ...DEFAULT_DRAFT_SETTINGS, ortho: true },
      reachMm: 3,
    })
    expect(orthoSnap.tracking?.angleDeg).toBe(0)
    expect(orthoSnap.at.y).toBeCloseTo(0, 3)
  })
})
