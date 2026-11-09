/**
 * @jest-environment node
 *
 * Picking follows Visibility/Graphics (round 5b f-graphics, phase 2): what a
 * view hides by category can't be picked in its drawing. Before this, the
 * picker read `hiddenCategories` for everything but parts, so a duct run
 * hidden through a per-category override (Duct, or its system's service)
 * still answered the pointer.
 */
import { DEFAULT_SETTINGS, buildViewPickIndex, pickAt, planCommit, type BimElement, type Command, type ModelState, type ViewElement, type ViewProps } from "../src";

const FT = 304.8;
const IN = 25.4;
let seq = 0;

function apply(m: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(m, [], { idempotencyKey: `r5g-pick-${seq}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-29T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function project(): ModelState {
  let m: ModelState = { modelId: "r5g-pick", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = apply(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = apply(m, { type: "route_run", idPrefix: "t", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 9 * FT, system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 0, y: 10 * FT }, { x: 40 * FT, y: 10 * FT }] });
  m = apply(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 50 * FT, y: 30 * FT } }, props: { level: "Level 1", scale: 48 } });
  return m;
}

describe("r5g picking reads the category resolver", () => {
  const m = project();
  const trunk = Object.values(m.elements).find((e): e is Extract<BimElement, { kind: "run_segment" }> => e.kind === "run_segment")?.id ?? "";
  const plan = m.elements["v-plan"];
  if (plan?.kind !== "view") throw new Error("plan missing");
  const withProps = (extra: ViewProps): ViewElement => ({ ...plan, props: { ...plan.props, ...extra } });
  const under = (v: ViewElement) => pickAt(buildViewPickIndex(m, v), { x: 15 * FT, y: 10 * FT }, 50);

  it("the trunk is pickable where it draws", () => {
    expect(under(plan)).toEqual([trunk]);
  });

  it("Categories shown off (the older field) still hides it from the pointer", () => {
    expect(under(withProps({ hiddenCategories: ["duct"] }))).toEqual([]);
  });

  it("hidden through Visibility/Graphics, on Duct or on its system's service, it can't be picked (old picker: still picked)", () => {
    expect(under(withProps({ categoryOverrides: { duct: { visible: false } } }))).toEqual([]);
    expect(under(withProps({ categoryOverrides: { "service:supply_air": { visible: false } } }))).toEqual([]);
    // An override that shows it again wins over the older field.
    expect(under(withProps({ hiddenCategories: ["duct"], categoryOverrides: { duct: { visible: true } } }))).toEqual([trunk]);
  });
});
