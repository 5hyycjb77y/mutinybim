/**
 * @jest-environment node
 *
 * A run routed from a diffuser before any unit feeds it, and the memo behind
 * fitting bodies. Before: the airflow of a run with no unit was counted from
 * whichever element id sorted first, so a freshly routed run showed 0 cfm on
 * the legs that carry the diffuser's air, and an offset whose ids sorted
 * earlier rewrote legs it never touched (the perf gate's delete_connected
 * changeset grew to 5). Fitting bodies were rebuilt on every solid rebuild.
 */
import {
  DEFAULT_SETTINGS,
  builtinPartType,
  fittingBody,
  planCommit,
  type BimElement,
  type Changeset,
  type Command,
  type LibraryEntry,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-20T00:00:00.000Z";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  ok(command: Command): Changeset {
    counter += 1;
    const base = this.head.revision;
    const d = planCommit(this.head, [], { idempotencyKey: `priya-${counter}-key`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command }, NOW, this.log);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    this.head = d.model;
    this.log.push(d.changeset);
    return d.changeset;
  }
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
    return el;
  }
  fit(id: string): RunFitting {
    const el = this.head.elements[id];
    if (el?.kind !== "run_fitting") throw new Error(`${id} is not a fitting`);
    return el;
  }
}

/** A diffuser at 9 ft and a 10" round run out of its neck: up to 11 ft, north 6 ft, east 4 ft. No unit anywhere. */
function routedFromDiffuser(): Model {
  const m = new Model({ modelId: "sourceless", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "place_part", partId: "sd", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 10 * FT, y: 10 * FT }, offsetMm: 9 * FT });
  m.ok({
    type: "route_run",
    idPrefix: "run",
    levelId: "lvl-1",
    domain: "duct",
    size: { shape: "round", diameter: 10 * IN },
    elevationMm: 11 * FT,
    system: { id: "sys-sa", kind: "supply_air", name: "Supply Air" },
    points: [{ x: 10 * FT, y: 16 * FT }, { x: 14 * FT, y: 16 * FT }],
    from: { kind: "part", partId: "sd", connectorId: "neck" },
  });
  return m;
}

const ids = (cs: Changeset): string[] => cs.elements.map((e) => e.id).sort();
/** Same content, new object identities, so nothing can come from the memo. */
function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x: unknown) => copy(x)) as T;
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) as T;
  return v;
}

describe("airflow on a run no unit feeds yet", () => {
  it("every leg carries the diffuser's air, counted from the run's open end", () => {
    const m = routedFromDiffuser();
    const neckLeg = m.seg("run-s1").flow;
    expect(neckLeg).toBeGreaterThan(0);
    expect(m.seg("run-s2").flow).toBe(neckLeg);
    expect(m.seg("run-s3").flow).toBe(neckLeg);
  });

  it("an offset whose ids sort first rewrites only what it builds and splits", () => {
    const m = routedFromDiffuser();
    const before = { s1: m.seg("run-s1"), s2: m.seg("run-s2") };
    const cs = m.ok({ type: "offset_run", idPrefix: "aa-jog", segmentId: "run-s3", atMm: 2.5 * FT, offset: { x: 0, y: 0, z: 6 * IN }, style: "45" });
    expect(ids(cs)).not.toContain("run-s1");
    expect(ids(cs)).not.toContain("run-s2");
    expect(m.seg("run-s1")).toBe(before.s1);
    expect(m.seg("run-s2")).toBe(before.s2);
    for (const id of ["aa-jog-s1", "aa-jog-s2", "run-s3"]) expect(m.seg(id).flow).toBe(before.s1.flow);
  });

  it("deleting the run's end leg changes the elbow it left and its new cap, nothing else", () => {
    const m = routedFromDiffuser();
    m.ok({ type: "offset_run", idPrefix: "jog", segmentId: "run-s3", atMm: 2.5 * FT, offset: { x: 0, y: 0, z: 6 * IN }, style: "45" });
    const cs = m.ok({ type: "delete_elements", ids: ["jog-s1"], policy: "cascade" });
    expect(ids(cs)).toEqual(["jog-f2", "jog-f2-cap-b"]);
    expect(m.fit("jog-f2-cap-b").fittingType).toBe("cap");
  });

  it("deleting a middle leg caps both open ends; the cut-off piece carries nothing; the diffuser's side is untouched", () => {
    const m = routedFromDiffuser();
    m.ok({ type: "offset_run", idPrefix: "jog", segmentId: "run-s3", atMm: 2.5 * FT, offset: { x: 0, y: 0, z: 6 * IN }, style: "45" });
    const kept = { s1: m.seg("run-s1"), s2: m.seg("run-s2") };
    const cs = m.ok({ type: "delete_elements", ids: ["run-s3"], policy: "cascade" });
    // Two elbows left open, a cap on each, and the two legs now joined to nothing that draws air.
    expect(ids(cs)).toEqual(["jog-f1", "jog-f1-cap-a", "jog-s1", "jog-s2", "run-f2", "run-f2-cap-b"]);
    expect(m.seg("jog-s1").flow).toBe(0);
    expect(m.seg("jog-s2").flow).toBe(0);
    expect(m.seg("run-s1")).toBe(kept.s1);
    expect(m.seg("run-s2")).toBe(kept.s2);
  });
});

describe("fitting bodies are reused only while what they were built from is unchanged", () => {
  it("returns the same body for the same fitting and elements, and equals a fresh build", () => {
    const m = routedFromDiffuser();
    for (const el of Object.values(m.head.elements)) {
      if (el.kind !== "run_fitting") continue;
      const body = fittingBody(m.head.elements, el);
      expect(fittingBody(m.head.elements, el)).toBe(body);
      const fresh = copy({ elements: m.head.elements, el });
      expect(fittingBody(fresh.elements, fresh.el)).toEqual(body);
    }
  });

  it("rebuilds when an element it read changes, though the fitting itself did not", () => {
    const m = routedFromDiffuser();
    const transition = Object.values(m.head.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "transition");
    if (!transition) throw new Error("route_run onto the 8\" neck should leave a transition");
    const cached = fittingBody(m.head.elements, transition);
    const linked = transition.ports.map((p) => p.link?.elementId).find((id) => id !== undefined && m.head.elements[id]?.kind === "run_segment");
    if (!linked) throw new Error("the transition should join a segment");
    const { [linked]: _gone, ...rest } = m.head.elements;
    const without: Record<string, BimElement> = rest;
    const rebuilt = fittingBody(without, transition);
    const fresh = copy({ elements: without, transition });
    expect(rebuilt).toEqual(fittingBody(fresh.elements, fresh.transition));
    expect(rebuilt).not.toEqual(cached);
    expect(fittingBody(m.head.elements, transition)).toEqual(cached);
  });
});
