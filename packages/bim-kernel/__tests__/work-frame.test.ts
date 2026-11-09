/**
 * @jest-environment node
 *
 * The working angle: the direction people draw in on a building that sits
 * skewed on the model axes. Set from an angle or from two points along a
 * building edge; the model has a default and a view may carry its own. It is a
 * work frame only: geometry, linked models, shared coordinates and true north
 * never change. New 3D crop boxes come in square to it, an existing box can be
 * aligned to it by command (never a rotate handle), and a plan can be drawn
 * turned to it.
 */
import {
  applyChangeset,
  boxAroundAabb,
  boxCorners,
  canonicalJson,
  commandSchema,
  describeWorkingAngle,
  executeCommand,
  fromWorkFrame,
  insideBox,
  isKind,
  modelAabb,
  modelToShared,
  northArrowDeg,
  paperWorkingAngleDeg,
  normalizeWorkingAngleDeg,
  planCommit,
  siteOf,
  toDocumentRecord,
  toWorkFrame,
  viewRotationDeg,
  workFrameOf,
  workingAngleFromEdge,
  workingAngleOf,
  type Changeset,
  type ModelState,
  type SitePoint,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const NOW = () => "2026-10-21T00:00:00.000Z";
const AVERY = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

class Log {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(command: RawCommand) {
    seq += 1;
    const base = this.head.revision;
    const req = { idempotencyKey: `wf-key-${seq}`, baseRevision: base, actor: AVERY, command: commandSchema.parse(command), clientSessionId: "tab-avery" };
    const d = planCommit(this.head, [], req, NOW, this.log);
    if (d.ok) {
      expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }
  ok(command: RawCommand): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
    return d.changeset;
  }
}

function refusal(head: ModelState, command: RawCommand): string {
  const r = executeCommand(head, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

function view(model: ModelState, id: string) {
  const found = model.elements[id];
  if (!found || !isKind(found, "view")) throw new Error(`${id} is not a view`);
  return found;
}

/** A wall edge of a building turned 17.5° counter-clockwise on the model axes. */
const SKEW = 17.5;
const edge = (lengthMm: number) => {
  const a = (SKEW * Math.PI) / 180;
  return { from: { x: 1000, y: 2000 }, to: { x: 1000 + Math.cos(a) * lengthMm, y: 2000 + Math.sin(a) * lengthMm } };
};

describe("working angle math", () => {
  test("any angle folds into (−45, 45]: the frame repeats every 90°", () => {
    expect(normalizeWorkingAngleDeg(0)).toBe(0);
    expect(normalizeWorkingAngleDeg(90)).toBe(0);
    expect(normalizeWorkingAngleDeg(107.5)).toBeCloseTo(17.5, 6);
    expect(normalizeWorkingAngleDeg(-72.5)).toBeCloseTo(17.5, 6);
    expect(normalizeWorkingAngleDeg(45)).toBe(45);
    expect(normalizeWorkingAngleDeg(-45)).toBe(45);
    expect(normalizeWorkingAngleDeg(-30)).toBe(-30);
  });

  test("an edge drawn either way, or the wall across it, gives the same working angle", () => {
    const e = edge(5000);
    expect(workingAngleFromEdge(e.from, e.to)).toBeCloseTo(SKEW, 6);
    expect(workingAngleFromEdge(e.to, e.from)).toBeCloseTo(SKEW, 6);
    const a = ((SKEW + 90) * Math.PI) / 180;
    expect(workingAngleFromEdge(e.from, { x: e.from.x + Math.cos(a) * 3000, y: e.from.y + Math.sin(a) * 3000 })).toBeCloseTo(SKEW, 6);
    expect(workingAngleFromEdge(e.from, e.from)).toBeNull();
  });

  test("frame coordinates round-trip, and a point along the edge reads straight along working X", () => {
    const frame = { angleDeg: SKEW, origin: { x: 1000, y: 2000 } };
    const e = edge(6000);
    const q = toWorkFrame(frame, e.to);
    expect(q.x).toBeCloseTo(6000, 6);
    expect(q.y).toBeCloseTo(0, 6);
    const back = fromWorkFrame(frame, q);
    expect(back.x).toBeCloseTo(e.to.x, 3);
    expect(back.y).toBeCloseTo(e.to.y, 3);
  });

  test("described in plain words", () => {
    expect(describeWorkingAngle(0)).toBe("Square to the model's axes");
    expect(describeWorkingAngle(17.5)).toBe("Turned 17.5° counter-clockwise");
    expect(describeWorkingAngle(-8.25)).toBe("Turned 8.25° clockwise");
  });
});

describe("set_working_angle", () => {
  test("picking two points along a wall sets the model's working angle; nothing moves on the site", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "set_project_origin", mode: "relocate_project", shared: { eastWest: 120_000, northSouth: 45_000, elevation: 3000 } });
    m.ok({ type: "set_true_north", angleDeg: -153.835494 });
    const before = m.head;
    const probes: SitePoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 12_000, y: -3_500, z: 2_700 },
      siteOf(before).surveyPoint,
    ];
    const sharedBefore = probes.map((p) => modelToShared(siteOf(before), p));

    m.ok({ type: "set_working_angle", ...edge(8000) });

    expect(workingAngleOf(m.head)).toBeCloseTo(SKEW, 6);
    expect(siteOf(m.head).trueNorthDeg).toBe(siteOf(before).trueNorthDeg);
    probes.forEach((p, i) => expect(modelToShared(siteOf(m.head), p)).toEqual(sharedBefore[i]));
    // Geometry and every other element are untouched: only the site element changed.
    for (const [id, el] of Object.entries(before.elements)) {
      if (id === "site") continue;
      expect(canonicalJson(m.head.elements[id])).toBe(canonicalJson(el));
    }
  });

  test("a typed angle folds into (−45, 45]; undo puts the model back square", () => {
    const m = new Log(createDemoModel());
    const cs = m.ok({ type: "set_working_angle", angleDeg: 107.5 });
    expect(workingAngleOf(m.head)).toBeCloseTo(17.5, 6);
    m.ok({ type: "undo", revision: cs.revision });
    expect(workingAngleOf(m.head)).toBe(0);
  });

  test("says what is wrong in plain words", () => {
    const head = createDemoModel();
    expect(refusal(head, { type: "set_working_angle" })).toMatch(/working angle in degrees, or pick two points/);
    expect(refusal(head, { type: "set_working_angle", angleDeg: 10, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toMatch(/not both/);
    expect(refusal(head, { type: "set_working_angle", from: { x: 5, y: 5 }, to: { x: 5, y: 5 } })).toMatch(/same/);
    expect(refusal(head, { type: "set_working_angle", angleDeg: 0 })).toMatch(/already that/);
  });
});

describe("working angle in views", () => {
  function withPlan(): Log {
    const m = new Log(createDemoModel());
    m.ok({ type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", scale: 48 } });
    return m;
  }

  test("a view may carry its own working angle; null goes back to the model's", () => {
    const m = withPlan();
    m.ok({ type: "set_working_angle", angleDeg: 10 });
    expect(workingAngleOf(m.head, view(m.head, "v-plan"))).toBe(10);
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { workingAngleDeg: -100 } });
    expect(view(m.head, "v-plan").props?.workingAngleDeg).toBeCloseTo(-10, 6);
    expect(workingAngleOf(m.head, view(m.head, "v-plan"))).toBeCloseTo(-10, 6);
    expect(workingAngleOf(m.head)).toBe(10);
    expect(toDocumentRecord(view(m.head, "v-plan"))).not.toBeNull();
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { workingAngleDeg: null } });
    expect(view(m.head, "v-plan").props?.workingAngleDeg).toBeUndefined();
    expect(workingAngleOf(m.head, view(m.head, "v-plan"))).toBe(10);
  });

  test("a plan turned to the working angle draws the building's walls square to the paper; the north arrow still points at true north", () => {
    const m = withPlan();
    m.ok({ type: "set_true_north", angleDeg: 30 });
    m.ok({ type: "set_working_angle", ...edge(5000) });
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { orientation: "working_angle" } });
    const v = view(m.head, "v-plan");
    const site = siteOf(m.head);
    expect(viewRotationDeg(site, v)).toBeCloseTo(-SKEW, 6);
    expect(northArrowDeg(site, v)).toBeCloseTo(30 + SKEW, 6);
    // The frame follows the view's own angle when it has one.
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { workingAngleDeg: 5 } });
    expect(viewRotationDeg(site, view(m.head, "v-plan"))).toBe(-5);
  });

  test("drafting ortho on paper steps from the working angle, turned with the plan; 0 on a plan turned to it", () => {
    const m = withPlan();
    m.ok({ type: "set_working_angle", angleDeg: SKEW });
    expect(paperWorkingAngleDeg(m.head, view(m.head, "v-plan"))).toBeCloseTo(SKEW, 6);
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { orientation: "working_angle" } });
    expect(paperWorkingAngleDeg(m.head, view(m.head, "v-plan"))).toBe(0);
    m.ok({ type: "set_true_north", angleDeg: 30 });
    m.ok({ type: "set_view_properties", viewId: "v-plan", props: { orientation: "true_north" } });
    expect(paperWorkingAngleDeg(m.head, view(m.head, "v-plan"))).toBeCloseTo(SKEW + 30, 6);
    expect(paperWorkingAngleDeg(m.head, null)).toBe(0);
  });

  test("only plans turn to the working angle", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "create_3d_view", viewId: "v-3d", name: "3D" });
    expect(refusal(m.head, { type: "set_view_properties", viewId: "v-3d", props: { orientation: "working_angle" } })).toMatch(/Only plans turn to the working angle/);
  });

  test("the work frame runs through the project base point", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "set_project_origin", mode: "move_point", position: { x: 4000, y: 5000, z: 0 } });
    m.ok({ type: "set_working_angle", angleDeg: 12 });
    expect(workFrameOf(m.head)).toEqual({ angleDeg: 12, origin: { x: 4000, y: 5000 } });
  });
});

describe("3D crop boxes and the working angle", () => {
  test("a box turned to an angle holds every corner of the bounds", () => {
    const bounds = { min: { x: -3000, y: 1000, z: 0 }, max: { x: 9000, y: 7000, z: 4000 } };
    const b = boxAroundAabb(bounds, SKEW);
    expect(b.rotationDeg).toBeCloseTo(SKEW, 6);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) expect(insideBox(b, { x, y, z }, 1)).toBe(true);
  });

  test("a new 3D view's box comes in square to the working angle (today: square to model east)", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "set_working_angle", ...edge(5000) });
    m.ok({ type: "create_3d_view", viewId: "v-3d", name: "Soffit" });
    const box = view(m.head, "v-3d").props?.cropBox3d;
    expect(box?.rotationDeg).toBeCloseTo(SKEW, 6);
    const all = modelAabb(m.head);
    for (const c of boxCorners(boxAroundAabb(all, 0))) expect(box && insideBox(box, c, 1)).toBe(true);
    // A plain 3D view made through create_view gets the same.
    m.ok({ type: "create_view", viewId: "v-3d-b", name: "Soffit B", viewType: "three_d" });
    expect(view(m.head, "v-3d-b").props?.cropBox3d?.rotationDeg).toBeCloseTo(SKEW, 6);
  });

  test("Align to the working angle turns an existing box about its middle, size kept", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "create_3d_view", viewId: "v-3d", name: "3D" });
    const before = view(m.head, "v-3d").props?.cropBox3d;
    expect(before?.rotationDeg).toBe(0);
    m.ok({ type: "set_working_angle", angleDeg: SKEW });
    m.ok({ type: "set_3d_crop_box", viewId: "v-3d", align: "working_angle" });
    const after = view(m.head, "v-3d").props?.cropBox3d;
    expect(after?.rotationDeg).toBeCloseTo(SKEW, 6);
    expect(after?.center).toEqual(before?.center);
    expect(after?.halfSize).toEqual(before?.halfSize);
    expect(refusal(m.head, { type: "set_3d_crop_box", viewId: "v-3d", align: "working_angle" })).toMatch(/already square/);
  });

  test("Align to an edge turns the box square to two picked points", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "create_3d_view", viewId: "v-3d", name: "3D" });
    m.ok({ type: "set_3d_crop_box", viewId: "v-3d", align: edge(4000) });
    expect(view(m.head, "v-3d").props?.cropBox3d?.rotationDeg).toBeCloseTo(SKEW, 6);
    expect(refusal(m.head, { type: "set_3d_crop_box", viewId: "v-3d", align: { from: { x: 1, y: 1 }, to: { x: 1, y: 1 } } })).toMatch(/same/);
  });

  test("Fit to the model comes in square to the view's working angle", () => {
    const m = new Log(createDemoModel());
    m.ok({ type: "create_3d_view", viewId: "v-3d", name: "3D" });
    m.ok({ type: "set_working_angle", angleDeg: -20 });
    m.ok({ type: "set_3d_crop_box", viewId: "v-3d", fit: "model" });
    expect(view(m.head, "v-3d").props?.cropBox3d?.rotationDeg).toBeCloseTo(-20, 6);
  });
});
