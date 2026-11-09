/**
 * @jest-environment node
 *
 * Project coordinates: the project base point, survey point and true north.
 * Commands go through planCommit like every other edit, so they are
 * attributed, conflict on the same fields and undo per person. Moving the
 * point only never changes an element's shared coordinates; relocating the
 * project changes every element's by the same move; neither moves geometry.
 */
import {
  SITE_ID,
  applyChangeset,
  bearingDeg,
  canonicalJson,
  commandSchema,
  executeCommand,
  modelToShared,
  planCommit,
  sharedToModel,
  siteMapConversion,
  siteMatrixMetres,
  siteOf,
  trueNorthInPlan,
  type Changeset,
  type ModelState,
  type SitePoint,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const FT = 304.8;
const NOW = () => "2026-10-20T00:00:00.000Z";
const AVERY = { id: "avery", name: "Avery", kind: "human" as const };
const PRIYA = { id: "priya", name: "Priya", kind: "human" as const };
let seq = 0;

class Log {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(actor: typeof AVERY, command: RawCommand, base: number = this.head.revision) {
    seq += 1;
    const req = { idempotencyKey: `site-key-${seq}`, baseRevision: base, actor, command: commandSchema.parse(command), clientSessionId: `tab-${actor.id}` };
    const d = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (d.ok) {
      expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }
  ok(actor: typeof AVERY, command: RawCommand, base?: number): Changeset {
    const d = this.submit(actor, command, base);
    if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
    return d.changeset;
  }
}

function refused(model: ModelState, command: RawCommand): string {
  const r = executeCommand(model, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

const near = (a: number, b: number, tol = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(tol);
function nearShared(a: ReturnType<typeof modelToShared>, b: ReturnType<typeof modelToShared>) {
  near(a.eastWest, b.eastWest);
  near(a.northSouth, b.northSouth);
  near(a.elevation, b.elevation);
}

/** A duct corner somewhere in the demo model, to watch its shared coordinates. */
const WATCHED: SitePoint = { x: 16 * FT, y: 4 * FT, z: 9 * FT };

describe("default site", () => {
  it("is the identity: shared coordinates equal model coordinates and plan north is true north", () => {
    const site = siteOf(createDemoModel());
    expect(createDemoModel().elements[SITE_ID]).toBeUndefined();
    nearShared(modelToShared(site, WATCHED), { eastWest: WATCHED.x, northSouth: WATCHED.y, elevation: WATCHED.z });
    expect(trueNorthInPlan(site)).toEqual({ x: 0, y: 1 });
  });
});

describe("set_project_origin", () => {
  it("move point only: the point moves, every element keeps its shared coordinates, geometry does not move", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_project_origin", mode: "relocate_project", shared: { eastWest: 245025.5 * FT, northSouth: 549851.1 * FT, elevation: 64.8 * FT } });
    const sharedBefore = modelToShared(siteOf(m.head), WATCHED);
    const geometryBefore = canonicalJson(Object.values(m.head.elements).filter((e) => e.kind !== "site"));
    m.ok(AVERY, { type: "set_project_origin", mode: "move_point", position: { x: 10 * FT, y: -3 * FT, z: 0 } });
    const site = siteOf(m.head);
    expect(site.basePoint).toEqual({ x: 3048, y: -914.4, z: 0 });
    nearShared(modelToShared(site, WATCHED), sharedBefore);
    // The point's own coordinates follow from where it now sits.
    nearShared(site.basePointShared, { eastWest: (245025.5 + 10) * FT, northSouth: (549851.1 - 3) * FT, elevation: 64.8 * FT });
    expect(canonicalJson(Object.values(m.head.elements).filter((e) => e.kind !== "site"))).toBe(geometryBefore);
  });

  it("relocate project: every element's shared coordinates move by the same amount; the survey point stays on the site", () => {
    const m = new Log(createDemoModel());
    const surveySharedBefore = modelToShared(siteOf(m.head), siteOf(m.head).surveyPoint);
    const before = modelToShared(siteOf(m.head), WATCHED);
    m.ok(AVERY, { type: "set_project_origin", mode: "relocate_project", shared: { eastWest: 1000 * FT, northSouth: 2000 * FT, elevation: 50 * FT } });
    const site = siteOf(m.head);
    nearShared(modelToShared(site, WATCHED), { eastWest: before.eastWest + 1000 * FT, northSouth: before.northSouth + 2000 * FT, elevation: before.elevation + 50 * FT });
    nearShared(modelToShared(site, site.surveyPoint), surveySharedBefore);
    expect(site.surveyPoint).toEqual({ x: -1000 * FT, y: -2000 * FT, z: -50 * FT });
  });

  it("relocate by dragging (new position, same coordinates) moves the building on the site by the opposite of the drag", () => {
    const m = new Log(createDemoModel());
    const before = modelToShared(siteOf(m.head), WATCHED);
    m.ok(AVERY, { type: "set_project_origin", mode: "relocate_project", position: { x: 5 * FT, y: 0, z: 0 } });
    nearShared(modelToShared(siteOf(m.head), WATCHED), { ...before, eastWest: before.eastWest - 5 * FT });
  });

  it("says plainly what it needs", () => {
    const model = createDemoModel();
    expect(refused(model, { type: "set_project_origin", mode: "move_point" })).toBe("Say where the project base point goes (a model position)");
    expect(refused(model, { type: "set_project_origin", mode: "move_point", position: { x: 1, y: 1, z: 0 }, shared: { eastWest: 0, northSouth: 0, elevation: 0 } })).toMatch(/relocate the project instead/);
    expect(refused(model, { type: "set_project_origin", mode: "relocate_project" })).toBe("Give the project base point's new coordinates or its new position");
    expect(refused(model, { type: "set_project_origin", mode: "move_point", position: { x: 0, y: 0, z: 0 } })).toBe("Nothing would change: the coordinates are already that");
  });
});

describe("set_true_north", () => {
  it("turns the building on the site about the base point: the base point keeps its coordinates, others rotate", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_project_origin", mode: "move_point", position: { x: 10 * FT, y: 0, z: 0 } });
    const baseShared = siteOf(m.head).basePointShared;
    m.ok(AVERY, { type: "set_true_north", angleDeg: 30 });
    const site = siteOf(m.head);
    expect(site.trueNorthDeg).toBe(30);
    nearShared(modelToShared(site, site.basePoint), baseShared);
    // A point 10 ft plan-north of the base point is 30° west of true north from it: x = −10 sin 30°, y = 10 cos 30°.
    const p = modelToShared(site, { x: 10 * FT, y: 10 * FT, z: 0 });
    near(p.eastWest - baseShared.eastWest, -10 * FT * Math.sin(Math.PI / 6));
    near(p.northSouth - baseShared.northSouth, 10 * FT * Math.cos(Math.PI / 6));
    // True north in plan points 30° clockwise of plan north.
    near(trueNorthInPlan(site).x, 0.5);
    near(trueNorthInPlan(site).y, Math.sqrt(3) / 2);
  });

  it("two-point pick: from a point toward another", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_true_north", from: { x: 0, y: 0 }, to: { x: 1000, y: 1000 } });
    expect(siteOf(m.head).trueNorthDeg).toBe(45);
    expect(bearingDeg({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(-90);
    expect(refused(m.head, { type: "set_true_north", from: { x: 5, y: 5 }, to: { x: 5, y: 5 } })).toMatch(/same/);
    expect(refused(m.head, { type: "set_true_north", angleDeg: 10, from: { x: 0, y: 0 }, to: { x: 0, y: 1 } })).toBe("Give an angle or two points, not both");
  });

  it("normalizes to (−180, 180]", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_true_north", angleDeg: 390 });
    expect(siteOf(m.head).trueNorthDeg).toBe(30);
    m.ok(AVERY, { type: "set_true_north", angleDeg: -180 });
    expect(siteOf(m.head).trueNorthDeg).toBe(180);
  });
});

describe("set_survey_point", () => {
  it("move point only: the marker moves, the site does not", () => {
    const m = new Log(createDemoModel());
    const before = modelToShared(siteOf(m.head), WATCHED);
    m.ok(AVERY, { type: "set_survey_point", mode: "move_point", position: { x: 3 * FT, y: 4 * FT, z: 0 } });
    expect(siteOf(m.head).surveyPoint).toEqual({ x: 914.4, y: 1219.2, z: 0 });
    nearShared(modelToShared(siteOf(m.head), WATCHED), before);
  });

  it("relocate project: the survey point reads the typed coordinates and everything shifts with it", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_true_north", angleDeg: -12 });
    m.ok(AVERY, { type: "set_survey_point", mode: "relocate_project", shared: { eastWest: 245025.5 * FT, northSouth: 549851.1 * FT, elevation: 64.8 * FT } });
    const site = siteOf(m.head);
    nearShared(modelToShared(site, site.surveyPoint), { eastWest: 245025.5 * FT, northSouth: 549851.1 * FT, elevation: 64.8 * FT });
    expect(site.trueNorthDeg).toBe(-12);
    expect(site.basePoint).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("collaboration", () => {
  it("is attributed, undoable per person, and undo of the first edit brings the default site back", () => {
    const m = new Log(createDemoModel());
    const cs = m.ok(AVERY, { type: "set_true_north", angleDeg: 30 });
    expect(cs.actor.id).toBe("avery");
    expect(cs.authored.map((w) => w.field)).toEqual(["trueNorthDeg"]);
    const priyaUndo = m.submit(PRIYA, { type: "undo", revision: cs.revision });
    expect(!priyaUndo.ok && priyaUndo.error.message).toMatch(/only undo your own/);
    const undone = m.ok(AVERY, { type: "undo", revision: cs.revision });
    expect(m.head.elements[SITE_ID]).toBeUndefined();
    expect(siteOf(m.head).trueNorthDeg).toBe(0);
    m.ok(AVERY, { type: "undo", revision: undone.revision });
    expect(siteOf(m.head).trueNorthDeg).toBe(30);
  });

  it("two people setting true north from the same revision conflict instead of the last one winning", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_true_north", angleDeg: 10 });
    const base = m.head.revision;
    m.ok(AVERY, { type: "set_true_north", angleDeg: 30 }, base);
    const late = m.submit(PRIYA, { type: "set_true_north", angleDeg: 45 }, base);
    expect(late.ok).toBe(false);
    expect(!late.ok && late.error.code).toBe("conflict");
    expect(siteOf(m.head).trueNorthDeg).toBe(30);
  });

  it("undo is refused once someone else changed the site since", () => {
    const m = new Log(createDemoModel());
    const mine = m.ok(AVERY, { type: "set_true_north", angleDeg: 30 });
    m.ok(PRIYA, { type: "set_project_origin", mode: "move_point", position: { x: FT, y: 0, z: 0 } });
    const undo = m.submit(AVERY, { type: "undo", revision: mine.revision });
    expect(!undo.ok && undo.error.code).toBe("undo_refused");
  });
});

describe("export placement", () => {
  it("the map conversion an export writes is the same transform as model → shared", () => {
    const m = new Log(createDemoModel());
    m.ok(AVERY, { type: "set_project_origin", mode: "relocate_project", position: { x: 2 * FT, y: 3 * FT, z: 0 }, shared: { eastWest: 1e6, northSouth: 2e6, elevation: 3e4 } });
    m.ok(AVERY, { type: "set_true_north", angleDeg: 30 });
    const site = siteOf(m.head);
    const mc = siteMapConversion(site);
    const p = WATCHED;
    // IfcMapConversion: E = Eastings + x·cos − y·sin; N = Northings + x·sin + y·cos (metres).
    const e = mc.eastings + (p.x / 1000) * mc.xAxisAbscissa - (p.y / 1000) * mc.xAxisOrdinate;
    const n = mc.northings + (p.x / 1000) * mc.xAxisOrdinate + (p.y / 1000) * mc.xAxisAbscissa;
    const s = modelToShared(site, p);
    near(e * 1000, s.eastWest);
    near(n * 1000, s.northSouth);
    near((mc.orthogonalHeight + p.z / 1000) * 1000, s.elevation);
    const rows = siteMatrixMetres(site);
    near(rows[0][0] * p.x + rows[0][1] * p.y + rows[0][3] * 1000, s.eastWest);
    nearShared(modelToShared(site, sharedToModel(site, s)), s);
  });
});
