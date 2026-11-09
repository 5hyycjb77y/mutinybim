/**
 * @jest-environment node
 *
 * The kernel's side of ventilation (ROADMAP M1): fields on spaces and zones
 * that schedules and field blocks read, and the table block, both reading
 * through the engine `@permitzip/bim-calc` registers. The kernel never reads
 * the space-use library, so with no engine registered it prints that the
 * pack isn't loaded instead of a number. Before this change neither file
 * existed and no space or zone field said anything about outdoor air.
 *
 * @mutinybim-bare-kernel: these cases read the fields with no outdoor-air
 * engine loaded (no pack in the set contributes one). Since round 6 the
 * fields are the Mechanical add-on's: its rows are installed without the
 * engine (`installMechanicalRowsOnly`), as the bare kernel read them before.
 */
import { unitAllowed } from "@permitzip/bim-units";
import { asElementId, DEFAULT_SETTINGS, fieldProviderRegistry, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { VENTILATION_NOT_LOADED } from "@permitzip/bim-kernel";
import { renderVentilationTable, ventilationScopeMembers, VENTILATION_FIELD_PROVIDER } from "../src";
import { installMechanicalRowsOnly } from "./mechanical-rows";

installMechanicalRowsOnly();

const L1 = asElementId("L1");

function model(): ModelState {
  const els: BimElement[] = [
    { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 },
    { id: asElementId("s2"), kind: "space", version: 1, authoredRev: {}, number: "102", name: "Kitchen", levelId: L1, bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }] }, origin: { kind: "drawn" } },
    { id: asElementId("s1"), kind: "space", version: 1, authoredRev: {}, number: "101", name: "Dining", levelId: L1, bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }] }, origin: { kind: "drawn" } },
    { id: asElementId("z1"), kind: "zone", version: 1, authoredRev: {}, name: "Zone 1", purpose: "thermal", spaceIds: [asElementId("s1")] },
    { id: asElementId("z2"), kind: "zone", version: 1, authoredRev: {}, name: "Fire area", purpose: "fire_area", spaceIds: [asElementId("s1")] },
  ];
  return { modelId: "v", revision: 0 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}


describe("ventilation fields", () => {
  const registry = fieldProviderRegistry();

  it("registers outdoor air, exhaust, Rp, Ra, Ez, governing and basis on spaces and zones, every quantity with a unit its kind allows and every field locked with a reason", () => {
    const paths = (cls: string) => registry.fieldsFor(cls).filter((f) => f.path.startsWith("ventilation.")).map((f) => f.path).sort();
    expect(paths("gen.space")).toEqual(["ventilation.ashrae_oa_cfm", "ventilation.basis", "ventilation.breathing_zone_cfm", "ventilation.exhaust_cfm", "ventilation.ez", "ventilation.governing", "ventilation.imc_oa_cfm", "ventilation.oa_required_cfm", "ventilation.ra", "ventilation.rp"]);
    expect(paths("gen.zone")).toEqual(["ventilation.ashrae_oa_cfm", "ventilation.basis", "ventilation.exhaust_cfm", "ventilation.governing", "ventilation.imc_oa_cfm", "ventilation.oa_required_cfm", "ventilation.unit_oa_cfm"]);
    for (const f of VENTILATION_FIELD_PROVIDER.fields ?? []) {
      if (f.valueType === "quantity") expect(f.kind && f.unit && unitAllowed(f.kind, f.unit)).toBe(true);
      expect(f.writer.kind === "none" && f.writer.reason.length > 10).toBe(true);
    }
  });

  it("reads empty, and says the pack isn't loaded, when no engine is registered", () => {
    const m = model();
    const s1 = m.elements.s1 as BimElement;
    expect(registry.field("gen.space", "ventilation.oa_required_cfm")?.read?.(s1, { elements: m.elements })).toBeNull();
    expect(registry.field("gen.space", "ventilation.basis")?.read?.(s1, { elements: m.elements })).toBe(VENTILATION_NOT_LOADED);
  });
});

describe("ventilation table block", () => {
  it("lists a level's spaces by number and only its ventilation and thermal zones", () => {
    const m = model();
    const members = ventilationScopeMembers(m.elements, { kind: "level", levelId: L1 });
    expect(members.spaces.map((s) => s.number)).toEqual(["101", "102"]);
    expect(members.zones.map((z) => z.name)).toEqual(["Zone 1"]);
  });

  it("prints that the pack isn't loaded, and lists it as unresolved, with no engine", () => {
    const r = renderVentilationTable(model(), { kind: "ventilation", scope: { kind: "model" } });
    expect(r.text).toBe(VENTILATION_NOT_LOADED);
    expect(r.unresolved).toEqual(["ventilation"]);
  });
});
