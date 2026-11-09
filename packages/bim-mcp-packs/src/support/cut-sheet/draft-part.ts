import {
  partDefinition,
  rectangleOnPlanes,
  type Dim,
  type ParamDef,
  type ParamValue,
  type PartConnector,
  type PartDefinitionFields,
  type PartTypeDefinition,
  type ReferencePlane,
  type Sketch,
} from "@permitzip/bim-kernel"
import type { CutSheetFacts, CutSheetKind, Fact, Opening, PipeConnection, PipeRole } from "./extract"

/**
 * A first part definition from a cut sheet's facts: the sheet's sizes become
 * parameters (one sizes row named after the model), the body is a plain
 * solid between reference planes on those parameters, and every duct, pipe
 * and power connection the sheet lists becomes a connector. Anything the
 * sheet doesn't print is a stated assumption, never a silent number.
 *
 * This is a starting point for an agent or a person to review: the result
 * goes through bim_check_part_definition and is saved only after approval.
 * The recipes are our own generic boxes and cylinders (MODELING-PATENTS.md
 * rule 7): no flexible-duct connectors, no fan-coil steps.
 */

const IN = 25.4

export interface DraftedPart {
  readonly kind: CutSheetKind
  readonly partName: string
  readonly definition: PartDefinitionFields
  /** Values the sheet didn't give, with what was used instead. */
  readonly assumptions: readonly string[]
  /** What the sheet gave, by parameter, with where it came from (page and line). */
  readonly sources: Readonly<Record<string, { page: number; line: string }>>
}

export class CutSheetDraftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CutSheetDraftError"
  }
}

/** Collects parameter values from facts (with their sources) or stated defaults. */
class Values {
  readonly typeParams: ParamDef[] = []
  readonly values: Record<string, ParamValue> = {}
  readonly sources: Record<string, { page: number; line: string }> = {}
  readonly assumptions: string[] = []

  length(name: string, label: string, fact: Fact<number> | null | undefined, fallbackIn: number | null, why?: string, min = 1): boolean {
    const value = fact?.value ?? (fallbackIn === null ? null : fallbackIn * IN)
    if (value === null) return false
    this.typeParams.push({ name, label, kind: "length", unit: "mm", min })
    this.values[name] = value
    if (fact) this.sources[name] = fact.source
    else this.assumptions.push(`${label}: not on the sheet; used ${fallbackIn}"${why ? ` (${why})` : ""}`)
    return true
  }

  number(name: string, label: string, unit: ParamDef["unit"], fact: Fact<number> | null | undefined): boolean {
    if (!fact) return false
    this.typeParams.push({ name, label, kind: "number", ...(unit ? { unit } : {}), min: 0 })
    this.values[name] = fact.value
    this.sources[name] = fact.source
    return true
  }

  text(name: string, label: string, fact: Fact<string> | null | undefined, fallback: string): void {
    this.typeParams.push({ name, label, kind: "text" })
    this.values[name] = fact?.value ?? fallback
    if (fact) this.sources[name] = fact.source
  }

  has(name: string): boolean {
    return name in this.values
  }
}

function slugModel(model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40)
  return /^[a-z]/.test(slug) ? slug : `part_${slug || "cut_sheet"}`
}

const SIDE_PLANES = (lengthParam: string, widthParam: string): ReferencePlane[] => [
  { id: "front", name: "Front", axis: "x", offset: { param: lengthParam, scale: 0.5 } },
  { id: "back", name: "Back", axis: "x", offset: { param: lengthParam, scale: -0.5 } },
  { id: "left", name: "Left", axis: "y", offset: { param: widthParam, scale: 0.5 } },
  { id: "right", name: "Right", axis: "y", offset: { param: widthParam, scale: -0.5 } },
]

/** x of an opening's centre, from where the sheet says it is ("18 in from the back"), or a stated default. */
function openingX(v: Values, o: Opening | undefined, name: string, label: string, fallback: "front" | "back"): Dim {
  const edge = o?.fromEdge
  if (edge && (edge.edge === "front" || edge.edge === "back")) {
    v.typeParams.push({ name, label: `${label} from ${edge.edge}`, kind: "length", unit: "mm", min: 0 })
    v.values[name] = edge.mm
    v.sources[name] = o.source
    return { formula: edge.edge === "back" ? `${name} - length / 2` : `length / 2 - ${name}` }
  }
  v.assumptions.push(`${label}: the sheet doesn't say where it is; centred a quarter of the length in from the ${fallback}`)
  return { param: "length", scale: fallback === "back" ? -0.25 : 0.25 }
}

function opening(facts: CutSheetFacts, role: Opening["role"]): Opening | undefined {
  return facts.openings.find((o) => o.role === role)
}

function pipe(facts: CutSheetFacts, role: PipeRole): PipeConnection | undefined {
  return facts.pipes.find((p) => p.role === role)
}

function electricalParams(v: Values, facts: CutSheetFacts): void {
  const e = facts.electrical
  v.number("voltage", "Voltage", "v", e.voltage)
  v.number("phase", "Phase", "count", e.phase)
  v.number("mca", "Minimum circuit ampacity (MCA)", "a", e.mca)
  v.number("mop", "Maximum overcurrent protection (MOP)", "a", e.mop)
  v.number("fla", "Full load amps (FLA)", "a", e.fla)
  v.number("heater_kw", "Heating elements", "kw", e.kw)
}

function powerConnector(v: Values, position: [Dim, Dim, Dim], direction: [number, number, number]): PartConnector | null {
  if (!v.has("voltage")) return null
  const phase = v.values.phase
  return {
    id: "power",
    label: "Power",
    domain: "electrical",
    systemKind: "power",
    position,
    direction,
    shape: "none",
    voltage: { param: "voltage" },
    poles: phase === 3 ? 3 : phase === 1 && typeof v.values.voltage === "number" && v.values.voltage <= 120 ? 1 : 2,
    flowDirection: "in",
  }
}

function pipeConnector(v: Values, p: PipeConnection | undefined, id: string, label: string, system: PartConnector["systemKind"], flow: "in" | "out", position: [Dim, Dim, Dim], direction: [number, number, number]): PartConnector | null {
  if (!p) return null
  const param = `${id}_size`
  v.typeParams.push({ name: param, label: `${label} size`, kind: "length", unit: "mm", min: 1 })
  v.values[param] = p.diameterMm
  v.sources[param] = p.source
  return { id, label, domain: "pipe", systemKind: system, position, direction, shape: "round", diameter: { param }, flowDirection: flow }
}

function rooftopUnit(facts: CutSheetFacts, v: Values): Omit<PartDefinitionFields, "typeName" | "typeValues" | "typeParams" | "source"> {
  if (!v.length("length", "Length", facts.lengthMm, null)) throw new CutSheetDraftError("The sheet's overall length wasn't found. Give the dimensions line (e.g. 74\" x 47\" x 42-1/2\") or read the PDF text and write the definition by hand.")
  if (!v.length("width", "Width", facts.widthMm, null)) throw new CutSheetDraftError("The sheet's overall width wasn't found.")
  if (!v.length("height", "Cabinet height", facts.heightMm, null)) throw new CutSheetDraftError("The sheet's overall height wasn't found.")
  v.length("curb_height", "Curb height", facts.curbHeightMm, 14, "a common roof curb", 0)
  v.length("curb_wall", "Curb wall", null, 2, "typical curb rail")
  const supply = opening(facts, "supply")
  const ret = opening(facts, "return")
  v.length("supply_width", "Supply opening width", supply?.widthMm !== undefined ? { value: supply.widthMm, source: supply.source } : null, 24, "no supply opening size on the sheet")
  v.length("supply_depth", "Supply opening depth", supply?.depthMm !== undefined ? { value: supply.depthMm, source: supply.source } : null, 14, "no supply opening size on the sheet")
  v.length("return_width", "Return opening width", ret?.widthMm !== undefined ? { value: ret.widthMm, source: ret.source } : null, 24, "no return opening size on the sheet")
  v.length("return_depth", "Return opening depth", ret?.depthMm !== undefined ? { value: ret.depthMm, source: ret.source } : null, 14, "no return opening size on the sheet")
  const supplyX = openingX(v, supply, "supply_from_edge", "Supply opening", "back")
  const returnX = openingX(v, ret, "return_from_edge", "Return opening", "front")
  v.number("cooling", "Nominal cooling", "tons", facts.coolingTons)
  v.number("airflow", "Rated airflow", "cfm", facts.airflowCfm)
  v.number("heating_btuh", "Heating input", "btuh", facts.heatingBtuh)
  electricalParams(v, facts)
  v.number("weight", "Operating weight", "lb", facts.weightLb)

  const footprint = rectangleOnPlanes("footprint", "Footprint", "base", { minU: "back", maxU: "front", minV: "right", maxV: "left" }, { u0: -900, v0: -600, u1: 900, v1: 600 })
  const outer = rectangleOnPlanes("curb", "Curb", "base", { minU: "back", maxU: "front", minV: "right", maxV: "left" }, { u0: -900, v0: -600, u1: 900, v1: 600 })
  const inner = rectangleOnPlanes("curb_in", "Curb opening", "base", { minU: "curb_back", maxU: "curb_front", minV: "curb_right", maxV: "curb_left" }, { u0: -850, v0: -550, u1: 850, v1: 550 })
  const curb: Sketch = { ...outer, points: [...outer.points, ...inner.points], entities: [...outer.entities, ...inner.entities], constraints: [...outer.constraints, ...inner.constraints] }
  const flow = v.has("airflow") ? { flow: { param: "airflow" } as Dim } : {}
  const connectors: PartConnector[] = [
    { id: "supply", label: "Supply air", domain: "duct", systemKind: "supply_air", position: [supplyX, 0, 0], direction: [0, 0, -1], shape: "rect", width: { param: "supply_width" }, height: { param: "supply_depth" }, widthAxis: [0, 1, 0], flowDirection: "out", ...flow },
    { id: "return", label: "Return air", domain: "duct", systemKind: "return_air", position: [returnX, 0, 0], direction: [0, 0, -1], shape: "rect", width: { param: "return_width" }, height: { param: "return_depth" }, widthAxis: [0, 1, 0], flowDirection: "in", ...flow },
  ]
  const power = powerConnector(v, [{ param: "length", scale: -0.5 }, { param: "width", scale: -0.25 }, { formula: "curb_height + height / 2" }], [-1, 0, 0])
  if (power) connectors.push(power)
  const gas = pipeConnector(v, pipe(facts, "gas"), "gas", "Gas", "natural_gas", "in", [{ param: "length", scale: -0.5 }, { param: "width", scale: 0.25 }, { formula: "curb_height + 6in" }], [-1, 0, 0])
  if (gas) connectors.push(gas)
  const condensate = pipeConnector(v, pipe(facts, "condensate"), "condensate", "Condensate drain", "condensate", "out", [{ param: "length", scale: 0.5 }, 0, { formula: "curb_height + 2in" }], [1, 0, 0])
  if (condensate) connectors.push(condensate)
  return {
    category: "mechanical_equipment",
    description: facts.description?.value ?? "Packaged rooftop unit on a roof curb",
    instanceParams: [{ name: "serves", label: "Serves", kind: "text" }],
    connectors,
    geometry: [],
    symbol: [{ kind: "text", at: [0, 0], text: "RTU", heightMm: 150 }],
    tagFields: ["mark", ...(v.has("cooling") ? ["cooling"] : [])],
    model: {
      id: "cut_sheet",
      planDisplay: "both",
      referencePlanes: [
        ...SIDE_PLANES("length", "width"),
        { id: "curb_top", name: "Curb top", axis: "z", offset: { param: "curb_height" } },
        { id: "unit_top", name: "Unit top", axis: "z", offset: { formula: "curb_height + height" } },
        { id: "curb_front", name: "Curb inside front", axis: "x", offset: { formula: "length / 2 - curb_wall" } },
        { id: "curb_back", name: "Curb inside back", axis: "x", offset: { formula: "-length / 2 + curb_wall" } },
        { id: "curb_left", name: "Curb inside left", axis: "y", offset: { formula: "width / 2 - curb_wall" } },
        { id: "curb_right", name: "Curb inside right", axis: "y", offset: { formula: "-width / 2 + curb_wall" } },
      ],
      sketches: [footprint, curb],
      features: [
        { kind: "extrude", id: "cabinet", name: "Cabinet", operation: "join", sketch: "footprint", start: { param: "curb_height" }, end: { formula: "curb_height + height" }, material: "Galvanized steel" },
        { kind: "extrude", id: "curb_ring", name: "Roof curb", operation: "join", sketch: "curb", start: 0, end: { param: "curb_height" } },
      ],
      types: [],
    },
  }
}

function airTerminal(facts: CutSheetFacts, v: Values): Omit<PartDefinitionFields, "typeName" | "typeValues" | "typeParams" | "source"> {
  const faceFact = facts.faceSizeMm ?? facts.lengthMm
  if (!v.length("face_size", "Face size", faceFact, null)) throw new CutSheetDraftError("The sheet's face size wasn't found (e.g. Face size: 24\" x 24\").")
  const neck = opening(facts, "neck")
  if (!v.length("neck_diameter", "Neck diameter", neck?.diameterMm !== undefined ? { value: neck.diameterMm, source: neck.source } : null, null)) throw new CutSheetDraftError("The sheet's neck (inlet) size wasn't found (e.g. Neck size: 10\" round).")
  v.length("overall_height", "Overall height", facts.heightMm, 6, "typical plaque diffuser")
  v.length("face_thickness", "Face thickness", null, 1.5, "the face plate and its border")
  v.number("rated_airflow", "Rated airflow", "cfm", facts.airflowCfm)
  v.number("weight", "Weight", "lb", facts.weightLb)
  const system = /\breturn\b/i.test(facts.kind?.source.line ?? "") ? "return_air" : /\bexhaust\b/i.test(facts.kind?.source.line ?? "") ? "exhaust_air" : "supply_air"
  const face = rectangleOnPlanes("face", "Face", "base", { minU: "back", maxU: "front", minV: "right", maxV: "left" }, { u0: -300, v0: -300, u1: 300, v1: 300 })
  const neckSketch: Sketch = {
    id: "neck",
    name: "Neck",
    plane: "neck_bottom",
    points: [{ id: "neck_c", u: 0, v: 0 }],
    entities: [{ kind: "circle", id: "neck_circle", center: "neck_c", radius: { param: "neck_diameter", scale: 0.5 } }],
    constraints: [{ kind: "fix", point: "neck_c", u: 0, v: 0 }],
  }
  const airflowDefault = typeof v.values.rated_airflow === "number" ? v.values.rated_airflow : 0
  return {
    category: "air_terminal",
    description: facts.description?.value ?? "Square ceiling air terminal with a round neck",
    instanceParams: [
      { name: "airflow", label: "Airflow", kind: "number", unit: "cfm", min: 0, default: airflowDefault },
      { name: "room", label: "Room", kind: "text" },
    ],
    connectors: [{ id: "neck", label: "Neck", domain: "duct", systemKind: system, position: [0, 0, { param: "overall_height" }], direction: [0, 0, 1], shape: "round", diameter: { param: "neck_diameter" }, flow: { param: "airflow" }, flowDirection: "in" }],
    geometry: [],
    symbol: [
      { kind: "rect", center: [0, 0], size: [{ param: "face_size" }, { param: "face_size" }] },
      { kind: "line", from: [{ param: "face_size", scale: -0.5 }, { param: "face_size", scale: -0.5 }], to: [{ param: "face_size", scale: 0.5 }, { param: "face_size", scale: 0.5 }] },
      { kind: "line", from: [{ param: "face_size", scale: -0.5 }, { param: "face_size", scale: 0.5 }], to: [{ param: "face_size", scale: 0.5 }, { param: "face_size", scale: -0.5 }] },
    ],
    tagFields: ["mark", "airflow"],
    model: {
      id: "cut_sheet",
      planDisplay: "symbol",
      referencePlanes: [...SIDE_PLANES("face_size", "face_size"), { id: "neck_bottom", name: "Face top", axis: "z", offset: { param: "face_thickness" } }, { id: "neck_top", name: "Neck top", axis: "z", offset: { param: "overall_height" } }],
      sketches: [face, neckSketch],
      features: [
        { kind: "extrude", id: "face_plate", name: "Face", operation: "join", sketch: "face", start: 0, end: { param: "face_thickness" } },
        { kind: "extrude", id: "neck_body", name: "Neck", operation: "join", sketch: "neck", start: 0, end: { formula: "overall_height - face_thickness" } },
      ],
      types: [],
    },
  }
}

function waterHeater(facts: CutSheetFacts, v: Values): Omit<PartDefinitionFields, "typeName" | "typeValues" | "typeParams" | "source"> {
  if (!v.length("diameter", "Diameter", facts.diameterMm ?? facts.widthMm, null)) throw new CutSheetDraftError("The sheet's jacket diameter wasn't found (e.g. Jacket diameter: 24\").")
  if (!v.length("height", "Overall height", facts.heightMm, null)) throw new CutSheetDraftError("The sheet's overall height wasn't found.")
  v.number("storage_gal", "Storage (gallons)", "none", facts.storageGallons)
  v.number("recovery_gph", "Recovery (gallons per hour)", "none", facts.recoveryGph)
  v.number("heating_btuh", "Heating input", "btuh", facts.heatingBtuh)
  electricalParams(v, facts)
  v.number("weight", "Weight", "lb", facts.weightLb)
  const body: Sketch = {
    id: "body",
    name: "Jacket",
    plane: "base",
    points: [{ id: "body_c", u: 0, v: 0 }],
    entities: [{ kind: "circle", id: "body_circle", center: "body_c", radius: { param: "diameter", scale: 0.5 } }],
    constraints: [{ kind: "fix", point: "body_c", u: 0, v: 0 }],
  }
  const top: Dim = { param: "height" }
  const connectors: PartConnector[] = []
  const cold = pipeConnector(v, pipe(facts, "cold_water"), "cold_water", "Cold water in", "domestic_cold_water", "in", [{ param: "diameter", scale: -0.25 }, 0, top], [0, 0, 1])
  const hot = pipeConnector(v, pipe(facts, "hot_water"), "hot_water", "Hot water out", "domestic_hot_water", "out", [{ param: "diameter", scale: 0.25 }, 0, top], [0, 0, 1])
  const recirc = pipeConnector(v, pipe(facts, "recirculation"), "recirc", "Recirculation", "domestic_hot_water_return", "in", [0, { param: "diameter", scale: -0.5 }, { formula: "height * 0.4" }], [0, -1, 0])
  const relief = pipeConnector(v, pipe(facts, "relief"), "relief", "T&P relief", "other", "out", [0, { param: "diameter", scale: 0.5 }, { formula: "height - 6in" }], [0, 1, 0])
  const gas = pipeConnector(v, pipe(facts, "gas"), "gas", "Gas", "natural_gas", "in", [{ param: "diameter", scale: -0.5 }, 0, 10 * IN], [-1, 0, 0])
  for (const c of [cold, hot, recirc, relief, gas]) if (c) connectors.push(c)
  if (!cold || !hot) v.assumptions.push("The sheet's cold and hot water connection sizes weren't both found; add the missing connector before saving")
  const power = powerConnector(v, [{ param: "diameter", scale: -0.5 }, 0, { formula: "height - 4in" }], [-1, 0, 0])
  if (power) connectors.push(power)
  return {
    category: "plumbing_fixture",
    description: facts.description?.value ?? "Storage water heater",
    instanceParams: [{ name: "serves", label: "Serves", kind: "text" }],
    connectors,
    geometry: [],
    symbol: [{ kind: "circle", center: [0, 0], radius: { param: "diameter", scale: 0.5 } }, { kind: "text", at: [0, 0], text: "WH", heightMm: 100 }],
    tagFields: ["mark", ...(v.has("storage_gal") ? ["storage_gal"] : [])],
    model: {
      id: "cut_sheet",
      planDisplay: "both",
      referencePlanes: [{ id: "top", name: "Top", axis: "z", offset: { param: "height" } }],
      sketches: [body],
      features: [{ kind: "extrude", id: "jacket", name: "Jacket", operation: "join", sketch: "body", start: 0, end: { param: "height" } }],
      types: [],
    },
  }
}

/**
 * Draft a part from cut-sheet facts. `kind` overrides what the sheet looks
 * like; `fileName` and `fileId` are recorded as the definition's source.
 */
export function draftPartFromCutSheet(facts: CutSheetFacts, options: { kind?: CutSheetKind; fileName: string; fileId?: string; partName?: string }): DraftedPart {
  const kind = options.kind ?? facts.kind?.value
  if (!kind) throw new CutSheetDraftError("This doesn't read like a rooftop unit, air terminal or water heater cut sheet. Pass kind, or write the definition by hand from the sheet's text.")
  const v = new Values()
  const manufacturer = facts.manufacturer?.value ?? null
  v.text("manufacturer", "Manufacturer", facts.manufacturer, "Not stated")
  v.text("model_number", "Model", facts.model, "Not stated")
  const body = kind === "rooftop_unit" ? rooftopUnit(facts, v) : kind === "air_terminal" ? airTerminal(facts, v) : waterHeater(facts, v)
  const modelName = facts.model?.value ?? "Size 1"
  const kindName = kind === "rooftop_unit" ? "Rooftop unit" : kind === "air_terminal" ? "Ceiling diffuser" : "Water heater"
  const partName = options.partName ?? `${kindName}${manufacturer ? `, ${manufacturer}` : ""}${facts.model ? ` ${facts.model.value}` : ""}`.slice(0, 200)
  const typeName = modelName.slice(0, 200)
  const model = body.model ? { ...body.model, id: slugModel(`${kindName}_${facts.model?.value ?? "cut_sheet"}`), types: [{ name: typeName, values: { ...v.values } }] } : undefined
  const definition: PartDefinitionFields = {
    ...body,
    typeName,
    typeParams: v.typeParams,
    typeValues: { ...v.values },
    source: { kind: "cut_sheet", fileName: options.fileName, ...(options.fileId ? { fileId: options.fileId } : {}) },
    ...(model ? { model } : {}),
  }
  return { kind, partName, definition, assumptions: v.assumptions, sources: v.sources }
}

/** The drafted definition with its name, as the kernel stores it. */
export function draftedDefinition(d: DraftedPart): PartTypeDefinition {
  return partDefinition(d.partName, d.definition)
}
