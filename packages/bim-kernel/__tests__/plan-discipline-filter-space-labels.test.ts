/**
 * @jest-environment node
 *
 * Nov 8 showcase: a plumbing plan (P-101) printed the mechanical ductwork
 * (screened) beside the plumbing, and no plan printed its rooms' names. A
 * plan drawn for one discipline now prints its own work in ink, the building
 * and other disciplines' equipment halftone, and leaves other disciplines'
 * runs out; each space on the plan's level prints its name and number unless
 * the view tags it or hides rooms.
 */
import {
  DEFAULT_SETTINGS,
  buildViewScene,
  disciplineDef,
  exampleFloorDrain,
  exampleRooftopUnit,
  leftOutOfDisciplineView,
  listDisciplines,
  planCommit,
  withUpgradePolicy,
  type Command,
  type ModelState,
} from "../src";

const NOW = () => "2026-11-08T00:00:00.000Z";
let seq = 0;
function ok(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `k-${seq}`, baseRevision: head.revision, actor: { id: "a", name: "A", kind: "human" }, command, clientSessionId: "t" }, NOW, []));
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

const FT = 304.8;
function office(): ModelState {
  let m: ModelState = { modelId: "m", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = ok(m, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m = ok(m, { type: "create_element", elementId: "w-1", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 30 * FT, y: 0 } } });
  m = ok(m, { type: "place_part", partId: "p-drain", typeId: "test.drain", partType: exampleFloorDrain(), levelId: "L1", discipline: "plumbing", position: { x: 5 * FT, y: 5 * FT } });
  m = ok(m, { type: "place_part", partId: "p-rtu", typeId: "test.rtu", partType: exampleRooftopUnit(), levelId: "L1", discipline: "mechanical", position: { x: 20 * FT, y: 5 * FT } });
  m = ok(m, { type: "route_run", idPrefix: "sa", levelId: "L1", domain: "duct", size: { shape: "rect", width: 14 * 25.4, height: 10 * 25.4 }, elevationMm: 9 * FT, system: { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 2 * FT, y: 8 * FT }, { x: 28 * FT, y: 8 * FT }] });
  m = ok(m, { type: "create_space", spaces: [{ spaceId: "s-101", levelId: "L1", number: "101", name: "Toilet room", outline: [{ x: 0, y: 0 }, { x: 18 * FT, y: 0 }, { x: 18 * FT, y: 10 * FT }, { x: 0, y: 10 * FT }] }] });
  m = ok(m, { type: "create_view", viewId: "v-p", name: "Level 1 - Plumbing", viewType: "floor_plan", props: { level: "Level 1", discipline: "plumbing", scale: 48 }, crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 35 * FT, y: 15 * FT } } });
  m = ok(m, { type: "create_view", viewId: "v-all", name: "Level 1 - All", viewType: "floor_plan", props: { level: "Level 1", scale: 48 }, crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 35 * FT, y: 15 * FT } } });
  return m;
}
const lineCount = (m: ModelState, viewId: string) => buildViewScene(m, viewId).scene.primitives.filter((p) => p.kind === "line").length;
const texts = (m: ModelState, viewId: string) => buildViewScene(m, viewId).scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
const without = (m: ModelState, id: string): ModelState => ({ ...m, elements: Object.fromEntries(Object.entries(m.elements).filter(([k]) => k !== id)) });

describe("plans drawn for a discipline", () => {
  it("the kernel's shared disciplines are the underlay; trade rows are not", () => {
    for (const id of ["architecture", "structure", "civil", "general_contracting", "documentation", "general"]) expect(disciplineDef(id)?.underlay).toBe(true);
    expect(listDisciplines().filter((d) => d.underlay !== true).map((d) => d.id)).toEqual(expect.arrayContaining(["mechanical", "plumbing"]));
  });

  it("a plumbing plan leaves the ductwork out and keeps the wall, the drain and the unit (halftone)", () => {
    const m = office();
    const view = m.elements["v-p"];
    if (view?.kind !== "view") throw new Error("no view");
    const ducts = Object.values(m.elements).filter((e) => (e.kind === "run_segment" || e.kind === "run_fitting") && e.id.startsWith("sa"));
    expect(ducts.length).toBeGreaterThan(0);
    for (const d of ducts) expect(leftOutOfDisciplineView(view, d)).toBe(true);
    expect(leftOutOfDisciplineView(view, m.elements["p-rtu"]!)).toBe(false);
    expect(leftOutOfDisciplineView(view, m.elements["p-drain"]!)).toBe(false);
    expect(leftOutOfDisciplineView(view, m.elements["w-1"]!)).toBe(false);
    const noDucts = ducts.reduce((acc, d) => without(acc, d.id), m);
    // Removing the ductwork changes nothing on the plumbing plan; it still prints on the plan for every discipline.
    expect(lineCount(noDucts, "v-p")).toBe(lineCount(m, "v-p"));
    expect(lineCount(noDucts, "v-all")).toBeLessThan(lineCount(m, "v-all"));
    expect(texts(m, "v-p")).toContain("RTU");
    expect(lineCount(without(m, "p-drain"), "v-p")).toBeLessThan(lineCount(m, "v-p"));
  });

  it("each space prints its name and number; hiding rooms or tagging the space removes the plain label", () => {
    let m = office();
    expect(texts(m, "v-all")).toContain("TOILET ROOM 101");
    expect(texts(m, "v-p")).toContain("TOILET ROOM 101");
    m = ok(m, { type: "set_view_properties", viewId: "v-all", props: { hiddenCategories: ["rooms"] } });
    expect(texts(m, "v-all")).not.toContain("TOILET ROOM 101");
  });
});
