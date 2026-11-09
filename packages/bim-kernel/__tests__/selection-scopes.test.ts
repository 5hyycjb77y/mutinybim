/**
 * @jest-environment node
 *
 * "Tab to select more": element -> run -> branch -> system around any piece
 * of a routed duct or pipe network, the parts linked to it, and the older
 * equipment-rooted trees. Fails on the kernel before these helpers existed
 * (no export called selectionScopes / branchOf / networkSystemOf).
 */
import {
  DEFAULT_SETTINGS,
  branchOf,
  builtinPartType,
  connectedRunOf,
  downstreamOf,
  executeCommand,
  networkSystemOf,
  scopeSummary,
  selectionScopes,
  type Command,
  type LibraryEntry,
  type ModelState,
  type RunFitting,
} from "../src";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";

const FT = 304.8;
const IN = 25.4;

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

function run(model: ModelState, command: Command): ModelState {
  const r = executeCommand(model, command);
  if (!r.ok) throw new Error(`${command.type} refused: ${r.error.message}`);
  return r.model;
}

function place(m: ModelState, partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number): ModelState {
  return run(m, { type: "place_part", partId, typeId: entry.id, ...(m.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm });
}

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

/** RTU -> trunk -> SD-1, with a branch tapped off the trunk to SD-2. */
function airSystem(): ModelState {
  let m: ModelState = { modelId: "scopes", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = place(m, "rtu", RTU, 0, 0, 12 * FT);
  m = place(m, "sd-a", DIFFUSER, 20 * FT, 0, 8 * FT);
  m = place(m, "sd-b", DIFFUSER, 10 * FT, 4 * FT, 8 * FT);
  m = run(m, {
    type: "route_run",
    idPrefix: "trunk",
    levelId: "lvl-1",
    domain: "duct",
    size: { shape: "rect", width: 14 * IN, height: 10 * IN },
    elevationMm: 10 * FT,
    system: SA,
    points: [],
    from: { kind: "part", partId: "rtu", connectorId: "supply" },
    to: { kind: "part", partId: "sd-a", connectorId: "neck" },
  });
  m = run(m, {
    type: "route_run",
    idPrefix: "br",
    levelId: "lvl-1",
    domain: "duct",
    size: { shape: "round", diameter: 8 * IN },
    elevationMm: 10 * FT,
    system: SA,
    points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 4 * FT }],
    from: { kind: "run_branch", segmentId: "trunk-s2" },
    to: { kind: "part", partId: "sd-b", connectorId: "neck" },
  });
  return m;
}

const sorted = (ids: readonly string[]) => [...ids].sort();
const routed = (m: ModelState, prefix: string) => Object.keys(m.elements).filter((k) => k.startsWith(prefix)).sort();

describe("selection scopes on a routed duct system", () => {
  const m = airSystem();
  const tap = Object.values(m.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.host?.segmentId === "trunk-s2");
  if (!tap) throw new Error("fixture has no tap on the trunk");
  const branchSegments = routed(m, "br-s");
  const lastBranchSeg = branchSegments[branchSegments.length - 1] ?? "";

  it("starts every cycle at the element itself", () => {
    expect(selectionScopes(m, "br-s1")[0]).toEqual({ kind: "element", ids: ["br-s1"] });
  });

  it("run: a branch segment's run is the branch's segments and in-line fittings, not the tap or the diffuser", () => {
    const ids = connectedRunOf(m, "br-s1");
    expect(ids[0]).toBe("br-s1");
    expect(sorted(ids)).toEqual(routed(m, "br-").filter((id) => id !== tap.id));
    expect(ids).not.toContain("sd-b");
  });

  it("run: the trunk's run stops at its takeoff and at the parts at both ends", () => {
    const ids = connectedRunOf(m, "trunk-s2");
    expect(sorted(ids)).toEqual(routed(m, "trunk-"));
    expect(ids).not.toContain(tap.id);
    expect(ids).not.toContain("rtu");
  });

  it("branch: from the takeoff to its terminal, whichever piece of the branch is hovered", () => {
    const expected = sorted([tap.id, ...routed(m, "br-").filter((id) => id !== tap.id), "sd-b"]);
    expect(sorted(branchOf(m, "br-s1"))).toEqual(expected);
    expect(sorted(branchOf(m, lastBranchSeg))).toEqual(expected);
    expect(sorted(branchOf(m, "sd-b"))).toEqual(expected);
    expect(branchOf(m, "br-s1")).not.toContain("trunk-s2");
  });

  it("system: every connected element, including both diffusers and the unit", () => {
    const all = sorted(networkSystemOf(m, "br-s1"));
    expect(all).toEqual(sorted([...routed(m, "trunk-"), ...routed(m, "br-"), tap.id, "rtu", "sd-a", "sd-b"].filter((v, i, a) => a.indexOf(v) === i)));
    expect(sorted(networkSystemOf(m, "rtu"))).toEqual(all);
  });

  it("collapses scopes that would select the same elements, so Tab always widens", () => {
    // On the trunk nothing is upstream of a takeoff: its branch is the whole system.
    expect(selectionScopes(m, "trunk-s2").map((s) => s.kind)).toEqual(["element", "run", "system"]);
    expect(selectionScopes(m, "br-s1").map((s) => s.kind)).toEqual(["element", "run", "branch", "system"]);
    for (const id of Object.keys(m.elements)) {
      const scopes = selectionScopes(m, id);
      for (let i = 1; i < scopes.length; i++) expect(scopes[i]?.ids.length).toBeGreaterThan(scopes[i - 1]?.ids.length ?? 0);
    }
  });

  it("the tap itself: element, then its branch, then the system", () => {
    expect(selectionScopes(m, tap.id).map((s) => s.kind)).toEqual(["element", "branch", "system"]);
  });

  it("elements outside any network only select themselves", () => {
    expect(selectionScopes(m, "lvl-1")).toEqual([{ kind: "element", ids: ["lvl-1"] }]);
    expect(selectionScopes(m, "nope")).toEqual([]);
  });

  it("summarises a scope: counts, length, flow entering and the system", () => {
    const s = scopeSummary(m, networkSystemOf(m, "br-s1"));
    expect(s.parts).toBe(3);
    expect(s.segments).toBe(routed(m, "trunk-s").length + branchSegments.length);
    expect(s.domain).toBe("duct");
    expect(s.systemIds).toEqual(["sys-sa"]);
    const trunkFlow = m.elements["trunk-s1"];
    expect(trunkFlow?.kind === "run_segment" ? trunkFlow.flow : -1).toBeGreaterThan(0);
    expect(s.flowEntering).toBe(trunkFlow?.kind === "run_segment" ? trunkFlow.flow : null);
    const b = scopeSummary(m, branchOf(m, "br-s1"));
    const br = m.elements["br-s1"];
    expect(b.flowEntering).toBe(br?.kind === "run_segment" ? br.flow : null);
    expect(b.flowEntering).toBeLessThan(s.flowEntering ?? 0);
  });

  it("is cached per element record and recomputed after an edit", () => {
    expect(selectionScopes(m, "br-s1")).toBe(selectionScopes(m, "br-s1"));
    const after = run(m, { type: "delete_elements", ids: [lastBranchSeg], policy: "cascade" });
    expect(networkSystemOf(after, "br-s1")).not.toContain("sd-b");
  });
});

describe("selection scopes on equipment-rooted trees", () => {
  const model = createFullBimModel({ floors: 1, zonesPerFloor: 1 });
  const tapEl = Object.values(model.elements).find((el) => el.kind === "tap");
  if (tapEl?.kind !== "tap") throw new Error("generated model has no tap");

  it("cycles element, run, branch, system from a branch segment", () => {
    const below = downstreamOf(model, tapEl.id)[0];
    expect(model.elements[below ?? ""]?.kind).toBe("duct_segment");
    const scopes = selectionScopes(model, below ?? "");
    expect(scopes.map((s) => s.kind)).toEqual(["element", "run", "branch", "system"]);
    const system = scopes[scopes.length - 1]?.ids ?? [];
    expect(system.some((id) => model.elements[id]?.kind === "equipment")).toBe(true);
    const branch = scopes.find((s) => s.kind === "branch")?.ids ?? [];
    expect(branch.some((id) => model.elements[id]?.kind === "terminal")).toBe(true);
    expect(branch.some((id) => model.elements[id]?.kind === "equipment")).toBe(false);
  });
});
