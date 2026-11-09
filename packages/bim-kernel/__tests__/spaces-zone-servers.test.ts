/**
 * @jest-environment node
 *
 * QA D-5 (Oct 27): a thermal zone's "Equipment serving" picker listed every
 * planned kitchen item. Which equipment fits a zone's purpose is read from the
 * shared connection model: a duct connector, a stated airflow, an airflow
 * load, or an HVAC / heating / cooling load class (how the Equipment list
 * files "RTU-1"). A fryer with 120 V and 80 MBH is electrical and gas only.
 */
import { builtinPartType, DEFAULT_SETTINGS, fitsZonePurpose, hasThermalSide, planCommit, type Command, type ModelState, type PartInstance, type PartTypeDefinition } from "../src";

let seq = 0;
function apply(m: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(m, [], { idempotencyKey: `spaces-zone-servers-${seq}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command });
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

/** The Equipment list's shape: Mechanical equipment, nameplate values, no drawn connectors. */
const LISTED: PartTypeDefinition = {
  familyName: "Equipment, from an equipment list",
  typeName: "Listed item",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [
    { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
    { name: "load_va", label: "Load", kind: "number", unit: "va", min: 0 },
    { name: "load_class", label: "Load class", kind: "text" },
    { name: "input_mbh", label: "Gas input (MBH)", kind: "number", unit: "none", min: 0 },
    { name: "airflow_cfm", label: "Airflow (CFM)", kind: "number", unit: "none", min: 0 },
  ],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 600, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "test" },
};

function model(): ModelState {
  let m: ModelState = { modelId: "spaces-zone-servers", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = apply(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  const plan = (partId: string, mark: string, values: PartInstance["values"]): Command => ({ type: "plan_part", partId, typeId: "type:listed", ...(m.elements["type:listed"] ? {} : { partType: LISTED }), mark, values });
  m = apply(m, plan("rtu-listed", "RTU-1", { voltage: 240, load_va: 12_500, load_class: "hvac" }));
  m = apply(m, plan("fryer", "K-1", { voltage: 120, load_va: 500, load_class: "kitchen", input_mbh: 80 }));
  m = apply(m, plan("mau", "MAU-1", { airflow_cfm: 2400 }));
  m = apply(m, plan("hood", "HOOD-1", {}));
  const rtu = builtinPartType("builtin:rtu-5-ton@2");
  if (!rtu) throw new Error("starter library has no RTU");
  m = apply(m, { type: "place_part", partId: "rtu-drawn", typeId: rtu.id, partType: rtu.definition, levelId: "lvl-1", position: { x: 5000, y: 0 }, mark: "RTU-2" });
  // An airflow load on a part with no air connector of its own.
  m = apply(m, { type: "create_load", loads: [{ id: "load-hood-exhaust", anchor: { kind: "part", partId: "hood" }, mark: "Hood exhaust", service: "exhaust_air", values: { cfm: 1800 } }] });
  return m;
}

function part(m: ModelState, id: string): PartInstance {
  const el = m.elements[id];
  if (el?.kind !== "part") throw new Error(`${id} is not a part`);
  return el;
}

describe("which equipment serves a zone", () => {
  const m = model();

  it("a thermal zone takes parts with an air or heating/cooling side, not a fryer", () => {
    expect(hasThermalSide(m.elements, part(m, "rtu-listed"))).toBe(true); // load class HVAC from the list
    expect(hasThermalSide(m.elements, part(m, "rtu-drawn"))).toBe(true); // duct connectors
    expect(hasThermalSide(m.elements, part(m, "mau"))).toBe(true); // stated airflow
    expect(hasThermalSide(m.elements, part(m, "hood"))).toBe(true); // an airflow load anchored on it
    expect(hasThermalSide(m.elements, part(m, "fryer"))).toBe(false);
    expect(fitsZonePurpose(m.elements, part(m, "fryer"), "thermal")).toBe(false);
    expect(fitsZonePurpose(m.elements, part(m, "fryer"), "ventilation")).toBe(false);
  });

  it("an electrical zone takes anything with an electrical side; a fire area takes everything", () => {
    expect(fitsZonePurpose(m.elements, part(m, "fryer"), "electrical_load_region")).toBe(true);
    expect(fitsZonePurpose(m.elements, part(m, "mau"), "electrical_load_region")).toBe(false);
    expect(fitsZonePurpose(m.elements, part(m, "mau"), "fire_area")).toBe(true);
  });
});
