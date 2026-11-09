import { asElementId, DEFAULT_SETTINGS, planCommit, type BimElement, type Command, type ModelState, type ParamDef, type PartTypeDefinition } from "../src";

/**
 * A small building for the drainage checks: a basement 10 ft below Level 1, a
 * second floor, and part types for a sewer connection (manhole / public sewer
 * tie-in), a sewage pump and a backwater valve that carry the drainage values
 * as instance parameters. The tests own every number they hand-check.
 */

export const FT = 304.8;
const NOW = "2026-10-27T00:00:00.000Z";

const len = (name: string, label: string): ParamDef => ({ name, label, kind: "length" });
const num = (name: string, label: string, unit: ParamDef["unit"] = "none"): ParamDef => ({ name, label, kind: "number", unit, min: 0 });
const role = (value: string): Pick<PartTypeDefinition, "typeParams" | "typeValues"> => ({
  typeParams: [{ name: "drainage_role", label: "Drainage role", kind: "choice", choices: ["sewer_connection", "sewage_pump", "backwater_valve"] }],
  typeValues: { drainage_role: value },
});
const shape: Pick<PartTypeDefinition, "geometry" | "symbol" | "connectors" | "source" | "tagFields"> = {
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

export const SEWER_CONNECTION: PartTypeDefinition = {
  familyName: "Sanitary manhole",
  typeName: "Existing, public sewer",
  category: "pipe_accessory",
  ...role("sewer_connection"),
  instanceParams: [
    len("sewer_invert", "Sewer invert"),
    len("sewer_rim", "Upstream manhole cover"),
    { name: "elevation_confidence", label: "Elevations are", kind: "choice", choices: ["verified", "assumed", "field_verify"] },
    num("building_drain_size_in", "Building drain size (in)"),
    num("building_drain_slope_in_per_ft", "Building drain slope (in/ft)"),
    len("building_drain_length", "Building drain length"),
    len("drain_depth_below_floor", "Drain depth below a floor"),
  ],
  ...shape,
};

export const SEWAGE_PUMP: PartTypeDefinition = {
  familyName: "Sewage ejector",
  typeName: "Duplex grinder",
  category: "pipe_accessory",
  ...role("sewage_pump"),
  instanceParams: [num("pump_rated_gpm", "Rated flow", "gpm"), num("pump_rated_head_ft", "Rated head (ft)"), num("pump_inflow_gpm", "Design inflow", "gpm"), num("pump_head_ft", "Total head (ft)"), { name: "backwater_valve", label: "Backwater valve", kind: "boolean" }],
  ...shape,
};

export const BACKWATER_VALVE: PartTypeDefinition = { familyName: "Backwater valve", typeName: "4 in.", category: "pipe_accessory", ...role("backwater_valve"), instanceParams: [], ...shape };

let seq = 0;

export class DrainageBuilding {
  head: ModelState = { modelId: "drainage-test", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  private placedTypes = new Set<string>();

  constructor() {
    this.ok({ type: "create_level", levelId: "lvl-b", name: "Basement", elevationMm: -10 * FT });
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    this.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT });
  }

  ok(command: Command): ModelState {
    seq += 1;
    const d = planCommit(this.head, [], { idempotencyKey: `drainage-fixture-${seq}-key`, baseRevision: this.head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command }, () => NOW);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    this.head = d.model;
    return this.head;
  }

  try(command: Command): string | null {
    seq += 1;
    const d = planCommit(this.head, [], { idempotencyKey: `drainage-fixture-${seq}-key`, baseRevision: this.head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command }, () => NOW);
    if (!d.ok) return d.error.message;
    this.head = d.model;
    return null;
  }

  private place(id: string, typeKey: string, def: PartTypeDefinition, values: Record<string, number | string | boolean>, mark: string, levelId = "lvl-b", x = 0): void {
    const typeId = `type-${typeKey}`;
    const first = !this.placedTypes.has(typeId);
    this.placedTypes.add(typeId);
    this.ok({ type: "place_part", partId: id, typeId, ...(first ? { partType: def } : {}), levelId, position: { x, y: 0 }, mark, values });
  }

  /** The existing manhole the building drain discharges into; elevations in feet above Level 1. */
  manhole(values: { invertFt?: number; rimFt?: number; confidence?: "verified" | "assumed" | "field_verify"; sizeIn?: number; slope?: number; lengthFt?: number } = {}, id = "mh-1", mark = "MH-1"): void {
    const v: Record<string, number | string> = {};
    if (values.invertFt !== undefined) v.sewer_invert = values.invertFt * FT;
    if (values.rimFt !== undefined) v.sewer_rim = values.rimFt * FT;
    if (values.confidence !== undefined) v.elevation_confidence = values.confidence;
    if (values.sizeIn !== undefined) v.building_drain_size_in = values.sizeIn;
    if (values.slope !== undefined) v.building_drain_slope_in_per_ft = values.slope;
    if (values.lengthFt !== undefined) v.building_drain_length = values.lengthFt * FT;
    this.place(id, "manhole", SEWER_CONNECTION, v, mark, "lvl-b", 40 * FT);
  }

  pump(id: string, mark: string, values: Record<string, number | boolean> = {}): void {
    this.place(id, "pump", SEWAGE_PUMP, values, mark, "lvl-b", 20 * FT);
  }

  valve(id: string, mark: string): void {
    this.place(id, "valve", BACKWATER_VALVE, {}, mark, "lvl-b", 10 * FT);
  }

  setValues(partId: string, values: Record<string, number | string | boolean>): void {
    this.ok({ type: "set_parameters", id: partId, scope: "instance", values });
  }

  /** Drainage loads on a floor, `dfu` each, optionally naming a source. */
  drains(prefix: string, levelId: string, count: number, dfu: number, servedBy?: string): string[] {
    const loads = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, anchor: { kind: "point" as const, levelId, position: { x: i * 3 * FT, y: 5 * FT } }, values: { dfu } }));
    this.ok({ type: "create_load", loads });
    const ids = loads.map((l) => l.id);
    if (servedBy) this.nameSource(ids, servedBy);
    return ids;
  }

  /**
   * Names a drainage part as the loads' source (`servedBy`). Written straight into
   * the record: `create_load` / `edit_load_point` refuse a source the plumbing
   * adapter doesn't know (it knows heaters, meters and interceptors), and teaching
   * it sewer connections, pumps and valves is k2's file (patch in
   * an internal design note). The reads under test only see the field.
   */
  nameSource(loadIds: readonly string[], sourceId: string): void {
    const next: Record<string, BimElement> = { ...this.head.elements };
    for (const id of loadIds) {
      const lp = next[id];
      if (lp?.kind !== "load_point") throw new Error(`${id} is not a load`);
      next[id] = { ...lp, servedBy: asElementId(sourceId), version: lp.version + 1 };
    }
    this.head = { ...this.head, elements: next, revision: (this.head.revision + 1) as ModelState["revision"] };
  }

  /** Rows typed in a table with no place yet (7329: 35 fixtures as loads with no pipe). */
  rows(prefix: string, count: number, dfu: number): void {
    this.ok({ type: "create_load", loads: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, values: { dfu } })) });
  }
}
