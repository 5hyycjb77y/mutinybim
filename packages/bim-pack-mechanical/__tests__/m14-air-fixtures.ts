import { DEFAULT_SETTINGS, asElementId, builtinPartType, executeCommand, type Command, type ModelState, type RunSize, type ViewElement } from "@permitzip/bim-kernel";
import { PackSet } from "@permitzip/bim-kernel/packs";

export const FT = 304.8;
export const IN = 25.4;
const TRUNK: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
const BRANCH: RunSize = { shape: "round", diameter: 8 * IN };
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

function commit(m: ModelState, command: Command): ModelState {
  const r = executeCommand(m, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

/** RTU-1 → 14x10 trunk → SD-1; a tap off the trunk → 8" branch → SD-2. */
export function airModel(): ModelState {
  const rtu = builtinPartType("builtin:rtu-5-ton@1");
  const sd = builtinPartType("builtin:supply-diffuser-24@1");
  if (!rtu || !sd) throw new Error("starter library");
  let m: ModelState = { modelId: "m14-air", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "rtu", typeId: rtu.id, partType: rtu.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd-a", typeId: sd.id, partType: sd.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  m = commit(m, { type: "place_part", partId: "sd-b", typeId: sd.id, levelId: "lvl-1", position: { x: 10 * FT, y: 6 * FT }, offsetMm: 8 * FT, mark: "SD-2" });
  m = commit(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
  return commit(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
}

/** A live diagram view of `kind` held in the model as the view schema stores it. */
export function diagramView(id: string, kind: string, name: string): ViewElement {
  return { id: asElementId(id), kind: "view", version: 1, authoredRev: {}, name, viewType: "detail", cropMin: { x: 0, y: 0 }, cropMax: { x: 1, y: 1 }, props: { diagram: { kind } } };
}

export function withView(m: ModelState, view: ViewElement): ModelState {
  return { ...m, elements: { ...m.elements, [view.id]: view } };
}

/** The first-party set: Mechanical contributes the air schematic rows. */
export function airSchematicSet(): PackSet {
  return PackSet.create([]);
}
