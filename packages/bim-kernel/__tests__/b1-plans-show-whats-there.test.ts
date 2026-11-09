/**
 * @jest-environment node
 *
 * The Nov 6 review video (items 2 and 3): a plan shows what is in its height
 * range whichever level owns it, and a linked model's levels map to ours by
 * elevation when the names differ, with a plain choice when two are near.
 *
 * Fails on the old code: the plan read its own level's elements only (work
 * routed on another level never drew, as the RTUs on "ROOF LOW POINT" never
 * drew on ROOF), and a linked level matched by name or within 5 mm only ("It
 * has no level matching ROOF").
 */
import {
  DEFAULT_SETTINGS,
  buildViewScene,
  commandSchema,
  executeCommand,
  linkedPlanPlacement,
  matchLinkedStorey,
  otherLevelElementsInRange,
  planCommit,
  type Command,
  type CommandRequest,
  type LinkedPlanRule,
  type ModelState,
  type ViewElement,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function refused(model: ModelState, command: Record<string, unknown> & { type: string }): string {
  const r = executeCommand(model, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

function viewOf(m: ModelState, id: string): ViewElement {
  const v = m.elements[id];
  if (v?.kind !== "view") throw new Error(`${id} is not a view`);
  return v;
}

const lines = (model: ModelState, viewId: string) => buildViewScene(model, viewId).scene.primitives.filter((p) => p.kind === "line").length;

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const DUCT = { shape: "rect" as const, width: 14 * 25.4, height: 10 * 25.4 };

let n = 0;
function commit(head: ModelState, command: Command): ModelState {
  n += 1;
  const req: CommandRequest = { idempotencyKey: `b1-plans-${n}-key`, baseRevision: head.revision, actor: { id: "a", name: "Agent", kind: "agent" }, command };
  const d = planCommit(head, [], req, () => "2026-11-06T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

/** A duct routed on Level 1 at 10 ft; UPPER is a level at 8 ft with nothing of its own (the roof just under the units hosted on another level). */
function model(): ModelState {
  let m: ModelState = { modelId: "b1-plans", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  m = commit(m, { type: "create_level", levelId: "lvl-upper", name: "UPPER", elevationMm: 8 * FT });
  m = commit(m, { type: "create_view", viewId: "upper", name: "UPPER plan", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 25 * FT, y: 5 * FT } }, props: { level: "UPPER", scale: 48 } });
  m = commit(m, { type: "create_view", viewId: "empty", name: "Empty plan", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 25 * FT, y: 5 * FT } }, props: { level: "NOWHERE", levelElevationMm: 200 * FT, scale: 48 } });
  return m;
}

describe("a plan shows what is in its height range, whichever level owns it", () => {
  it("work on the level below that rises into the plan's range draws on it", () => {
    const m = model();
    const reached = otherLevelElementsInRange(m, viewOf(m, "upper"));
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((el) => (el.partition?.level ?? "") !== "UPPER")).toBe(true);
    expect(lines(m, "upper")).toBeGreaterThan(lines(m, "empty"));
  });

  it("a view top below that work leaves it out again", () => {
    let m = model();
    const before = lines(m, "upper");
    // Top at 0.5 ft above UPPER (8.5 ft): the 9 ft runs are wholly above it.
    m = commit(m, { type: "set_view_properties", viewId: "upper", props: { viewTopMm: 0.5 * FT, cutHeightMm: 0.25 * FT } });
    expect(otherLevelElementsInRange(m, viewOf(m, "upper"))).toHaveLength(0);
    expect(lines(m, "upper")).toBeLessThan(before);
  });

  it("the level's own plan draws what it drew before", () => {
    let m = model();
    m = commit(m, { type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 25 * FT, y: 5 * FT } }, props: { level: "Level 1", scale: 48 } });
    const before = lines(m, "plan");
    m = commit(m, { type: "create_level", levelId: "lvl-mid", name: "MID", elevationMm: 4 * FT });
    // Nothing stands on MID, so Level 1's plan gains nothing and loses nothing.
    expect(otherLevelElementsInRange(m, viewOf(m, "plan"))).toHaveLength(0);
    expect(lines(m, "plan")).toBe(before);
  });

  it("a plan far above opens no level's work", () => {
    const m = model();
    expect(otherLevelElementsInRange(m, viewOf(m, "empty"))).toHaveLength(0);
  });
});

describe("linked levels map by elevation", () => {
  const storeys = [
    { name: "LEVEL 01", elevationMm: 0 },
    { name: "ROOF LOW POINT", elevationMm: 14 * FT },
    { name: "ROOF HIGH POINT", elevationMm: 16 * FT },
  ];

  it("ROOF between two roof storeys is a plain question, never a silent pick or a dead end", () => {
    const r = matchLinkedStorey(storeys, { level: "ROOF", levelElevationMm: 15 * FT, linkLabel: "the architect's model" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates.map((s) => s.name)).toEqual(["ROOF LOW POINT", "ROOF HIGH POINT"]);
    expect(r.question).toMatch(/^Which level of the architect's model is ROOF\?/);
  });

  it("the one storey near enough is used", () => {
    const r = matchLinkedStorey(storeys, { level: "ROOF", levelElevationMm: 13 * FT, linkLabel: "A" });
    expect(r.ok && r.storey.name).toBe("ROOF LOW POINT");
    expect(r.ok && r.how).toBe("nearest");
  });

  it("a person's choice wins over name and height", () => {
    const r = matchLinkedStorey(storeys, { level: "ROOF", levelElevationMm: 15 * FT, chosen: "ROOF HIGH POINT", linkLabel: "A" });
    expect(r.ok && r.storey.name).toBe("ROOF HIGH POINT");
    expect(r.ok && r.how).toBe("chosen");
  });

  it("names still match first, ignoring case and leading zeros", () => {
    const r = matchLinkedStorey(storeys, { level: "Level 1", levelElevationMm: 99 * FT, linkLabel: "A" });
    expect(r.ok && r.storey.name).toBe("LEVEL 01");
  });

  it("no storey near enough still offers every storey to choose from", () => {
    const r = matchLinkedStorey(storeys, { level: "PENTHOUSE", levelElevationMm: 60 * FT, linkLabel: "A" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("none");
    expect(r.candidates).toHaveLength(3);
    expect(r.candidates[0]?.name).toBe("ROOF HIGH POINT");
  });

  it("a level keeps the choice per linked model, and forgets it on request", () => {
    let m = createDemoModel();
    m = run(m, { type: "create_level", levelId: "lvl-roof", name: "ROOF", elevationMm: 15 * FT });
    m = run(m, { type: "set_level_linked_storey", levelId: "lvl-roof", linkId: "link-arch", storeyName: "ROOF LOW POINT" });
    m = run(m, { type: "set_level_linked_storey", levelId: "lvl-roof", linkId: "link-mep", storeyName: "ROOF" });
    const roof = m.elements["lvl-roof"];
    expect(roof?.kind === "level" ? roof.linkedStoreys : null).toEqual({ "link-arch": "ROOF LOW POINT", "link-mep": "ROOF" });
    expect(refused(m, { type: "set_level_linked_storey", levelId: "lvl-roof", linkId: "link-arch", storeyName: "ROOF LOW POINT" })).toMatch(/already uses ROOF LOW POINT/);
    m = run(m, { type: "set_level_linked_storey", levelId: "lvl-roof", linkId: "link-arch", storeyName: null });
    const after = m.elements["lvl-roof"];
    expect(after?.kind === "level" ? after.linkedStoreys : null).toEqual({ "link-mep": "ROOF" });
  });
});

describe("the one view-range rule for linked elements", () => {
  const mepRule: LinkedPlanRule = { drawAs: "body", cut: true, below: true, above: true, ceilingPlan: true, occludes: true, hideAtCoarse: false };
  const ceilingRule: LinkedPlanRule = { drawAs: "body", cut: true, below: false, above: false, ceilingPlan: true, occludes: true, hideAtCoarse: false };
  const plan = { cutMm: 1200, lowMm: 0, highMm: 6000, lookingUp: false, detail: "medium" as const };

  it("work above the cut draws in floor plans up to the top, and not past it", () => {
    expect(linkedPlanPlacement(mepRule, 2700, 3000, plan)).toBe("above");
    expect(linkedPlanPlacement(mepRule, 6100, 6400, plan)).toBe("skip");
    expect(linkedPlanPlacement(undefined, 0, 3000, plan)).toBe("skip");
  });

  it("ceilings show in ceiling plans only; nothing below the cut shows looking up", () => {
    expect(linkedPlanPlacement(ceilingRule, 2700, 2720, plan)).toBe("skip");
    expect(linkedPlanPlacement(ceilingRule, 2700, 2720, { ...plan, lookingUp: true })).toBe("above");
    expect(linkedPlanPlacement(mepRule, 100, 400, { ...plan, lookingUp: true })).toBe("skip");
  });
});
