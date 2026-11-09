/**
 * @jest-environment node
 *
 * Nov 8: a plan drawn for one discipline prints without other disciplines'
 * runs (`leftOutOfDisciplineView`), but the live plan still drew them. The
 * live plan now leaves out exactly what the printed drawing leaves out, by
 * the same test; the free 3D model and a plan for every discipline show all.
 */
import { commandSchema, executeCommand, leftOutOfDisciplineView, withUpgradePolicy, DEFAULT_SETTINGS, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";
import { liveViewRangeExcludes } from "../src/live-display";

// The host installs the first-party add-ons, which register the trade disciplines.
installFirstPartyPacks(FIRST_PARTY_ADDONS);

const FT = 304.8;
function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(command)));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function floor(): ModelState {
  let m: ModelState = { modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m = run(m, { type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 30 * FT, y: 0 } } });
  m = run(m, { type: "route_run", idPrefix: "sa", levelId: "L1", domain: "duct", size: { shape: "rect", width: 356, height: 254 }, elevationMm: 9 * FT, system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 2 * FT, y: 8 * FT }, { x: 28 * FT, y: 8 * FT }] });
  m = run(m, { type: "route_run", idPrefix: "san", levelId: "L1", domain: "pipe", size: { shape: "pipe", nominalMm: 76.2, material: "pvc" }, elevationMm: -1 * FT, system: { id: "sys-san", kind: "sanitary", name: "Sanitary" }, points: [{ x: 2 * FT, y: 4 * FT }, { x: 28 * FT, y: 4 * FT }] });
  return m;
}
const runs = (m: ModelState, prefix: string): BimElement[] => Object.values(m.elements).filter((e) => (e.kind === "run_segment" || e.kind === "run_fitting") && e.id.startsWith(prefix));

describe("the live plan of a discipline plan", () => {
  const m = floor();
  const plumbing = { props: { level: "Level 1", discipline: "plumbing" } };

  it("leaves out the other discipline's runs, as its printed drawing does, and keeps its own work and the building", () => {
    const live = liveViewRangeExcludes(m, plumbing, true);
    expect(live).not.toBeNull();
    const all = [...runs(m, "sa-"), ...runs(m, "san-"), m.elements["w-1"]!];
    for (const el of all) expect(live!(el)).toBe(leftOutOfDisciplineView(plumbing, el));
    expect(runs(m, "sa-").every((el) => live!(el))).toBe(true);
    expect(runs(m, "san-").some((el) => live!(el))).toBe(false);
    expect(live!(m.elements["w-1"]!)).toBe(false);
  });

  it("the free 3D model and a plan for every discipline leave nothing out", () => {
    expect(liveViewRangeExcludes(m, plumbing, false)).toBeNull();
    expect(liveViewRangeExcludes(m, { props: { level: "Level 1" } }, true)).toBeNull();
  });
});
