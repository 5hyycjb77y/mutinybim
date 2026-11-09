import { Check, Circle, Cloud, Eraser, Hexagon, KeyRound, Minus, MoveHorizontal, PaintBucket, Palette, Puzzle, Rainbow, Repeat, Spline, Square, SquareDashed, SquareRoundCorner, Tag, Tags, Type, Waves, Waypoints } from 'lucide-react'
import { DIMENSION_KINDS, detailComponents, type DimensionKind } from '@permitzip/bim-kernel'
import type { RibbonCommand, RibbonGroup, RibbonTab } from './types'
import type { DrawingTool } from '../views-sheets/DrawingCanvas'
import type { DraftController } from '../views-sheets/draft/useDraftController'
import type { BuildingModelRibbonContext } from '../building-model-ribbon'

/**
 * The Annotate tab: everything drawn on a view or a sheet, in one place.
 * Dimension, Detail (detail lines in every shape, revision clouds), Region,
 * Text, Tag and Symbol (detail components, repeating details, insulation).
 * The drawing aids (snaps, Ortho, polar) sit in the options bar above the
 * drawing; the edit verbs are on Modify. Each command says why it is off.
 */

/** The shapes one Detail line draws; the split button remembers the last one. */
export const DETAIL_SHAPES = ['line', 'rect', 'polygon', 'arc', 'circle', 'polyline', 'spline'] as const satisfies readonly DrawingTool[]
export type DetailShape = (typeof DETAIL_SHAPES)[number]
export function isDetailShape(tool: DrawingTool): tool is DetailShape {
  return (DETAIL_SHAPES as readonly string[]).includes(tool)
}

export const OPEN_A_DRAWING = 'Open a sheet, a plan, a section or a detail view from the Views and sheets panel to annotate it.'

export function drawingReason(ctx: BuildingModelRibbonContext, tool: DrawingTool): string | null {
  if (!ctx.drawingOpen) return OPEN_A_DRAWING
  if (tool !== 'select' && ctx.editBlocked) return ctx.editBlocked
  if (ctx.drawingTools.includes(tool)) return null
  if (tool === 'dimension') return 'Dimensions measure a view. Open a plan, section or detail view, or double-click one on the sheet.'
  if (tool === 'tag') return 'Tags label the model. Open a plan or a section, or double-click one on the sheet.'
  if (tool === 'keynote') return 'Keynotes go on elements in a view. Open a plan or a section, or double-click one on the sheet.'
  if (tool === 'rect') return 'Rectangles are drawn on sheets and in detail views.'
  return 'A 3D view or schedule takes no annotation. Draw on the sheet, or in a plan, section or detail view.'
}

export function drawingCommand(ctx: BuildingModelRibbonContext, tool: DrawingTool, label: string, icon: RibbonCommand['icon'], description: string, keywords: readonly string[]): RibbonCommand {
  return {
    id: `draw-${tool}`,
    label,
    icon,
    description,
    keywords,
    disabledReason: drawingReason(ctx, tool),
    pressed: ctx.drawingOpen !== null && ctx.drawingTool === tool,
    run: () => ctx.setDrawingTool(tool),
    testId: `ribbon-draw-${tool}`,
    // The drawing takes the keyboard once a tool is picked (Enter finishes a chain); Select leaves it where it is.
    ...(tool !== 'select' ? { handsOffKeyboard: true } : {}),
  }
}

const SHAPE: Record<DetailShape, { readonly label: string; readonly icon: RibbonCommand['icon']; readonly description: string; readonly keywords: readonly string[] }> = {
  line: { label: 'Line', icon: Minus, description: 'Drag a detail line; pick its line style in the bar over the drawing', keywords: ['detail line'] },
  rect: { label: 'Rectangle', icon: Square, description: 'Drag a rectangle: four detail lines joined at the corners, so you can fillet, trim or offset them', keywords: ['box', 'joined lines'] },
  arc: { label: 'Arc', icon: Rainbow, description: 'Click the centre, the start and the end', keywords: ['curve'] },
  circle: { label: 'Circle', icon: Circle, description: 'Click the centre and a point on it', keywords: ['round'] },
  polygon: { label: 'Polygon', icon: Hexagon, description: 'Click the centre and a corner: joined detail lines, inscribed or circumscribed, sides typed in the bar', keywords: ['hexagon', 'octagon', 'joined lines'] },
  polyline: { label: 'Lines (chain)', icon: Waypoints, description: 'Click each point: one detail line per segment, joined end to end. Click the first point to close; Enter finishes', keywords: ['chain', 'polyline', 'path', 'joined lines'] },
  spline: { label: 'Spline', icon: Spline, description: 'A smooth curve through the points you click', keywords: ['curve', 'smooth', 'flex'] },
}

/** Detail line ▾: the face draws the last shape used (when it fits here), the arrow lists every shape. */
function detailLine(ctx: BuildingModelRibbonContext): RibbonCommand {
  const last = ctx.lastDetailShape ?? 'line'
  const face: DetailShape = drawingReason(ctx, last) === null ? last : 'line'
  const shapes = DETAIL_SHAPES.map((shape) => drawingCommand(ctx, shape, SHAPE[shape].label, SHAPE[shape].icon, SHAPE[shape].description, SHAPE[shape].keywords))
  return {
    id: 'detail-line',
    label: 'Detail line',
    icon: SHAPE[face].icon,
    description: `Draw a ${SHAPE[face].label.toLowerCase()} on this drawing; the arrow picks another shape (line, rectangle, polygon, arc, circle, chain of lines, spline)`,
    keywords: ['line', 'detail line', 'draw', 'linework', 'shape'],
    disabledReason: drawingReason(ctx, face),
    pressed: ctx.drawingOpen !== null && isDetailShape(ctx.drawingTool),
    run: () => ctx.setDrawingTool(face),
    split: true,
    children: shapes,
    testId: 'ribbon-detail-line',
    handsOffKeyboard: true,
  }
}

const DIM_KIND_LABEL: Record<DimensionKind, string> = { linear: 'Linear (horizontal or vertical)', aligned: 'Aligned', angular: 'Angle', radial: 'Radius', diameter: 'Diameter', arc_length: 'Arc length', spot_elevation: 'Spot elevation', spot_coordinate: 'Spot coordinate' }

/** Dimension kinds: every kind people draw, plus strings of dimensions end to end or from one baseline. */
function dimensionKinds(ctx: BuildingModelRibbonContext, draft: DraftController): RibbonCommand {
  const s = draft.settings
  const reason = drawingReason(ctx, 'dimension')
  const pick = (dimKind: DimensionKind, dimChain: 'single' | 'continuous' | 'baseline') => () => {
    draft.setSettings({ ...s, dimKind, dimChain })
    ctx.setDrawingTool('dimension')
  }
  const on = (k: DimensionKind, c: 'single' | 'continuous' | 'baseline') => ctx.drawingTool === 'dimension' && s.dimKind === k && s.dimChain === c
  return {
    id: 'dimension-kinds',
    label: 'Dimension kinds',
    icon: MoveHorizontal,
    description: `Now: ${DIM_KIND_LABEL[s.dimKind].toLowerCase()}${s.dimChain === 'single' ? '' : `, ${s.dimChain === 'continuous' ? 'end to end' : 'from a baseline'}`}`,
    keywords: ['angular', 'radius', 'diameter', 'arc length', 'spot elevation', 'chain', 'baseline', 'continuous'],
    children: [
      ...DIMENSION_KINDS.map((k) => ({ id: `dimension-kind-${k}`, label: DIM_KIND_LABEL[k], icon: on(k, 'single') ? Check : MoveHorizontal, description: `Draw ${DIM_KIND_LABEL[k].toLowerCase()} dimensions`, disabledReason: reason, pressed: on(k, 'single'), run: pick(k, 'single'), testId: `ribbon-dimension-${k}`, handsOffKeyboard: true })),
      { id: 'dimension-kind-continuous', label: 'String, end to end', icon: on('linear', 'continuous') ? Check : MoveHorizontal, description: 'Click each point; Enter finishes one string of dimensions', disabledReason: reason, pressed: on('linear', 'continuous'), run: pick('linear', 'continuous'), testId: 'ribbon-dimension-continuous', handsOffKeyboard: true },
      { id: 'dimension-kind-baseline', label: 'String, from a baseline', icon: on('linear', 'baseline') ? Check : MoveHorizontal, description: 'Each dimension measured from the first point', disabledReason: reason, pressed: on('linear', 'baseline'), run: pick('linear', 'baseline'), testId: 'ribbon-dimension-baseline', handsOffKeyboard: true },
    ],
    testId: 'ribbon-dimension-kinds',
  }
}

/** Fillet Arc: a draw tool that picks two lines and rounds their corner with the radius typed in the bar. */
function filletArc(ctx: BuildingModelRibbonContext, draft: DraftController): RibbonCommand {
  const on = draft.pending?.kind === 'modify' && draft.pending.op === 'fillet_arc'
  return {
    id: 'draw-fillet-arc',
    label: 'Fillet arc',
    icon: SquareRoundCorner,
    description: 'Click two detail lines: an arc of the radius in the bar rounds their corner and the lines trim to it',
    keywords: ['fillet', 'round corner', 'radius'],
    disabledReason: ctx.drawingOpen ? ctx.editBlocked : OPEN_A_DRAWING,
    pressed: on,
    run: () => {
      ctx.setDrawingTool('select')
      draft.setPending(on ? null : { kind: 'modify', op: 'fillet_arc' })
    },
    testId: 'ribbon-draw-fillet-arc',
    handsOffKeyboard: true,
  }
}

function region(ctx: BuildingModelRibbonContext, draft: DraftController, masking: boolean): RibbonCommand {
  return {
    ...drawingCommand(ctx, 'region', masking ? 'Masking region' : 'Filled region', masking ? Eraser : PaintBucket, masking ? 'A white region that hides linework under it; click its corners' : 'A hatched or solid region; click its corners, Enter closes it', masking ? ['mask', 'wipeout', 'cover'] : ['hatch', 'fill', 'poche']),
    id: masking ? 'draft-masking' : 'draft-region',
    pressed: ctx.drawingTool === 'region' && draft.settings.masking === masking,
    run: () => {
      draft.setSettings({ ...draft.settings, masking })
      ctx.setDrawingTool('region')
    },
    testId: masking ? 'ribbon-draft-masking' : 'ribbon-draft-region',
  }
}

function component(ctx: BuildingModelRibbonContext, draft: DraftController): RibbonCommand {
  const base = drawingCommand(ctx, 'component', 'Component', Puzzle, 'Place a 2D detail component: duct, pipe, hanger, valve, anchor, steel', ['symbol', 'library', 'hanger', 'valve', 'anchor', 'strut'])
  return {
    ...base,
    children: detailComponents().map((c) => ({
      id: `draft-component-${c.id}`,
      label: c.name,
      icon: draft.settings.symbolId === c.id && ctx.drawingTool === 'component' ? Check : Puzzle,
      description: `Place a ${c.name.toLowerCase()}`,
      disabledReason: base.disabledReason,
      run: () => {
        draft.setSettings({ ...draft.settings, symbolId: c.id })
        ctx.setDrawingTool('component')
      },
      testId: `ribbon-component-${c.id}`,
      handsOffKeyboard: true,
    })),
  }
}

export function annotateTab(ctx: BuildingModelRibbonContext, leading: RibbonGroup): RibbonTab {
  const draft = ctx.draft
  const groups: RibbonGroup[] = [
    leading,
    {
      id: 'dimension',
      label: 'Dimension',
      commands: [drawingCommand(ctx, 'dimension', 'Dimension', MoveHorizontal, 'Drag between two points; ends that land on an element follow it', ['measure', 'annotation', 'associative', 'aligned', 'linear']), ...(draft ? [dimensionKinds(ctx, draft)] : [])],
    },
    { id: 'detail', label: 'Detail', commands: [detailLine(ctx), ...(draft ? [filletArc(ctx, draft)] : []), drawingCommand(ctx, 'cloud', 'Revision cloud', Cloud, 'Cloud a change on the sheet', ['revision'])] },
    ...(draft ? [{ id: 'region', label: 'Region', commands: [region(ctx, draft, false), region(ctx, draft, true)] }] : []),
    { id: 'text', label: 'Text', commands: [drawingCommand(ctx, 'text', 'Text', Type, 'Add a note; drag its grips to re-wrap', ['note', 'label', 'leader'])] },
    {
      id: 'tag',
      label: 'Tag',
      commands: [
        drawingCommand(ctx, 'tag', 'Tag', Tag, 'Click an element to tag it with its size, mark or CFM', ['label', 'mark', 'size', 'cfm']),
        drawingCommand(ctx, 'keynote', 'Keynote', KeyRound, 'Pick a keynote (or type a key), then click elements: each gets the key and a keynote tag, and the sheet’s keynote list (Sheets › Live table › Keynote list) shows its words', ['keynote', 'key note', 'note number', 'general note', 'legend']),
        drawingCommand(ctx, 'callout', 'Callout', SquareDashed, 'Drag a box round part of a plan, then pick the enlarged view it refers to: its head shows that view’s number and sheet, and follows it to another sheet', ['enlarged plan', 'view reference', 'detail callout', 'reference bubble']),
        {
          id: 'tag-all',
          label: 'Tag all',
          icon: Tags,
          description: 'Tag every untagged duct, pipe, terminal, fixture and piece of equipment here, each at a clear spot (undo removes them all)',
          keywords: ['auto tag', 'tag all untagged', 'label everything'],
          disabledReason: ctx.tagAll ? ctx.tagAll.disabledReason : 'Open a plan or a section to tag what it shows.',
          run: ctx.tagAll?.run,
          testId: 'ribbon-tag-all',
        },
        {
          id: 'tag-styles',
          label: 'Tag styles',
          icon: Palette,
          description: 'Named tag looks: what a tag says (any field, part parameters too), its size, box and leader, and the default for each kind of element',
          keywords: ['tag type', 'label style', 'tag parameters', 'custom tag', 'insulation tag'],
          disabledReason: null,
          run: ctx.organization.openTagStyles,
          testId: 'ribbon-tag-styles',
        },
      ],
    },
    ...(draft
      ? [
          {
            id: 'symbol',
            label: 'Symbol',
            commands: [
              component(ctx, draft),
              drawingCommand(ctx, 'repeat', 'Repeating detail', Repeat, 'A component repeated along a line (threaded rod, flex duct, brick)', ['repeat', 'array along']),
              drawingCommand(ctx, 'batt', 'Insulation', Waves, 'Batt insulation of a typed thickness between two points', ['batt', 'insulation', 'wrap']),
            ],
          },
        ]
      : []),
  ]
  return { id: 'annotate', label: 'Annotate', groups }
}
