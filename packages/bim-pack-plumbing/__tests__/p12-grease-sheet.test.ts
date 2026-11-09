/**
 * @jest-environment node
 *
 * Round 12 lane P12 step 2: grease interceptor sizing as a live sheet. A
 * three-compartment sink with 28 × 20 × 14 in bowls (synthetic parts built in
 * the test): 23,520 in³, 76.36 gpm at a 1-minute drain, 38.18 gpm at 2
 * minutes, which a 50 gpm interceptor passes and a 35 gpm one doesn't.
 * Without the interceptor picked, the sheet says what to pick.
 *
 * Fails on round 11's code: no calc sheet point, no grease template.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { placeCalcSheet } from "@permitzip/bim-kernel/calc-sheets";
import { GREASE_INTERCEPTOR_TEMPLATE_ID } from "../src";

const builtin = { kind: "builtin", libraryVersion: "test" } as const;
const box = { geometry: [{ kind: "box" as const, center: [0, 0, 100] as [number, number, number], size: [200, 200, 200] as [number, number, number] }], symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [200, 200] as [number, number] }] };
const num = (name: string, label: string) => ({ name, label, kind: "number" as const, unit: "none" as const, min: 0 });

function part(familyName: string, values: Readonly<Record<string, number>>): PartTypeDefinition {
  return { familyName, typeName: "Test", category: "plumbing_fixture", typeParams: Object.keys(values).map((k) => num(k, k)), typeValues: values, instanceParams: [], connectors: [], ...box, tagFields: ["mark"], source: builtin };
}

function model(ratedGpm: number): ModelState {
  const cmds: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
    { type: "place_part", partId: "sink", typeId: "t:sink", partType: part("Three-compartment sink", { bowl_length_in: 28, bowl_width_in: 20, bowl_depth_in: 14, bowl_count: 3 }), levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "S-1" },
    { type: "place_part", partId: "gi", typeId: "t:gi", partType: part("Grease interceptor", { rated_gpm: ratedGpm }), levelId: "lvl-1", position: { x: 3000, y: 0 }, mark: "GI-1" },
  ];
  let m: ModelState = { modelId: "p12-grease", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of cmds) {
    const d = planCommit(m, [], { idempotencyKey: `p12g-${ratedGpm}-${m.revision}`, baseRevision: m.revision, actor: { id: "quinn", name: "Quinn", kind: "human" }, command }, () => "2026-11-03T12:00:00.000Z");
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    m = d.model;
  }
  return m;
}

const ctx = { tables: { table: () => null }, limits: {} };

function sheet(m: ModelState, interceptorId?: string) {
  const r = placeCalcSheet(m, GREASE_INTERCEPTOR_TEMPLATE_ID, { subjectId: "sink" as never, ...(interceptorId ? { options: { interceptorId } } : {}) }, ctx);
  if ("refused" in r) throw new Error(r.refused);
  return r.evaluation;
}

describe("p12-grease-sheet", () => {
  it("28 × 20 × 14 in × 3 → 23,520 in³ → 76.36 / 38.18 gpm; a 50 gpm interceptor passes at 2 minutes", () => {
    const ev = sheet(model(50), "gi");
    expect(ev.values.volume).toBe(23520);
    expect(ev.values.gpm_1).toBeCloseTo(76.36, 2);
    expect(ev.values.gpm_2).toBeCloseTo(38.18, 2);
    expect(ev.values.passes).toBe(1);
  });

  it("a 35 gpm interceptor fails", () => {
    expect(sheet(model(35), "gi").values.passes).toBe(0);
  });

  it("with no interceptor picked, it says what to pick and doesn't pass or fail", () => {
    const ev = sheet(model(50));
    expect(ev.values.passes).toBeNull();
    expect(ev.missing).toContain("Interceptor rated flow: pick what this sheet is about");
  });
});
