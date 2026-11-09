import {
  allPlanes,
  isPartModel2,
  partDefinition,
  partGroupName,
  resolveDim,
  withPartGroupName,
  type Dim,
  type ParamDef,
  type ParamValue,
  type PartCategory,
  type PartConnector,
  type PartFeature,
  type PartModel,
  type PartTypeDefinition,
  type PlaneAxis,
  type ReferencePlane,
  type Sketch,
  type SketchConstraint,
} from '@permitzip/bim-kernel'

/**
 * The part editor's working copy and the edits its tools make. Pure: every
 * function returns a new definition, so undo is a stack of definitions and the
 * React tree only renders.
 */

export const MM_PER_IN = 25.4

export type EditorView = 'plan' | 'front' | 'side' | '3d'

export interface Draft {
  readonly groupName: string
  readonly definition: PartTypeDefinition
  /** Which row of the types table the views show. */
  readonly typeName: string
}

const EMPTY_MODEL = (id: string): PartModel => ({ id, referencePlanes: [], sketches: [], features: [], planDisplay: 'both', types: [] })

/** A new part: three size parameters, their planes, nothing drawn yet. */
export function blankDraft(groupName = 'New part', category: PartCategory = 'mechanical_equipment'): Draft {
  const id = modelIdFor(groupName)
  const definition = partDefinition(groupName, {
    typeName: 'Standard',
    category,
    typeParams: [
      { name: 'length', label: 'Length', kind: 'length', unit: 'mm', min: 1 },
      { name: 'width', label: 'Width', kind: 'length', unit: 'mm', min: 1 },
      { name: 'height', label: 'Height', kind: 'length', unit: 'mm', min: 1 },
    ],
    typeValues: { length: 36 * MM_PER_IN, width: 24 * MM_PER_IN, height: 24 * MM_PER_IN },
    instanceParams: [],
    connectors: [],
    geometry: [],
    symbol: [],
    tagFields: ['mark'],
    source: { kind: 'builtin', libraryVersion: 'part-editor' },
    model: {
      ...EMPTY_MODEL(id),
      planDisplay: 'model',
      referencePlanes: [
        { id: 'front', name: 'Front', axis: 'x', offset: { param: 'length', scale: 0.5 } },
        { id: 'back', name: 'Back', axis: 'x', offset: { param: 'length', scale: -0.5 } },
        { id: 'left', name: 'Left', axis: 'y', offset: { param: 'width', scale: 0.5 } },
        { id: 'right', name: 'Right', axis: 'y', offset: { param: 'width', scale: -0.5 } },
        { id: 'top', name: 'Top', axis: 'z', offset: { param: 'height' } },
      ],
      types: [{ name: 'Standard', values: { length: 36 * MM_PER_IN, width: 24 * MM_PER_IN, height: 24 * MM_PER_IN } }],
    },
  })
  return { groupName, definition, typeName: 'Standard' }
}

/**
 * The editor draws and edits part-editor models (schema 1). A script's part
 * (solid program 2: sweeps, lofts, patterns) is changed by running its
 * script again; PartsPanel says so instead of opening it here.
 */
export function editorModel(def: PartTypeDefinition): PartModel | undefined {
  const m = def.model
  if (m && isPartModel2(m)) throw new Error(`${partGroupName(def)} is made by a script; change it by running its script again`)
  return m
}

/** Whether the part editor can open a definition (a script's solid can't be edited here yet). */
export function editableInPartEditor(def: PartTypeDefinition): boolean {
  return def.model !== undefined && !isPartModel2(def.model)
}

export function draftFromDefinition(def: PartTypeDefinition): Draft {
  editorModel(def)
  return { groupName: partGroupName(def), definition: def, typeName: def.model?.types[0]?.name ?? def.typeName }
}

/** The definition as saved: the group name applied. */
export function draftDefinition(d: Draft): PartTypeDefinition {
  return withPartGroupName(d.definition, d.groupName)
}

export function modelIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return /^[a-z]/.test(slug) ? slug : `part_${slug || 'new'}`
}

/** The definition sized to one row of its types table (what the views draw). */
export function sizedDefinition(d: Draft): PartTypeDefinition {
  const row = editorModel(d.definition)?.types.find((t) => t.name === d.typeName)
  return row ? { ...d.definition, typeName: row.name, typeValues: { ...d.definition.typeValues, ...row.values } } : d.definition
}

function model(d: Draft): PartModel {
  return editorModel(d.definition) ?? EMPTY_MODEL(modelIdFor(d.groupName))
}

function withModel(d: Draft, next: PartModel): Draft {
  return { ...d, definition: { ...d.definition, model: next } }
}

/** A fresh id with a readable prefix that isn't used yet. */
export function freshId(prefix: string, used: Iterable<string>): string {
  const taken = new Set(used)
  for (let i = 1; ; i++) if (!taken.has(`${prefix}${i}`)) return `${prefix}${i}`
}

function modelIds(m: PartModel): string[] {
  return [...m.referencePlanes.map((p) => p.id), ...m.sketches.map((s) => s.id), ...m.features.map((f) => f.id), 'center_lr', 'center_fb', 'base']
}

export function addReferencePlane(d: Draft, name: string, axis: PlaneAxis, offset: Dim): { draft: Draft; id: string } {
  const m = model(d)
  const id = freshId('plane', modelIds(m))
  return { draft: withModel(d, { ...m, referencePlanes: [...m.referencePlanes, { id, name, axis, offset }] }), id }
}

export function updateReferencePlane(d: Draft, id: string, patch: Partial<Omit<ReferencePlane, 'id'>>): Draft {
  const m = model(d)
  return withModel(d, { ...m, referencePlanes: m.referencePlanes.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
}

export function addSketch(d: Draft, plane: string, name: string): { draft: Draft; id: string } {
  const m = model(d)
  const id = freshId('sketch', modelIds(m))
  return { draft: withModel(d, { ...m, sketches: [...m.sketches, { id, name, plane, points: [], entities: [], constraints: [] }] }), id }
}

export function updateSketch(d: Draft, id: string, change: (s: Sketch) => Sketch): Draft {
  const m = model(d)
  return withModel(d, { ...m, sketches: m.sketches.map((s) => (s.id === id ? change(s) : s)) })
}

/** The sketch coordinate (u or v) a plane square to the sketch fixes; null when parallel. */
export function planeCoordinate(sketchAxis: PlaneAxis, planeAxis: PlaneAxis): 'u' | 'v' | null {
  if (sketchAxis === planeAxis) return null
  const u: PlaneAxis = sketchAxis === 'x' ? 'y' : 'x'
  return planeAxis === u ? 'u' : 'v'
}

export interface PlaneLine {
  readonly id: string
  readonly name: string
  readonly coordinate: 'u' | 'v'
  readonly value: number
}

/** Reference planes square to a sketch plane, resolved for the size shown. */
export function planeLines(d: Draft, sketchAxis: PlaneAxis): PlaneLine[] {
  const def = sizedDefinition(d)
  const out: PlaneLine[] = []
  for (const p of allPlanes(model(d))) {
    const coordinate = planeCoordinate(sketchAxis, p.axis)
    if (!coordinate) continue
    let value: number
    try {
      value = resolveDim(def, {}, p.offset)
    } catch (err) {
      console.error('[part-editor] plane offset unresolved', p.id, err)
      continue
    }
    out.push({ id: p.id, name: p.name, coordinate, value })
  }
  return out
}

/** Snap a drawn coordinate to the nearest reference plane within `tolerance`. */
export function snapTo(lines: readonly PlaneLine[], coordinate: 'u' | 'v', value: number, tolerance: number): PlaneLine | null {
  let best: PlaneLine | null = null
  for (const l of lines) {
    if (l.coordinate !== coordinate) continue
    if (Math.abs(l.value - value) <= tolerance && (!best || Math.abs(l.value - value) < Math.abs(best.value - value))) best = l
  }
  return best
}

/**
 * A rectangle from two drawn corners. Corners that land near a reference plane
 * snap to it and are locked there (on_plane), so the rectangle follows the
 * plane when a size changes.
 */
export function addRectangle(d: Draft, sketchId: string, a: { u: number; v: number }, b: { u: number; v: number }, tolerance: number): Draft {
  const m = model(d)
  const sketch = m.sketches.find((s) => s.id === sketchId)
  const plane = sketch ? allPlanes(m).find((p) => p.id === sketch.plane) : undefined
  if (!sketch || !plane) return d
  const lines = planeLines(d, plane.axis)
  const lo = { u: Math.min(a.u, b.u), v: Math.min(a.v, b.v) }
  const hi = { u: Math.max(a.u, b.u), v: Math.max(a.v, b.v) }
  const snaps = {
    u0: snapTo(lines, 'u', lo.u, tolerance),
    u1: snapTo(lines, 'u', hi.u, tolerance),
    v0: snapTo(lines, 'v', lo.v, tolerance),
    v1: snapTo(lines, 'v', hi.v, tolerance),
  }
  const used = sketch.points.map((p) => p.id).concat(sketch.entities.map((e) => e.id))
  const base = freshId('r', used)
  const id = (k: string) => `${base}${k}`
  const u0 = snaps.u0?.value ?? lo.u
  const u1 = snaps.u1?.value ?? hi.u
  const v0 = snaps.v0?.value ?? lo.v
  const v1 = snaps.v1?.value ?? hi.v
  const constraints: SketchConstraint[] = []
  if (snaps.u0) constraints.push({ kind: 'on_plane', point: id('a'), plane: snaps.u0.id })
  if (snaps.v0) constraints.push({ kind: 'on_plane', point: id('a'), plane: snaps.v0.id })
  if (snaps.u1) constraints.push({ kind: 'on_plane', point: id('c'), plane: snaps.u1.id })
  if (snaps.v1) constraints.push({ kind: 'on_plane', point: id('c'), plane: snaps.v1.id })
  return updateSketch(d, sketchId, (s) => ({
    ...s,
    points: [...s.points, { id: id('a'), u: u0, v: v0 }, { id: id('b'), u: u1, v: v0 }, { id: id('c'), u: u1, v: v1 }, { id: id('d'), u: u0, v: v1 }],
    entities: [...s.entities, { kind: 'rectangle', id: `${base}`, corners: [id('a'), id('b'), id('c'), id('d')] }],
    constraints: [...s.constraints, ...constraints],
  }))
}

/** A circle at a drawn centre; the radius is a dimension (a number or bound to a parameter). */
export function addCircle(d: Draft, sketchId: string, center: { u: number; v: number }, radius: Dim): Draft {
  return updateSketch(d, sketchId, (s) => {
    const base = freshId('c', s.points.map((p) => p.id).concat(s.entities.map((e) => e.id)))
    return {
      ...s,
      points: [...s.points, { id: `${base}o`, u: center.u, v: center.v }],
      entities: [...s.entities, { kind: 'circle', id: base, center: `${base}o`, radius }],
      constraints: [...s.constraints, { kind: 'fix', point: `${base}o`, u: Math.round(center.u * 10) / 10, v: Math.round(center.v * 10) / 10 }],
    }
  })
}

/** A closed polyline through drawn points (the profile closes back to the first). */
export function addPolyline(d: Draft, sketchId: string, points: ReadonlyArray<{ u: number; v: number }>): Draft {
  if (points.length < 3) return d
  return updateSketch(d, sketchId, (s) => {
    const base = freshId('p', s.points.map((p) => p.id).concat(s.entities.map((e) => e.id)))
    const ids = points.map((_, i) => `${base}_${i}`)
    return {
      ...s,
      points: [...s.points, ...points.map((p, i) => ({ id: ids[i] ?? `${base}_${i}`, u: p.u, v: p.v }))],
      entities: [...s.entities, { kind: 'polyline', id: base, points: ids, closed: true }],
    }
  })
}

/** A construction line (revolve axes). */
export function addAxisLine(d: Draft, sketchId: string, a: { u: number; v: number }, b: { u: number; v: number }): { draft: Draft; id: string } {
  let lineId = ''
  const draft = updateSketch(d, sketchId, (s) => {
    const base = freshId('axis', s.points.map((p) => p.id).concat(s.entities.map((e) => e.id)))
    lineId = base
    return {
      ...s,
      points: [...s.points, { id: `${base}a`, u: a.u, v: a.v }, { id: `${base}b`, u: b.u, v: b.v }],
      entities: [...s.entities, { kind: 'line', id: base, a: `${base}a`, b: `${base}b`, construction: true }],
      constraints: [...s.constraints, { kind: 'fix', point: `${base}a` }, { kind: 'fix', point: `${base}b` }],
    }
  })
  return { draft, id: lineId }
}

export function addExtrude(d: Draft, sketch: string, operation: PartFeature['operation'], start: Dim, end: Dim): { draft: Draft; id: string } {
  const m = model(d)
  const id = freshId('extrude', modelIds(m))
  const name = `${operation === 'cut' ? 'Void' : 'Extrusion'} ${m.features.length + 1}`
  return { draft: withModel(d, { ...m, features: [...m.features, { kind: 'extrude', id, name, operation, sketch, start, end }] }), id }
}

export function addRevolve(d: Draft, sketch: string, axis: string, operation: PartFeature['operation']): { draft: Draft; id: string } {
  const m = model(d)
  const id = freshId('revolve', modelIds(m))
  const name = `${operation === 'cut' ? 'Void revolve' : 'Revolve'} ${m.features.length + 1}`
  return { draft: withModel(d, { ...m, features: [...m.features, { kind: 'revolve', id, name, operation, sketch, axis, startAngle: 0, endAngle: 360 }] }), id }
}

export function updateFeature(d: Draft, id: string, change: (f: PartFeature) => PartFeature): Draft {
  const m = model(d)
  return withModel(d, { ...m, features: m.features.map((f) => (f.id === id ? change(f) : f)) })
}

export function removeFeature(d: Draft, id: string): Draft {
  const m = model(d)
  return withModel(d, { ...m, features: m.features.filter((f) => f.id !== id) })
}

/** Remove a sketch and the features drawn from it. */
export function removeSketch(d: Draft, id: string): Draft {
  const m = model(d)
  return withModel(d, { ...m, sketches: m.sketches.filter((s) => s.id !== id), features: m.features.filter((f) => f.sketch !== id) })
}

// ---------------------------------------------------------------- parameters and sizes

export function addParameter(d: Draft, p: ParamDef, value: ParamValue | undefined): Draft {
  const def = d.definition
  const m = model(d)
  const typeParams = [...def.typeParams, p]
  const typeValues = value !== undefined && !p.formula ? { ...def.typeValues, [p.name]: value } : def.typeValues
  const types = value !== undefined && !p.formula ? m.types.map((t) => ({ ...t, values: { ...t.values, [p.name]: value } })) : m.types
  return { ...d, definition: { ...def, typeParams, typeValues, model: { ...m, types } } }
}

export function setTypeValue(d: Draft, typeName: string, name: string, value: ParamValue): Draft {
  const m = model(d)
  if (m.types.length === 0) return { ...d, definition: { ...d.definition, typeValues: { ...d.definition.typeValues, [name]: value } } }
  return withModel(d, { ...m, types: m.types.map((t) => (t.name === typeName ? { ...t, values: { ...t.values, [name]: value } } : t)) })
}

export function addType(d: Draft, name: string, copyFrom: string): Draft {
  const m = model(d)
  const from = m.types.find((t) => t.name === copyFrom)
  return { ...withModel(d, { ...m, types: [...m.types, { name, values: { ...(from?.values ?? d.definition.typeValues) } }] }), typeName: name }
}

export function renameType(d: Draft, from: string, to: string): Draft {
  const m = model(d)
  return { ...withModel(d, { ...m, types: m.types.map((t) => (t.name === from ? { ...t, name: to } : t)) }), typeName: d.typeName === from ? to : d.typeName }
}

export function removeType(d: Draft, name: string): Draft {
  const m = model(d)
  const types = m.types.filter((t) => t.name !== name)
  return { ...withModel(d, { ...m, types }), typeName: d.typeName === name ? (types[0]?.name ?? d.definition.typeName) : d.typeName }
}

// ---------------------------------------------------------------- connectors

export type Face = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

export const FACE_FRAMES: Readonly<Record<Face, { direction: [number, number, number]; widthAxis: [number, number, number] }>> = {
  top: { direction: [0, 0, 1], widthAxis: [0, 1, 0] },
  bottom: { direction: [0, 0, -1], widthAxis: [0, 1, 0] },
  front: { direction: [1, 0, 0], widthAxis: [0, 1, 0] },
  back: { direction: [-1, 0, 0], widthAxis: [0, 1, 0] },
  left: { direction: [0, 1, 0], widthAxis: [1, 0, 0] },
  right: { direction: [0, -1, 0], widthAxis: [1, 0, 0] },
}

export function addConnector(d: Draft, c: Omit<PartConnector, 'id'>): { draft: Draft; id: string } {
  const id = freshId(c.domain, d.definition.connectors.map((x) => x.id))
  return { draft: { ...d, definition: { ...d.definition, connectors: [...d.definition.connectors, { ...c, id }] } }, id }
}

export function updateConnector(d: Draft, id: string, patch: Partial<PartConnector>): Draft {
  return { ...d, definition: { ...d.definition, connectors: d.definition.connectors.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c)) } }
}

/** Set (or, with null, clear) a connector's end type. */
export function setConnectorEndType(d: Draft, id: string, endType: string | null): Draft {
  const connectors = d.definition.connectors.map((c) => {
    if (c.id !== id) return c
    const { endType: _old, ...rest } = c
    return endType === null ? rest : { ...rest, endType }
  })
  return { ...d, definition: { ...d.definition, connectors } }
}

export function removeConnector(d: Draft, id: string): Draft {
  return { ...d, definition: { ...d.definition, connectors: d.definition.connectors.filter((c) => c.id !== id) } }
}

// ---------------------------------------------------------------- starter box

const BOX_SIDES = { minU: 'back', maxU: 'front', minV: 'right', maxV: 'left' } as const

/**
 * The person's "Start with a box": a rectangle on the Base plane locked to the
 * Front, Back, Left and Right planes, extruded from the base to Height. Sides
 * that don't exist yet are added, bound to Length and Width when those
 * parameters exist. One named operation the person picked; nothing guessed.
 */
export function addStarterBox(d: Draft): { draft: Draft; sketchId: string; featureId: string } {
  const has = (n: string) => d.definition.typeParams.some((p) => p.name === n && p.kind === 'length')
  let next = d
  const sides: ReadonlyArray<{ id: string; name: string; axis: PlaneAxis; offset: Dim }> = [
    { id: 'front', name: 'Front', axis: 'x', offset: has('length') ? { param: 'length', scale: 0.5 } : 18 * MM_PER_IN },
    { id: 'back', name: 'Back', axis: 'x', offset: has('length') ? { param: 'length', scale: -0.5 } : -18 * MM_PER_IN },
    { id: 'left', name: 'Left', axis: 'y', offset: has('width') ? { param: 'width', scale: 0.5 } : 12 * MM_PER_IN },
    { id: 'right', name: 'Right', axis: 'y', offset: has('width') ? { param: 'width', scale: -0.5 } : -12 * MM_PER_IN },
  ]
  for (const s of sides) {
    const m = model(next)
    if (!m.referencePlanes.some((p) => p.id === s.id)) next = withModel(next, { ...m, referencePlanes: [...m.referencePlanes, s] })
  }
  const lines = planeLines(next, 'z')
  const at = (id: string) => lines.find((l) => l.id === id)?.value ?? 0
  const m = model(next)
  const sketchId = freshId('sketch', modelIds(m))
  const p = (k: string) => `${sketchId}_${k}`
  const sketch: Sketch = {
    id: sketchId,
    name: 'Box outline on Base',
    plane: 'base',
    points: [
      { id: p('a'), u: at(BOX_SIDES.minU), v: at(BOX_SIDES.minV) },
      { id: p('b'), u: at(BOX_SIDES.maxU), v: at(BOX_SIDES.minV) },
      { id: p('c'), u: at(BOX_SIDES.maxU), v: at(BOX_SIDES.maxV) },
      { id: p('d'), u: at(BOX_SIDES.minU), v: at(BOX_SIDES.maxV) },
    ],
    entities: [{ kind: 'rectangle', id: `${sketchId}_rect`, corners: [p('a'), p('b'), p('c'), p('d')] }],
    constraints: [
      { kind: 'on_plane', point: p('a'), plane: BOX_SIDES.minU },
      { kind: 'on_plane', point: p('a'), plane: BOX_SIDES.minV },
      { kind: 'on_plane', point: p('c'), plane: BOX_SIDES.maxU },
      { kind: 'on_plane', point: p('c'), plane: BOX_SIDES.maxV },
    ],
  }
  next = withModel(next, { ...m, sketches: [...m.sketches, sketch] })
  const ex = addExtrude(next, sketchId, 'join', 0, has('height') ? { param: 'height' } : 24 * MM_PER_IN)
  const featureId = ex.id
  return { draft: updateFeature(ex.draft, featureId, (f) => ({ ...f, name: 'Box' })), sketchId, featureId }
}

// ---------------------------------------------------------------- reference planes in 3D

export interface Plane3D {
  readonly id: string
  readonly name: string
  readonly axis: PlaneAxis
  /** Millimetres from the insertion point along its axis, for the size shown. */
  readonly value: number
  readonly builtin: boolean
}

/** Every reference plane resolved for the size shown (planes whose offset can't be worked out are left out and logged). */
export function planes3d(d: Draft): Plane3D[] {
  const def = sizedDefinition(d)
  const builtin = new Set<string>(BUILTIN_PLANE_IDS)
  const out: Plane3D[] = []
  for (const p of allPlanes(model(d))) {
    try {
      out.push({ id: p.id, name: p.name, axis: p.axis, value: resolveDim(def, {}, p.offset), builtin: builtin.has(p.id) })
    } catch (err) {
      console.error('[part-editor] plane offset unresolved', p.id, err)
    }
  }
  return out
}

const BUILTIN_PLANE_IDS = ['center_lr', 'center_fb', 'base'] as const

// ---------------------------------------------------------------- dimensions between planes

/**
 * A dimension the views draw between reference planes. A pair of planes that
 * sit either side of the centre on one parameter (Front and Back on Length)
 * is one overall dimension; any other plane is dimensioned from the centre
 * (or Base) plane it is measured from.
 */
export interface PlaneDim {
  readonly id: string
  /** One plane (measured from its origin plane) or two (the distance between them). */
  readonly planes: readonly [string] | readonly [string, string]
  readonly names: string
  readonly coordinate: 'u' | 'v'
  readonly from: number
  readonly to: number
  /** The parameter this dimension shows and drives, if any. */
  readonly param: string | null
  /** A formula positions a plane: the dimension reads it but can't be bound or typed here. */
  readonly formula: string | null
}

type Binding = { readonly param: string; readonly scale: number; readonly add: number } | { readonly formula: string } | { readonly fixed: number }

function binding(offset: Dim): Binding {
  if (typeof offset === 'number') return { fixed: offset }
  if ('param' in offset) return { param: offset.param, scale: offset.scale ?? 1, add: offset.add ?? 0 }
  return { formula: offset.formula }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

/** The dimensions a flat view draws for the planes square to `sketchAxis`'s view. */
export function planeDimensions(d: Draft, sketchAxis: PlaneAxis): PlaneDim[] {
  const m = model(d)
  const byId = new Map(m.referencePlanes.map((p) => [p.id, p]))
  const lines = planeLines(d, sketchAxis).filter((l) => byId.has(l.id))
  const used = new Set<string>()
  const out: PlaneDim[] = []
  for (const line of lines) {
    if (used.has(line.id)) continue
    const plane = byId.get(line.id)
    if (!plane) continue
    const b = binding(plane.offset)
    const partner = lines.find((o) => {
      if (o.id === line.id || used.has(o.id) || o.coordinate !== line.coordinate) return false
      const q = byId.get(o.id)
      if (!q) return false
      const c = binding(q.offset)
      if ('param' in b && 'param' in c) return b.param === c.param && near(b.scale, -c.scale) && near(b.add, c.add)
      if ('fixed' in b && 'fixed' in c) return near(b.fixed, -c.fixed)
      return false
    })
    if (partner) {
      used.add(line.id)
      used.add(partner.id)
      const [lo, hi] = line.value <= partner.value ? [line, partner] : [partner, line]
      out.push({
        id: `${lo.id}~${hi.id}`,
        planes: [lo.id, hi.id],
        names: `${lo.name} to ${hi.name}`,
        coordinate: line.coordinate,
        from: lo.value,
        to: hi.value,
        param: 'param' in b && near(Math.abs(b.scale), 0.5) ? b.param : null,
        formula: null,
      })
      continue
    }
    used.add(line.id)
    out.push({
      id: line.id,
      planes: [line.id],
      names: `${originName(plane.axis)} to ${line.name}`,
      coordinate: line.coordinate,
      from: 0,
      to: line.value,
      param: 'param' in b && near(Math.abs(b.scale), 1) && near(b.add, 0) ? b.param : null,
      formula: 'formula' in b ? b.formula : 'param' in b && !(near(Math.abs(b.scale), 1) && near(b.add, 0)) ? dimText(plane.offset) : null,
    })
  }
  return out
}

function originName(axis: PlaneAxis): string {
  return BUILTIN_PLANES_BY_AXIS[axis]
}

const BUILTIN_PLANES_BY_AXIS: Readonly<Record<PlaneAxis, string>> = { x: 'Centre (left/right)', y: 'Centre (front/back)', z: 'Base' }

/** What a dimension measures, in millimetres. */
export function dimLength(dim: PlaneDim): number {
  return Math.abs(dim.to - dim.from)
}

/**
 * Bind a dimension to a length parameter: its planes are re-expressed on the
 * parameter so they move when the parameter changes. The parameter keeps its
 * value; a brand-new parameter should be added with the dimension's length first.
 */
export function bindDimension(d: Draft, dim: PlaneDim, param: string): Draft {
  if (dim.formula) return d
  if (dim.planes.length === 2) {
    const [lo, hi] = dim.planes
    const centre = Math.round(((dim.from + dim.to) / 2) * 1000) / 1000
    const add = Math.abs(centre) < 0.01 ? {} : { add: centre }
    return updateReferencePlane(updateReferencePlane(d, lo, { offset: { param, scale: -0.5, ...add } }), hi, { offset: { param, scale: 0.5, ...add } })
  }
  const [id] = dim.planes
  return updateReferencePlane(d, id, { offset: dim.to < 0 ? { param, scale: -1 } : { param } })
}

/** Unbind: the planes stay where they are, as fixed distances. */
export function unbindDimension(d: Draft, dim: PlaneDim): Draft {
  if (dim.planes.length === 2) {
    const [lo, hi] = dim.planes
    return updateReferencePlane(updateReferencePlane(d, lo, { offset: round3(dim.from) }), hi, { offset: round3(dim.to) })
  }
  return updateReferencePlane(d, dim.planes[0], { offset: round3(dim.to) })
}

/**
 * Type a new length for a dimension. Bound: the parameter's value changes for
 * the size shown (so the planes and everything locked to them move). Not
 * bound: the planes move, a pair staying centred where it was.
 */
export function setDimensionLength(d: Draft, dim: PlaneDim, mm: number): Draft {
  if (dim.formula || !(mm > 0)) return d
  if (dim.param) return setTypeValue(d, d.typeName, dim.param, round3(mm))
  if (dim.planes.length === 2) {
    const centre = (dim.from + dim.to) / 2
    const [lo, hi] = dim.planes
    return updateReferencePlane(updateReferencePlane(d, lo, { offset: round3(centre - mm / 2) }), hi, { offset: round3(centre + mm / 2) })
  }
  return updateReferencePlane(d, dim.planes[0], { offset: round3(dim.to < 0 ? -mm : mm) })
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** A parameter name from what a person typed ("Curb height" → curb_height), or null if it can't be one. */
export function paramKey(label: string): string | null {
  const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[a-z][a-z0-9_]{0,47}$/.test(key) ? key : null
}

// ---------------------------------------------------------------- dimension text

/** How a dimension reads in a field: inches for numbers, the parameter's name, or the formula. */
export function dimText(d: Dim): string {
  if (typeof d === 'number') return String(Math.round((d / MM_PER_IN) * 1000) / 1000)
  if ('param' in d) return `${d.scale !== undefined && d.scale !== 1 ? `${d.scale} × ` : ''}${d.param}${d.add ? ` + ${Math.round((d.add / MM_PER_IN) * 1000) / 1000} in` : ''}`
  return d.formula
}
