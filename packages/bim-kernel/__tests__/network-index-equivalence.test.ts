/**
 * @jest-environment node
 *
 * The first commit on a freshly loaded head pays for the topology index and
 * for the whole-head derive and validate checks that let later commits look
 * only at what they touch. Those were made cheaper (slot arrays instead of a
 * map entry per element; read-only checks instead of a full recompute). This
 * file holds them to what they replaced:
 *
 * - the slot index answers every query exactly like the map-based index,
 *   including dangling ids, holes, shared tables, cycles and two parents;
 * - `isFullyDerived` agrees with `recomputeDerived(...).changedIds.length === 0`;
 * - a cold head with a defect elsewhere still accepts an unrelated first commit
 *   and reports full validation's issues as still open (bug log #18: one
 *   invalid run used to freeze every edit), an edit to the defect is refused
 *   naming it, and a stale derived value anywhere is still repaired by that
 *   commit.
 */
import {
  BUILTIN_PART_TYPES,
  asConnectionId,
  asElementId,
  draftElements,
  executeCommand,
  freezeElements,
  isFullyDerived,
  planCommit,
  plainElements,
  recomputeDerived,
  validateModel,
  warmModel,
  type BimElement,
  type Command,
  type CommandRequest,
  type Connection,
  type ConnectorEnd,
  type ElementId,
  type ModelState,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { NetworkIndex } from "../src/network";
import { NetworkIndex as MapNetworkIndex } from "./reference/network-index";
import { airflowOf } from "@permitzip/bim-pack-mechanical";
import { HEAVY_TIERS, createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;
const NOW = () => "2026-10-22T00:00:00.000Z";
const ENDS: readonly ConnectorEnd[] = ["start", "end", "in", "out", "branch", "host"];

/** Same data, fresh objects: what a server holds after reading storage (no identity caches). */
function cold(model: ModelState): ModelState {
  return structuredClone({ ...model, elements: plainElements(model.elements) });
}

function el<K extends BimElement["kind"]>(model: ModelState, id: string, kind: K): Extract<BimElement, { kind: K }> {
  const found = model.elements[id];
  if (!found || found.kind !== kind) throw new Error(`fixture ${id} is not a ${kind}`);
  return found as Extract<BimElement, { kind: K }>;
}

function withElements(model: ModelState, changes: Record<string, BimElement>): ModelState {
  return { ...model, elements: { ...plainElements(model.elements), ...changes } };
}

function link(id: string, a: string, aEnd: ConnectorEnd, b: string, bEnd: ConnectorEnd): Connection {
  return { id: asConnectionId(id), a: { elementId: asElementId(a), end: aEnd }, b: { elementId: asElementId(b), end: bEnd } };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Every id either index could be asked about: elements, connection ends, hosts, references, and ids nobody has. */
function probeIds(model: ModelState): ElementId[] {
  const ids = new Set<string>(Object.keys(model.elements));
  for (const c of model.connections) {
    ids.add(c.a.elementId);
    ids.add(c.b.elementId);
  }
  for (const e of Object.values(model.elements)) {
    if (e.kind === "tap" || e.kind === "opening") ids.add(e.hostId);
    if (e.kind === "tag") ids.add(e.targetId);
    if (e.kind === "dimension") {
      ids.add(e.aId);
      ids.add(e.bId);
    }
  }
  ids.add("no-such-element");
  ids.add("");
  return [...ids].map(asElementId);
}

function expectSameIndex(model: Pick<ModelState, "elements" | "connections">, probe: readonly ElementId[] = probeIds(model as ModelState)): void {
  const slots = new NetworkIndex(model.connections, model.elements);
  const maps = new MapNetworkIndex(model.connections, model.elements);
  expect(slots.isTree).toBe(maps.isTree);
  expect(slots.order).toBe(maps.order);
  expect(slots.disconnected()).toEqual(maps.disconnected());
  for (const id of probe) {
    expect([id, slots.children(id)]).toEqual([id, maps.children(id)]);
    expect([id, slots.parent(id)]).toEqual([id, maps.parent(id)]);
    expect([id, slots.hostedTaps(id)]).toEqual([id, maps.hostedTaps(id)]);
    expect([id, slots.dependents(id)]).toEqual([id, maps.dependents(id)]);
    const conns = slots.connectionsOf(id);
    expect(conns.length).toBe(maps.connectionsOf(id).length);
    conns.forEach((c, i) => expect(c).toBe(maps.connectionsOf(id)[i]));
    expect(slots.connectionPositionsOf(id).map((pos) => model.connections[pos])).toEqual([...conns]);
    for (const end of ENDS) expect(slots.connectionAt(id, end)).toBe(maps.connectionAt(id, end));
    expect([id, slots.airflowRank(id)]).toEqual([id, maps.airflowRank(id)]);
  }
  const risers = new Set<string>();
  for (const e of Object.values(model.elements)) if (e.kind === "riser_segment") risers.add(e.riserId);
  for (const r of [...risers, "no-such-riser"]) expect(slots.riserSegments(r)).toEqual(maps.riserSegments(r));
  const r = rng(probe.length);
  for (let i = 0; i < 25; i++) {
    const subset = probe.filter(() => r() < 0.05);
    expect(slots.sortByAirflow(subset)).toEqual(maps.sortByAirflow(subset));
  }
  expect(slots.sortByAirflow([])).toEqual(maps.sortByAirflow([]));
}

const XS = createFullBimModel(FULL_BIM_TIERS.XS);

describe("slot topology index answers exactly like the map-based index", () => {
  it("demo, tier S and the full-BIM XS building", () => {
    expectSameIndex(createDemoModel());
    expectSameIndex(createHeavyModel(HEAVY_TIERS.S));
    expectSameIndex(cold(XS));
  }, 120_000);

  it("connections, taps and references to ids that have no element", () => {
    const seg = el(XS, "L01-Z1-air-t1-s1", "duct_segment");
    const tap = el(XS, "L01-Z1-air-t1-s1-b1-tap", "tap");
    const tag = el(XS, "L01-Z1-door-101-tag", "tag");
    const model = withElements(XS, {
      [tap.id]: { ...tap, hostId: asElementId("ghost-host") },
      [tag.id]: { ...tag, targetId: asElementId("ghost-target") },
    });
    const connections = [...XS.connections, link("c-ghost-1", seg.id, "end", "ghost-a", "start"), link("c-ghost-2", "ghost-b", "out", "ghost-c", "in")];
    expectSameIndex({ elements: model.elements, connections });
  });

  it("removed elements (holes in a shared store) and keys a later revision appended", () => {
    const base = freezeElements(plainElements(XS.elements));
    const removed = draftElements(base);
    delete removed["L01-Z1-air-t1-s2"];
    delete removed["L01-Z1-door-101"];
    const holed = freezeElements(removed);
    expectSameIndex({ elements: holed, connections: XS.connections }, probeIds(XS));
    // A sibling appends a key to the shared table after `base` exists; `base` must not see it.
    const sibling = draftElements(base);
    const part = el(XS, "L01-Z1-air-t1-src", "equipment");
    sibling["appended-later"] = { ...part, id: asElementId("appended-later") };
    freezeElements(sibling);
    expectSameIndex({ elements: base, connections: [...XS.connections, link("c-late", "appended-later", "out", "L01-Z1-air-t1-s1", "start")] }, [...probeIds(XS), asElementId("appended-later")]);
  });

  it("not a tree: two parents, a cycle, a self loop, equipment under equipment", () => {
    const demo = createDemoModel();
    const segments = Object.values(demo.elements).filter((e) => e.kind === "duct_segment");
    const terminals = Object.values(demo.elements).filter((e) => e.kind === "terminal");
    const units = Object.values(demo.elements).filter((e) => e.kind === "equipment");
    const free = (id: string, end: ConnectorEnd) => !demo.connections.some((c) => (c.a.elementId === id && c.a.end === end) || (c.b.elementId === id && c.b.end === end));
    const leaf = segments.find((s) => free(s.id, "end"));
    const first = segments[0];
    const terminal = terminals[0];
    const unit = units[0];
    if (!leaf || !first || !terminal || !unit) throw new Error("demo fixture changed");
    const variants: Connection[][] = [
      [...demo.connections, link("x-two-parents", leaf.id, "end", terminal.id, "in")],
      [...demo.connections, link("x-cycle", leaf.id, "end", first.id, "start")],
      [...demo.connections, link("x-self", leaf.id, "end", leaf.id, "start")],
      [...demo.connections, link("x-nested-unit", leaf.id, "end", unit.id, "in")],
    ];
    for (const connections of variants) {
      const maps = new MapNetworkIndex(connections, demo.elements);
      expect(maps.isTree).toBe(false);
      expectSameIndex({ elements: demo.elements, connections });
    }
  });

  it("numeric ids keep plain-object key order", () => {
    const demo = createDemoModel();
    const unit = Object.values(demo.elements).find((e) => e.kind === "equipment");
    if (!unit) throw new Error("demo fixture changed");
    const elements = { ...plainElements(demo.elements), "12": { ...unit, id: asElementId("12") }, "3": { ...unit, id: asElementId("3") } };
    expectSameIndex({ elements, connections: [...demo.connections, link("x-3", "3", "out", "12", "in")] });
  });
});

/** XS with routed runs: a level, a diffuser and a run up out of its neck. */
function withRoutedRun(): ModelState {
  const diffuser = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
  if (!diffuser) throw new Error("starter library has no air terminal");
  const commands: Command[] = [
    { type: "create_level", levelId: "rr-level", name: "RR", elevationMm: 0 },
    { type: "place_part", partId: "rr-part", typeId: diffuser.id, partType: diffuser.definition, levelId: "rr-level", zone: "Z1", position: { x: 10 * FT, y: 10 * FT }, offsetMm: 9 * FT },
    {
      type: "route_run",
      idPrefix: "rr-run",
      levelId: "rr-level",
      zone: "Z1",
      domain: "duct",
      size: { shape: "round", diameter: 10 * 25.4 },
      elevationMm: 11 * FT,
      system: { id: "rr-sys", kind: "supply_air", name: "RR supply" },
      points: [{ x: 10 * FT, y: 16 * FT }, { x: 14 * FT, y: 16 * FT }],
      from: { kind: "part", partId: "rr-part", connectorId: "neck" },
    },
  ];
  let model = XS;
  for (const command of commands) {
    const result = executeCommand(model, command);
    if (!result.ok) throw new Error(`fixture command ${command.type} refused: ${result.error.message}`);
    model = result.model;
  }
  return model;
}

describe("isFullyDerived agrees with a full recompute", () => {
  const routed = withRoutedRun();

  function expectAgrees(model: ModelState): boolean {
    const expected = recomputeDerived(cold(model)).changedIds.length === 0;
    expect(isFullyDerived(cold(model))).toBe(expected);
    return expected;
  }

  it("on consistent models", () => {
    expect(expectAgrees(createDemoModel())).toBe(true);
    expect(expectAgrees(createHeavyModel(HEAVY_TIERS.S))).toBe(true);
    expect(expectAgrees(XS)).toBe(true);
    expect(expectAgrees(routed)).toBe(true);
  }, 120_000);

  it("on every kind of stale derived value", () => {
    const tap = el(XS, "L01-Z1-air-t1-s1-b1-tap", "tap");
    const seg = el(XS, "L01-Z1-air-t1-s2", "duct_segment");
    const unit = el(XS, "L01-Z1-air-t1-src", "equipment");
    const dev = el(XS, "L01-Z1-air-t1-s1-b1-dev", "terminal");
    const door = el(XS, "L01-Z1-door-101", "opening");
    const tag = el(XS, "L01-Z1-door-101-tag", "tag");
    const dim = el(XS, "L01-Z1-dim-room-1", "dimension");
    const stale: ModelState[] = [
      withElements(XS, { [tap.id]: { ...tap, position: { x: tap.position.x + 1, y: tap.position.y } } }),
      withElements(XS, { [seg.id]: { ...seg, flowCfm: (airflowOf(seg) ?? 0) + 1 } }),
      withElements(XS, { [seg.id]: { ...seg, flowCfm: (airflowOf(seg) ?? 0) + 1e-9 } }),
      withElements(XS, { [unit.id]: { ...unit, totalCfm: (airflowOf(unit) ?? 0) - 1 } }),
      withElements(XS, { [dev.id]: { ...dev, cfm: (airflowOf(dev) ?? 0) + 17.25 } }),
      withElements(XS, { [door.id]: { ...door, position: { x: door.position.x, y: door.position.y + 3 } } }),
      withElements(XS, { [tag.id]: { ...tag, position: { x: tag.position.x + 2, y: tag.position.y } } }),
      withElements(XS, { [dim.id]: { ...dim, valueMm: dim.valueMm + 5 } }),
    ];
    const run = Object.values(routed.elements).find((e) => e.kind === "run_segment");
    if (!run || run.kind !== "run_segment") throw new Error("routed fixture has no run segment");
    stale.push(withElements(routed, { [run.id]: { ...run, flow: run.flow + 50 } }));
    for (const model of stale) expect(expectAgrees(model)).toBe(false);
  }, 120_000);

  it("on a graph that is not a tree (falls back to the recompute itself)", () => {
    const demo = createDemoModel();
    const leaf = Object.values(demo.elements).find((e) => e.kind === "duct_segment" && !demo.connections.some((c) => (c.a.elementId === e.id && c.a.end === "end") || (c.b.elementId === e.id && c.b.end === "end")));
    const terminal = Object.values(demo.elements).find((e) => e.kind === "terminal");
    if (!leaf || !terminal) throw new Error("demo fixture changed");
    expectAgrees({ ...demo, connections: [...demo.connections, link("x-two-parents", leaf.id, "end", terminal.id, "in")] });
  });
});

describe("the first commit on a cold head: open issues elsewhere, derived values repaired", () => {
  // An edit in L02-Z2, far from every defect below (all in L01-Z1).
  const tapId = "L02-Z2-air-t1-s1-b1-tap";
  const edit: Command = { type: "slide_branch", tapId, s: el(XS, tapId, "tap").s + 0.5 * FT };
  const request: CommandRequest = { idempotencyKey: "cold-first-commit", baseRevision: XS.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command: edit };

  it("the edit commits on the clean building", () => {
    const decision = planCommit(cold(XS), [], request, NOW);
    expect(decision.ok).toBe(true);
  });

  const seg = el(XS, "L01-Z1-air-t1-s1", "duct_segment");
  const tap = el(XS, "L01-Z1-air-t1-s1-b1-tap", "tap");
  const tap2 = el(XS, "L01-Z1-air-t1-s1-b2-tap", "tap");
  const elbow = el(XS, "L01-Z1-air-t1-s1-b1-elbow", "elbow");
  const wall = el(XS, "L01-Z1-wh0-0", "wall");
  const door = el(XS, "L01-Z1-door-101", "opening");
  const tag = el(XS, "L01-Z1-door-101-tag", "tag");
  const dim = el(XS, "L01-Z1-dim-room-1", "dimension");
  const sheet = el(XS, "L01-Z1-sheet-A", "sheet");
  const feed = XS.connections.find((c) => c.b.elementId === "L01-Z1-air-t1-s1-b1-dev" || c.a.elementId === "L01-Z1-air-t1-s1-b1-dev");
  if (!feed) throw new Error("fixture terminal has no connection");

  const defects: Array<[string, ModelState]> = [
    ["an open connection", withElements(XS, { [elbow.id]: { ...elbow, position: { x: elbow.position.x + 40, y: elbow.position.y } } })],
    ["mismatched sizes with no transition", withElements(XS, { [seg.id]: { ...seg, profile: { shape: "round", diameter: 300 } } })],
    ["a segment shorter than the minimum straight", withElements(XS, { [seg.id]: { ...seg, end: { x: seg.start.x + 10, y: seg.end.y } } })],
    ["a segment that is not orthogonal", withElements(XS, { [seg.id]: { ...seg, end: { x: seg.end.x, y: seg.end.y + 500 } } })],
    ["a tap at the end of its host", withElements(XS, { [tap.id]: { ...tap, s: 1 } })],
    ["two taps too close", withElements(XS, { [tap2.id]: { ...tap2, s: tap.s + 1 } })],
    ["a branch as wide as its host", withElements(XS, { [tap.id]: { ...tap, profile: seg.profile } })],
    ["a tap with no host", withElements(XS, { [tap.id]: { ...tap, hostId: asElementId("ghost-host") } })],
    ["a terminal fed by nothing", { ...XS, connections: XS.connections.filter((c) => c !== feed) }],
    ["a wall shorter than 100 mm", withElements(XS, { [wall.id]: { ...wall, end: { x: wall.start.x + 50, y: wall.start.y } } })],
    ["a door outside its wall", withElements(XS, { [door.id]: { ...door, offset: -1000 } })],
    ["a tag on nothing", withElements(XS, { [tag.id]: { ...tag, targetId: asElementId("ghost-target") } })],
    ["a dimension to nothing", withElements(XS, { [dim.id]: { ...dim, aId: asElementId("ghost-a") } })],
    ["a sheet placing a view that does not exist", withElements(XS, { [sheet.id]: { ...sheet, viewIds: [...sheet.viewIds, asElementId("ghost-view")] } })],
  ];

  it.each(defects)("an unrelated edit commits and reports full validation's issues as still open: %s", (_name, broken) => {
    expect(validateModel(cold(broken)).length).toBeGreaterThan(0);
    // The edit adds no issue of its own, so what stays open is full validation of the head with every derived value recomputed.
    const issues = validateModel(recomputeDerived(cold(broken)).model);
    expect(issues.length).toBeGreaterThan(0);

    const direct = executeCommand(cold(broken), edit);
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(direct.openIssues).toEqual(validateModel(direct.model));
    if (direct.ok) expect(direct.openIssues?.map((i) => i.code)).toEqual(issues.map((i) => i.code));

    const decision = planCommit(cold(broken), [], request, NOW);
    expect(decision.ok).toBe(true);

    // Same verdict when the head was warmed at startup instead.
    const warmed = cold(broken);
    warmModel(warmed);
    const afterWarm = executeCommand(warmed, edit);
    expect(afterWarm.ok).toBe(true);
  });

  it("an edit to the element with the open issue is refused, naming that issue", () => {
    const broken = withElements(XS, { [wall.id]: { ...wall, end: { x: wall.start.x + 50, y: wall.start.y } } });
    const result = executeCommand(cold(broken), { type: "move_wall", wallId: wall.id, delta: { x: 0, y: 10 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("min_straight_length");
    expect(result.error.elementIds).toEqual([wall.id]);
    expect(result.error.message).toMatch(/open issue: ".*shorter than the 100 mm minimum wall"\. Fix that issue first/);
  });

  it("a connection to an element that does not exist still fails the commit the way full validation throws", () => {
    const broken: ModelState = { ...XS, connections: [...XS.connections, link("c-ghost", seg.id, "end", "ghost", "start")] };
    expect(() => validateModel(cold(broken))).toThrow("Element ghost does not exist");
    const result = executeCommand(cold(broken), edit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "element_not_found", message: "Element ghost does not exist" });
  });

  it("a stale derived value elsewhere is repaired by the first commit, as the full recompute would", () => {
    const stale = el(XS, "L01-Z1-air-t1-s2", "duct_segment");
    const otherTag = el(XS, "L01-Z1-door-102-tag", "tag");
    const broken = withElements(XS, {
      [stale.id]: { ...stale, flowCfm: (airflowOf(stale) ?? 0) + 25 },
      [otherTag.id]: { ...otherTag, position: { x: otherTag.position.x + 7, y: otherTag.position.y } },
    });
    const result = executeCommand(cold(broken), edit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changedIds).toEqual(expect.arrayContaining([stale.id, otherTag.id]));
    expect(result.model.elements[stale.id]).toMatchObject({ flowCfm: stale.flowCfm });
    expect(result.model.elements[otherTag.id]).toMatchObject({ position: otherTag.position });
    expect(recomputeDerived(result.model).changedIds).toEqual([]);
  });
});
