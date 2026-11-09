/**
 * @jest-environment node
 *
 * M5 (round 15, the product owner's answer 3): vendor data on mechanical equipment as
 * fields with typed units (manufacturer and model, cooling and heating
 * capacity, operating weight, curb size, service clearance, sequence of
 * operation) and the equipment schedule's columns for them, read off G15's
 * rooftop unit starter. Fails on round 14: none of these fields existed, so
 * the RTU's weight and curb never reached a schedule and Properties had no
 * Vendor data group.
 */
import { runInNewContext } from "node:vm";
import { DEFAULT_SETTINGS, evaluateScheduleV2, fieldProviderRegistry, type ModelState, type PartTypeDefinition, type Revision } from "@permitzip/bim-kernel";
import { buildRowSet, validateScheduleDefinition } from "@permitzip/bim-kernel/schedules";
import * as kit from "@permitzip/bim-script";
import { FT, K15Model } from "../../bim-kernel/__tests__/k15-fixtures";
import { MECHANICAL_EQUIPMENT_SCHEDULE } from "../src";

/** The starter's source as the sealed child evaluates it: only the kit in scope. */
function evaluate(source: string): kit.ScriptDefinition {
  const plain = source.replace(/^import \{([^}]*)\} from "@permitzip\/bim-script";$/m, "const {$1} = __kit;").replace(/^export default /m, "__exports.default = ");
  const slot: { default?: kit.ScriptDefinition } = {};
  runInNewContext(plain, { __kit: kit, __exports: slot, Math, Number, String, JSON });
  if (!slot.default) throw new Error("no default export");
  return slot.default;
}

async function rooftopUnit(): Promise<PartTypeDefinition> {
  const item = kit.starterScriptItems().find((i) => i.key === "starter.rooftop_unit");
  if (!item) throw new Error("no rooftop unit starter");
  const definition = evaluate(item.source);
  const head: ModelState = { modelId: "m15-rtu", revision: 1 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const output = await kit.runScript(definition, { slice: kit.sliceModel(head, definition.manifest.reads), values: kit.resolveValues(definition.manifest), scriptHash: item.contentHash ?? "" });
  if (output.kind !== "part_types") throw new Error("expected part types");
  const def = output.types[0]?.definition;
  if (!def) throw new Error("no part");
  return def;
}

async function roof(): Promise<K15Model> {
  const def = await rooftopUnit();
  const m = new K15Model();
  m.ok({ type: "place_part", partId: "rtu-1", typeId: "firm:rtu-10", partType: def, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 20 * FT, mark: "RTU-1" });
  return m;
}

function print(m: K15Model) {
  const def = MECHANICAL_EQUIPMENT_SCHEDULE;
  const ctx = { viewId: "m15", revision: m.head.revision, registry: fieldProviderRegistry() };
  expect(validateScheduleDefinition(m.head, def, ctx)).toEqual([]);
  const out = evaluateScheduleV2(buildRowSet(m.head, def, ctx), def);
  const at = (h: string) => out.headings.indexOf(h);
  const row = out.rows.find((_, i) => out.elementIds[i]?.includes("rtu-1"));
  if (!row) throw new Error(`no RTU row in ${JSON.stringify(out.rows)}`);
  return { headings: out.headings, cell: (h: string) => row[at(h)] };
}

describe("vendor data on mechanical equipment", () => {
  it("each vendor field is typed: weight in pounds, capacity as heating or cooling power, clearance as a length, the rest text, in a Vendor data group", () => {
    const registry = fieldProviderRegistry();
    const typed = (path: string) => {
      const d = registry.describePath("mep.mechanical_equipment", path);
      if (!d.ok) throw new Error(`${path} is not a field of mechanical equipment`);
      return { valueType: d.field.valueType, kind: d.field.kind, unit: d.field.unit, group: d.field.group };
    };
    expect(typed("own.weight")).toEqual({ valueType: "quantity", kind: "mass", unit: "lb", group: "Vendor data" });
    expect(typed("own.cooling_capacity")).toMatchObject({ valueType: "quantity", kind: "thermal_power", unit: "ton_r" });
    expect(typed("own.heating_capacity")).toMatchObject({ valueType: "quantity", kind: "thermal_power", unit: "MBH" });
    expect(typed("vendor.service_clearance")).toMatchObject({ valueType: "quantity", kind: "length" });
    for (const p of ["vendor.manufacturer", "vendor.model", "vendor.curb_size", "vendor.sequence_of_operation"]) expect(typed(p).valueType).toBe("text");
    // Maker and model also describe a diffuser.
    expect(registry.describePath("mep.air_terminal", "vendor.model").ok).toBe(true);
  });

  it("the equipment schedule prints G15's rooftop unit: capacity, supply CFM, volts, weight and curb", async () => {
    const m = await roof();
    const { headings, cell } = print(m);
    expect(headings).toEqual(expect.arrayContaining(["MARK", "COOLING", "SUPPLY CFM", "OPER. WEIGHT", "CURB"]));
    expect(cell("MARK")).toBe("RTU-1");
    // 10 tons, stored in tons and printed in the project's capacity unit: the unit is typed, so it converts.
    expect(cell("COOLING")).toBe("120.0 MBH");
    expect(cell("SUPPLY CFM")).toMatch(/4,?000/);
    expect(cell("OPER. WEIGHT")).toMatch(/1,?250(\.0)? lb/);
    expect(cell("CURB")).toBe("106 x 56 in");
  });

  it("a weight from the vendor's data, set on the type, shows on the schedule", async () => {
    const m = await roof();
    m.ok({ type: "set_parameters", id: "firm:rtu-10", scope: "type", values: { operating_weight: 1410 } });
    expect(print(m).cell("OPER. WEIGHT")).toMatch(/1,?410(\.0)? lb/);
  });
});
