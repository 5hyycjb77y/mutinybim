/**
 * @jest-environment node
 *
 * A fitting is pickable on a printed plan (batch 16-C follow-up). Before: a
 * straight run's pick strip ran right to the corner and a half width past it,
 * so the two legs covered the whole elbow and every click on the bend picked
 * a leg; the elbow, and with it the tee "+", could never be selected on paper.
 * Now a run's strip stops at the fittings on its ends.
 */
import { DEFAULT_SETTINGS, buildViewPickIndex, pickAt, planCommit, type Command, type ModelState, type ViewElement } from "../src";

const FT = 304.8;
const IN = 25.4;

function model(): ModelState {
  let m: ModelState = { modelId: "pick", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const ok = (command: Command) => {
    const d = planCommit(m, [], { idempotencyKey: `pk-${m.revision}`, baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-11-07T00:00:00.000Z");
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    m = d.model;
  };
  ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  // A 32"x14" run: east, a 90° elbow, then south.
  ok({ type: "route_run", idPrefix: "L", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 32 * IN, height: 14 * IN }, elevationMm: 10 * FT, system: { id: "sa", kind: "supply_air", name: "Supply Air 1" }, points: [{ x: 0, y: 20 * FT }, { x: 20 * FT, y: 20 * FT }, { x: 20 * FT, y: 0 }] });
  ok({ type: "create_view", viewId: "v", name: "Level 1 plan", viewType: "floor_plan", crop: { min: { x: -5 * FT, y: -5 * FT }, max: { x: 30 * FT, y: 30 * FT } }, props: { level: "Level 1", scale: 48 } });
  return m;
}

const elbowOf = (m: ModelState) => {
  const e = Object.values(m.elements).find((x) => x.kind === "run_fitting" && x.fittingType === "elbow");
  if (!e) throw new Error("no elbow");
  return e.id;
};

describe("picking on a printed plan", () => {
  it("a click on the bend picks the elbow first, at its corner and on the outside of the bend", () => {
    const m = model();
    const index = buildViewPickIndex(m, m.elements["v"] as ViewElement, null);
    const corner = { x: 20 * FT, y: 20 * FT };
    expect(pickAt(index, corner, 50)[0]).toBe(elbowOf(m));
    expect(pickAt(index, { x: corner.x + 3 * IN, y: corner.y + 3 * IN }, 50)[0]).toBe(elbowOf(m));
  });

  it("the straight legs still pick along their length, right up to the elbow", () => {
    const m = model();
    const index = buildViewPickIndex(m, m.elements["v"] as ViewElement, null);
    expect(pickAt(index, { x: 10 * FT, y: 20 * FT }, 50)[0]).toBe("L-s1");
    expect(pickAt(index, { x: 20 * FT, y: 10 * FT }, 50)[0]).toBe("L-s2");
    expect(pickAt(index, { x: 17 * FT, y: 20 * FT }, 50)[0]).toBe("L-s1");
  });

  it("after the elbow becomes a tee, the updated index matches one built from scratch (the legs are re-measured)", () => {
    const m = model();
    const view = m.elements["v"] as ViewElement;
    const previous = buildViewPickIndex(m, view, null);
    const elbow = m.elements[elbowOf(m)];
    if (elbow?.kind !== "run_fitting") throw new Error("elbow");
    const through = elbow.ports.find((p) => p.link?.elementId === "L-s1");
    const d = planCommit(m, [], { idempotencyKey: "pk-tee", baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "elbow_to_tee", fittingId: elbow.id, through: through?.id ?? "", idPrefix: "plus" } }, () => "2026-11-07T00:00:00.000Z");
    if (!d.ok) throw new Error(d.error.message);
    const updated = buildViewPickIndex(d.model, view, previous);
    const fresh = buildViewPickIndex(d.model, view, null);
    const shape = (i: typeof fresh) => [...i.footprints.entries()].map(([id, f]) => [id, f.min, f.max]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(shape(updated)).toEqual(shape(fresh));
  });
});
