/**
 * @jest-environment node
 *
 * Split a run, then resize one side: only that side changes and a transition
 * (a reducer on pipe) goes in at the split. Tab widens piece -> stretch ->
 * run -> branch -> system. Fails on the kernel before the stretch rung
 * existed (Tab went straight from a split half to the whole run, and there
 * was no "stretch" scope kind).
 */
import {
  DEFAULT_SETTINGS,
  builtinPartType,
  executeCommand,
  selectionScopes,
  scopeOf,
  type Command,
  type LibraryEntry,
  type ModelState,
  type RunFitting,
  type RunSegment,
  type RunSize,
} from "../src";

const FT = 304.8;
const IN = 25.4;

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type} refused: ${r.error.message}`);
  return r.model;
}

function seg(m: ModelState, id: string): RunSegment {
  const el = m.elements[id];
  if (el?.kind !== "run_segment") throw new Error(`${id} is ${el?.kind ?? "missing"}`);
  return el;
}

const transitions = (m: ModelState): RunFitting[] => Object.values(m.elements).filter((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === "transition");
const sorted = (ids: readonly string[]) => [...ids].sort();

function level(): ModelState {
  const m: ModelState = { modelId: "split-resize", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

/** An open L: 30 ft east, then 20 ft north, split 15 ft along the east leg. */
function splitL(domain: "duct" | "pipe", size: RunSize, system: { id: string; kind: "supply_air" | "domestic_cold_water"; name: string }): ModelState {
  let m = level();
  m = run(m, { type: "route_run", idPrefix: "l", levelId: "lvl-1", domain, size, elevationMm: 10 * FT, system, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }, { x: 30 * FT, y: 20 * FT }] });
  return run(m, { type: "split_run", idPrefix: "cut", segmentId: "l-s1", atMm: 15 * FT });
}

describe("split, then resize one side", () => {
  const RECT = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
  const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

  it("split leaves two separately selectable pieces of one stretch", () => {
    const m = splitL("duct", RECT, SA);
    expect(seg(m, "l-s1").links.end?.elementId).toBe("cut-s1");
    expect(selectionScopes(m, "l-s1")[0]).toEqual({ kind: "element", ids: ["l-s1"] });
    expect(selectionScopes(m, "cut-s1")[0]).toEqual({ kind: "element", ids: ["cut-s1"] });
  });

  it("resizing the selected half changes only that half and puts a transition at the split", () => {
    const m = splitL("duct", RECT, SA);
    const out = run(m, { type: "resize_stretch", idPrefix: "rs", segmentIds: ["l-s1"], size: { shape: "rect", width: 8 * IN, height: 10 * IN } });
    expect(seg(out, "l-s1").size).toEqual({ shape: "rect", width: 8 * IN, height: 10 * IN });
    expect(seg(out, "cut-s1").size).toEqual(RECT);
    expect(seg(out, "l-s2").size).toEqual(RECT);
    const added = transitions(out);
    expect(added).toHaveLength(1);
    expect(added[0]?.label).toBe("Transition");
    expect(added[0]?.family).toBeTruthy();
    expect(sorted(added[0]?.ports.map((p) => p.link?.elementId ?? "") ?? [])).toEqual(["cut-s1", "l-s1"]);
  });

  it("whole-run resize (what the panel used to send) takes both halves and the next leg, which is why it no longer backs a single-piece Resize", () => {
    const m = splitL("duct", RECT, SA);
    const out = run(m, { type: "resize_run", segmentId: "l-s1", profile: { shape: "rect", width: 8 * IN, height: 10 * IN } });
    expect(seg(out, "cut-s1").size.shape === "rect" && seg(out, "cut-s1").size).toMatchObject({ width: 8 * IN });
    expect(seg(out, "l-s2").size).toMatchObject({ width: 8 * IN });
  });

  it("refuses with the reason when the transition doesn't fit beside the split, and changes nothing", () => {
    let m = level();
    m = run(m, { type: "route_run", idPrefix: "s", levelId: "lvl-1", domain: "duct", size: RECT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 2 * FT, y: 0 }] });
    m = run(m, { type: "split_run", idPrefix: "cut", segmentId: "s-s1", atMm: 1 * FT });
    const r = executeCommand(m, { type: "resize_stretch", idPrefix: "rs", segmentIds: ["s-s1"], size: { shape: "rect", width: 40 * IN, height: 30 * IN } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("min_straight_length");
    expect(r.error.message).toMatch(/doesn't fit/);
  });

  it("works for pipe: one side takes the new size, a reducer goes in, the material is kept", () => {
    const COPPER_1 = { shape: "pipe" as const, nominalMm: 25.4, material: "copper" as const };
    const m = splitL("pipe", COPPER_1, { id: "sys-cw", kind: "domestic_cold_water", name: "Cold water" });
    const out = run(m, { type: "resize_stretch", idPrefix: "rs", segmentIds: ["cut-s1"], size: { shape: "pipe", nominalMm: 19.05, material: "copper" } });
    expect(seg(out, "cut-s1").size).toEqual({ shape: "pipe", nominalMm: 19.05, material: "copper" });
    expect(seg(out, "l-s1").size).toEqual(COPPER_1);
    expect(seg(out, "l-s2").size).toEqual(COPPER_1);
    const added = transitions(out).filter((f) => f.ports.some((p) => p.link?.elementId === "l-s1"));
    expect(added).toHaveLength(1);
    expect(added[0]?.label).toBe("Reducer");
  });
});

describe("Tab ladder: piece -> stretch -> run -> branch -> system", () => {
  const RTU = builtinPartType("builtin:rtu-5-ton@1") as LibraryEntry;
  const DIFFUSER = builtinPartType("builtin:supply-diffuser-24@1") as LibraryEntry;
  const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

  /** RTU -> trunk -> SD-A, a branch tapped off the trunk to SD-B with one elbow, the branch's first leg split. */
  function system(): ModelState {
    let m = level();
    const place = (partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number) =>
      (m = run(m, { type: "place_part", partId, typeId: entry.id, ...(m.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm }));
    place("rtu", RTU, 0, 0, 12 * FT);
    place("sd-a", DIFFUSER, 30 * FT, 0, 8 * FT);
    place("sd-b", DIFFUSER, 20 * FT, 12 * FT, 8 * FT);
    m = run(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
    m = run(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 12 * FT }, { x: 20 * FT, y: 12 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
    const len = (() => {
      const s = seg(m, "br-s1");
      return Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z);
    })();
    return run(m, { type: "split_run", idPrefix: "cut", segmentId: "br-s1", atMm: len / 2 });
  }

  it("steps one rung at a time from a split half, each wider than the last", () => {
    const m = system();
    const scopes = selectionScopes(m, "br-s1");
    expect(scopes.map((s) => s.kind)).toEqual(["element", "stretch", "run", "branch", "system"]);
    for (let i = 1; i < scopes.length; i++) expect(scopes[i]?.ids.length ?? 0).toBeGreaterThan(scopes[i - 1]?.ids.length ?? 0);
    expect(sorted(scopeOf(m, "br-s1", "stretch"))).toEqual(["br-s1", "cut-s1"]);
    const run = scopeOf(m, "br-s1", "run");
    expect(run).toContain("cut-s1");
    expect(run.some((id) => m.elements[id]?.kind === "run_fitting" && (m.elements[id] as RunFitting).fittingType === "elbow")).toBe(true);
  });

  it("the stretch stops at a size change: after one half is resized it is its own stretch", () => {
    const m = system();
    const out = executeCommand(m, { type: "resize_stretch", idPrefix: "rs", segmentIds: ["cut-s1"], size: { shape: "round", diameter: 6 * IN } });
    if (!out.ok) throw new Error(out.error.message);
    expect(scopeOf(out.model, "br-s1", "stretch")).toEqual(["br-s1"]);
    expect(selectionScopes(out.model, "br-s1").map((s) => s.kind)).not.toContain("stretch");
  });

  it("an unsplit leg between fittings has no separate stretch rung (it would select the same piece)", () => {
    const m = system();
    const kinds = selectionScopes(m, "trunk-s1").map((s) => s.kind);
    expect(kinds[0]).toBe("element");
    expect(kinds).not.toContain("stretch");
  });

  it("a fitting has no stretch: elbow -> run -> branch -> system", () => {
    const m = system();
    const elbow = Object.values(m.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === "elbow" && el.systemId === "sys-sa" && el.ports.some((p) => p.link?.elementId?.startsWith("br-") || p.link?.elementId === "cut-s1"));
    if (!elbow) throw new Error("fixture has no branch elbow");
    expect(selectionScopes(m, elbow.id).map((s) => s.kind)).toEqual(["element", "run", "branch", "system"]);
  });
});
