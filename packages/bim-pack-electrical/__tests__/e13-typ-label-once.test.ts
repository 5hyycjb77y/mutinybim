/**
 * @jest-environment node
 *
 * Round 13 lane E: a 3-unit typical whose receptacle circuit home-runs to a
 * shared panel (P2) draws circuiting on every unit, and the home run is
 * labelled once: the first unit reads "P2-1 (3) TYP.", the other two draw
 * the arrow with no label. "Label repeated typicals once" off: every unit
 * reads "P2-1". Units with their own panel (A001, A002…) keep their own
 * labels. The switch saves only when every peer reads `views:typ_labels`,
 * otherwise it is refused in words; the settings themselves are Electrical's
 * (`circuitGraphicsSchema` on the view graphics row), not the kernel's.
 *
 * Fails on round 12's code: every copy is labelled "P2-1", the kernel's strict
 * view schema refuses `typLabelsOnce`, and there is no `VIEW_TYP_LABELS_FEATURE`.
 */
import { VIEW_TYP_LABELS_FEATURE, buildViewScene, commandSchema, withUpgradePolicy, type Command, type ModelState, type PartInstance, type ViewElement } from "@permitzip/bim-kernel";
import { CIRCUIT_GRAPHICS_ROW, deriveCircuitGraphics, type CircuitGraphicsProps } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const SCALE = 48;
const CROP = { min: { x: -22000, y: -12000 }, max: { x: 40000, y: 6000 } };
const reads = (f: string) => f === VIEW_TYP_LABELS_FEATURE;

/** Corridor panel P2 outside the unit; Unit 001's two receptacles on P2-1; the unit repeated 3 times. */
function units(): Building {
  const b = new Building();
  b.place("p2", "panel208", { panel_name: "P2" }, "P2", { x: -20000, y: 0 });
  b.place("u-r1", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 2000, y: 0 });
  b.place("u-r2", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 4000, y: 0 });
  b.ok({ type: "create_service_link", linkId: "c1", sourceId: "p2", positions: [1], members: [{ elementId: "u-r1" }, { elementId: "u-r2" }] });
  b.ok({ type: "create_group", groupId: "grp-unit", name: "Unit 001" });
  b.ok({ type: "assign_elements_to_group", ids: ["u-r1", "u-r2"], groupId: "grp-unit" });
  b.ok({ type: "set_group_typical", groupId: "grp-unit", label: "Unit", mark: "001", array: { count: 3, columns: 3, spacingMm: { x: 10000, y: 0 } } });
  return b;
}

function plan(b: Building, id: string, circuitGraphics: CircuitGraphicsProps): void {
  const cmd: Command = { type: "create_view", viewId: id, name: `Units ${id}`, viewType: "floor_plan", crop: CROP, props: { level: "Level 1", scale: SCALE, discipline: "electrical", circuitGraphics } };
  withUpgradePolicy(reads, () => b.ok(cmd));
}

function viewOf(m: ModelState, id: string): ViewElement {
  const v = m.elements[id];
  if (v?.kind !== "view") throw new Error(`no view ${id}`);
  return v;
}

function homeRunLabels(b: Building, id: string): string[] {
  const shown = new Map<string, PartInstance>();
  for (const el of Object.values(b.head.elements)) if (el.kind === "part") shown.set(el.id, el);
  return deriveCircuitGraphics(b.head, viewOf(b.head, id), shown, SCALE).flatMap((g) => (g.homeRun ? [g.homeRun.label] : []));
}

const texts = (b: Building, id: string) => buildViewScene(b.head, id).scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

describe("e13: repeated typical circuits are labelled once", () => {
  it("labels the first unit '(3) TYP.' and leaves the other two arrows unlabelled (on by default)", () => {
    const b = units();
    plan(b, "v-once", { style: "arcs", allCopies: true });
    expect(homeRunLabels(b, "v-once")).toEqual(["P2-1 (3) TYP.", "", ""]);
    const t = texts(b, "v-once");
    expect(t.filter((x) => x === "P2-1 (3) TYP.")).toHaveLength(1);
    expect(t).not.toContain("P2-1");
  });

  it("with the switch off every unit carries its own label", () => {
    const b = units();
    plan(b, "v-each", { style: "arcs", allCopies: true, typLabelsOnce: false });
    expect(homeRunLabels(b, "v-each")).toEqual(["P2-1", "P2-1", "P2-1"]);
  });

  it("units on their own panels keep their own labels", () => {
    const b = new Building();
    b.place("a001", "panel208", { panel_name: "A001" }, "A001", { x: 0, y: 0 });
    b.place("u-r1", "receptacle", { voltage: 120, load_va: 180 }, "", { x: 2000, y: 0 });
    b.ok({ type: "create_service_link", linkId: "u-c1", sourceId: "a001", positions: [1], members: [{ elementId: "u-r1" }] });
    b.ok({ type: "create_group", groupId: "grp-unit", name: "Unit 001" });
    b.ok({ type: "assign_elements_to_group", ids: ["a001", "u-r1"], groupId: "grp-unit" });
    b.ok({ type: "set_group_typical", groupId: "grp-unit", label: "Unit", mark: "001", array: { count: 3, columns: 3, spacingMm: { x: 10000, y: 0 } } });
    plan(b, "v-own", { style: "arcs", allCopies: true });
    expect(homeRunLabels(b, "v-own")).toEqual(["A001-1", "A002-1", "A003-1"]);
  });

  it("is Electrical's setting: read by the row's schema, refused in words on an older model server", () => {
    expect(CIRCUIT_GRAPHICS_ROW.hintsSchema?.safeParse({ typLabelsOnce: true }).success).toBe(true);
    const bad = commandSchema.safeParse({ type: "set_view_properties", viewId: "v", props: { circuitGraphics: { typLabelsOnce: "yes" } } });
    expect(bad.success).toBe(false);
    const b = units();
    plan(b, "v-p", { style: "arcs" });
    expect(b.refused({ type: "set_view_properties", viewId: "v-p", props: { circuitGraphics: { style: "arcs", allCopies: true, typLabelsOnce: false } } })).toMatch(/^"Label repeated typicals once" can't be saved yet: the model server this model is open on is an older version/);
  });
});
