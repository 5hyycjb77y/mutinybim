/**
 * @jest-environment node
 *
 * One load concept with a lifecycle (ROADMAP F2, P1 core; product decision, Oct 27,
 * decision 4): a load exists before anything is drawn, moves from a row to a
 * pipe end to a fixture and keeps its id, and every list shows progress.
 * Today's `lp:<host>:<port>` ids stay valid; the run graph finds loads through
 * the load index, not by building an id.
 *
 * Golden numbers: 7329 Corner Cafe SD3 plumbing loads (loads-7329-fixture.ts).
 */
import { DEFAULT_SETTINGS, RequirementsEngine, allocate, allocationPolicyOf, applyChangeset, asElementId, builtinPartType, canonicalJson, executeCommand, fixedSpaceLocator, loadIndexOf, loadIndexStats, loadPointAt, loadPointId, planCommit, progressLine, servesOf, sourceOf, type BimElement, type Changeset, type Command, type LoadPointElement, type ModelState, type RunSegment, type Space } from "../src";
import { plumbingDrawnSource } from "@permitzip/bim-pack-plumbing";
import { STACK_TOTALS, stackLoadPointCommand, threeStoreyStack } from "./fixtures/three-storey-stack";
import { CAFE_GAS, CAFE_TOTALS, cafeFixtureLoads } from "./loads-7329-fixture";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-27T18:00:00.000Z";
const copper = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };

class Model {
  head: ModelState = { modelId: "loads", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  private seq = 0;
  summary: readonly string[] = [];

  submit(command: Command) {
    const run = executeCommand(this.head, command, { history: this.log, actorId: "avery" });
    this.summary = run.ok ? (run.summary ?? []) : [];
    const d = planCommit(this.head, [], { idempotencyKey: `loads-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
    if (d.ok) {
      expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }

  ok(command: Command): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    return d.changeset;
  }

  refused(command: Command): { code: string; message: string } {
    const d = this.submit(command);
    if (d.ok) throw new Error(`${command.type} was expected to be refused`);
    return d.error;
  }

  undo(cs: Changeset): Changeset {
    return this.ok({ type: "undo", revision: cs.revision });
  }

  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
    return el;
  }

  load(id: string): LoadPointElement {
    const el = this.head.elements[id];
    if (el?.kind !== "load_point") throw new Error(`${id} is not a load`);
    return el;
  }
}

function starter(id: string) {
  const t = builtinPartType(id);
  if (!t) throw new Error(`no starter type ${id}`);
  return t;
}

/** The ids a changeset changed, for `advance`. */
const changed = (cs: Changeset): string[] => [...cs.elements.map((e) => e.id), ...(cs.removedIds ?? [])];

/** Commit, then bring the engine up to the new head. */
function step(m: Model, engine: RequirementsEngine, command: Command): void {
  const cs = m.ok(command);
  engine.advance(m.head, changed(cs));
}

function stack(): { m: Model; ids: ReturnType<typeof threeStoreyStack>["ids"]; points: ReturnType<typeof threeStoreyStack>["points"] } {
  const m = new Model();
  const b = threeStoreyStack();
  for (const c of b.setup) m.ok(c);
  m.ok(stackLoadPointCommand(b.points));
  return { m, ids: b.ids, points: b.points };
}

describe("old load points read, size and edit as before", () => {
  it("every lp: id still names its point, sits on its end and sizes its pipe", () => {
    const { m, ids, points } = stack();
    const wc = points.find((p) => p.connectionType === "WC-FT");
    if (!wc) throw new Error("fixture has a WC");
    const id = loadPointId(wc.hostId, wc.port);
    expect(id).toBe(`lp:${wc.hostId}:${wc.port}`);
    expect(loadPointAt(m.head.elements, wc.hostId, wc.port)?.id).toBe(id);
    // No record migration: the stored shape is exactly today's (host, no anchor).
    expect(m.load(id).host).toEqual({ elementId: wc.hostId, port: wc.port });
    expect(m.load(id).anchor).toBeUndefined();
    expect(m.seg(ids.stack.replace(/-s\d+$/, "-s4")).flow).toBe(STACK_TOTALS.dfuBase);
    // The old command names still work with the old ids.
    m.ok({ type: "edit_load_point", loadPointId: id, note: "verify trap arm" });
    expect(m.load(id).note).toBe("verify trap arm");
  });

  it("a moved lp: load keeps its id; the pipe stops carrying it, and carries it again when it comes back", () => {
    const { m, ids, points } = stack();
    const wc = points.find((p) => p.connectionType === "WC-FT" && p.hostId.startsWith("san-L1"));
    if (!wc) throw new Error("fixture has a level 1 WC on sanitary");
    const id = loadPointId(wc.hostId, wc.port);
    const base = ids.stack.replace(/-s\d+$/, "-s4");
    expect(m.seg(base).flow).toBe(30);
    m.ok({ type: "move_load", loadId: id, to: { kind: "none" } });
    expect(m.head.elements[id]?.kind).toBe("load_point");
    expect(m.load(id).host).toBeUndefined();
    expect(m.load(id).anchor).toEqual({ kind: "none" });
    expect(loadPointAt(m.head.elements, wc.hostId, wc.port)).toBeNull();
    expect(m.seg(base).flow).toBe(26);
    m.ok({ type: "move_load", loadPointId: id, to: { kind: "run_end", hostId: wc.hostId, port: wc.port } });
    expect(m.load(id).host).toEqual({ elementId: wc.hostId, port: wc.port });
    expect(m.load(id).anchor).toBeUndefined();
    expect(m.seg(base).flow).toBe(30);
  });
});

describe("the load index replaces the computed id", () => {
  it("a load with a generated id on a run end is found by the run graph and sizes the pipe (old code built lp: ids and missed it)", () => {
    const { m, ids, points } = stack();
    const wc = points.find((p) => p.connectionType === "WC-FT" && p.hostId.startsWith("san-L1"));
    if (!wc) throw new Error("fixture has a level 1 WC");
    const base = ids.stack.replace(/-s\d+$/, "-s4");
    m.ok({ type: "move_load", loadId: loadPointId(wc.hostId, wc.port), to: { kind: "none" } });
    expect(m.seg(base).flow).toBe(26);
    m.ok({ type: "create_load", loads: [{ id: "load-wc-new", anchor: { kind: "run_end", hostId: wc.hostId, port: wc.port }, connectionType: "WC-FT", mark: "WC-1-9" }] });
    expect(loadPointAt(m.head.elements, wc.hostId, wc.port)?.id).toBe("load-wc-new");
    expect(m.seg(base).flow).toBe(30);
  });

  it("keeps one load per open end: a second is refused, naming the one there", () => {
    const { m, points } = stack();
    const p = points[0];
    if (!p) throw new Error("fixture has points");
    const e = m.refused({ type: "create_load", loads: [{ id: "load-dup", anchor: { kind: "run_end", hostId: p.hostId, port: p.port }, connectionType: p.connectionType }] });
    expect(e.code).toBe("already_exists");
    expect(e.message).toContain("already has a load point");
  });

  it("is carried from each edit's changed ids, not rebuilt per revision", () => {
    const { m, points } = stack();
    loadIndexOf(m.head.elements);
    const before = loadIndexStats.builds;
    for (let i = 0; i < 5; i++) m.ok({ type: "edit_load_point", loadId: loadPointId(points[0]?.hostId ?? "", points[0]?.port ?? ""), note: `n${i}` });
    m.ok({ type: "create_load", loads: [{ id: "load-row-1", values: { dfu: 2 } }] });
    loadIndexOf(m.head.elements);
    expect(loadIndexStats.builds).toBe(before);
  });
});

/** The 7329 rows typed as a table, with no pipe. */
function cafe(): { m: Model; engine: RequirementsEngine } {
  const m = new Model();
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_load", loads: cafeFixtureLoads() });
  m.ok({ type: "create_load", loads: CAFE_GAS.map((g) => ({ id: `load-gas-${g.tag}`, mark: g.tag, note: g.description, service: "gas" as const, values: { mbh: g.mbh } })) });
  return { m, engine: new RequirementsEngine({ drawnSource: plumbingDrawnSource }) };
}

describe("7329 Corner Cafe: the load table before any pipe", () => {
  it("35 fixture rows give 25.75 cold / 13.5 hot / 30.25 WSFU, 79 DFU, 140 gal/h; gas rows 859 CFH", () => {
    const { m, engine } = cafe();
    const t = engine.counted(m.head);
    expect([t.wsfu_cold, t.wsfu_hot, t.wsfu_total, t.dfu, t.gph_demand]).toEqual([CAFE_TOTALS.cold, CAFE_TOTALS.hot, CAFE_TOTALS.total, CAFE_TOTALS.dfu, CAFE_TOTALS.gph]);
    // Natural gas at the kernel's 1,000 Btu/cf: MBH × 1,000 / 1,000.
    expect((t.mbh * 1000) / 1000).toBe(CAFE_TOTALS.gasCfh);
    const p = engine.progress(m.head);
    expect(p.total).toBe(CAFE_TOTALS.fixtures + CAFE_GAS.length);
    expect(p.byStatus.open).toBe(p.total);
    expect(p.byStage.estimate).toBe(p.total);
  });

  it("piping five rows moves progress to 5 piped and leaves the totals unchanged; each pipe carries its row", () => {
    const { m, engine } = cafe();
    const before = engine.counted(m.head);
    engine.progress(m.head);
    const rows = ["load-WC-1", "load-WC-2", "load-LV-1", "load-LV-2", "load-P41-1"];
    const cold = [5, 5, 1.5, 1.5, 1.5];
    rows.forEach((row, i) => {
      const x = (i + 1) * 3 * FT;
      step(m, engine, { type: "route_run", idPrefix: `cw-r${i}`, levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: 3 * FT, system: CW, points: [{ x, y: 0 }, { x, y: 10 * FT }] });
      step(m, engine, { type: "move_load", loadId: row, to: { kind: "run_end", hostId: `cw-r${i}-s1`, port: "end" } });
    });
    const p = engine.progress(m.head);
    expect(p.byStatus.connected).toBe(5);
    expect(progressLine({ ...p, total: CAFE_TOTALS.fixtures })).toBe("Loads: 35 · 5 piped · 0 attached");
    expect(engine.counted(m.head)).toEqual(before);
    rows.forEach((row, i) => {
      expect(m.load(row).id).toBe(row);
      expect(m.seg(`cw-r${i}-s1`).flow).toBe(cold[i]);
    });
    // The engine moved by deltas and agrees with one built from scratch.
    const fresh = new RequirementsEngine({ drawnSource: plumbingDrawnSource });
    expect(fresh.progress(m.head)).toEqual(p);
    expect(fresh.counted(m.head)).toEqual(engine.counted(m.head));
    expect(engine.stats.built).toBe(1);
  });

  it("a row served by the grease interceptor is something GI-1 serves before any pipe, and its source", () => {
    const { m } = cafe();
    const gi = starter("builtin:plumbing-grease-interceptor@1");
    m.ok({ type: "place_part", partId: "gi-1", typeId: gi.id, partType: gi.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "GI-1" });
    m.ok({ type: "edit_load_point", loadId: "load-P434A-1", servedBy: "gi-1" });
    const giEl = m.head.elements["gi-1"] as BimElement;
    expect(servesOf(m.head.elements, giEl)).toContain("load-P434A-1");
    expect(sourceOf(m.head.elements, m.load("load-P434A-1"))).toBe("gi-1");
    const engine = new RequirementsEngine();
    expect(engine.progress(m.head, { kind: "source", id: asElementId("gi-1") }).total).toBe(1);
    expect(engine.statusOf(m.head, "load-P434A-1")?.status).toBe("assigned");
  });

  it("a source must serve something: a fixture can't be one", () => {
    const { m } = cafe();
    const wc = starter("builtin:plumbing-wc-flush-tank@1");
    m.ok({ type: "place_part", partId: "wc-1", typeId: wc.id, partType: wc.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "WC-1" });
    const e = m.refused({ type: "edit_load_point", loadId: "load-LV-1", servedBy: "wc-1" });
    expect(e.message).toContain("doesn't serve anything");
  });
});

describe("estimates and devices: allocated vs actual", () => {
  function kitchen(): { m: Model; locator: ReturnType<typeof fixedSpaceLocator> } {
    const m = new Model();
    // Spaces are drawn by the spaces module (k3); a typed space record stands in for one here.
    const space: Space = { id: asElementId("sp-kitchen"), kind: "space", version: 1, authoredRev: {}, number: "101", name: "Kitchen", levelId: asElementId("lvl-1"), bounds: { kind: "none" }, origin: { kind: "typed" } };
    m.head = { ...m.head, elements: { [space.id]: space } };
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const fryer = starter("builtin:plumbing-gas-fryer@1");
    m.ok({ type: "place_part", partId: "fry-1", typeId: fryer.id, partType: fryer.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "FRY-1" });
    m.ok({ type: "place_part", partId: "fry-2", typeId: fryer.id, levelId: "lvl-1", position: { x: 1000, y: 0 }, mark: "FRY-2" });
    return { m, locator: fixedSpaceLocator({ spaceOf: { "fry-1": asElementId("sp-kitchen"), "fry-2": asElementId("sp-kitchen") } }) };
  }

  it("an estimate counts until the devices inside it exceed it, per quantity; never both", () => {
    const { m, locator } = kitchen();
    const engine = new RequirementsEngine({ locator });
    m.ok({ type: "create_load", loads: [{ id: "est-gas", anchor: { kind: "space", id: "sp-kitchen" }, service: "gas", values: { mbh: 200 }, source: { kind: "engineer", ref: "kitchen allowance" } }] });
    engine.progress(m.head);
    expect(engine.counted(m.head).mbh).toBe(200);
    step(m, engine, { type: "create_load", loads: [{ id: "dev-fry-1", anchor: { kind: "part", partId: "fry-1", connector: "g" }, values: { mbh: 80 } }] });
    expect(engine.counted(m.head).mbh).toBe(200);
    expect(engine.allocatedActual(m.head, "est-gas")?.governing.mbh).toBe("allocated");
    step(m, engine, { type: "create_load", loads: [{ id: "dev-fry-2", anchor: { kind: "part", partId: "fry-2" }, values: { mbh: 150 } }] });
    // 80 + 150 = 230 > 200: the devices govern; the estimate no longer counts.
    expect(engine.counted(m.head).mbh).toBe(230);
    expect(engine.allocatedActual(m.head, "est-gas")?.governing.mbh).toBe("actual");
    expect(engine.statusOf(m.head, "dev-fry-1")?.stage).toBe("device");
    expect(engine.statusOf(m.head, "dev-fry-1")?.status).toBe("attached");
    // The naive sum (what a plain total did before) would count the estimate and the devices: 430.
    expect(allocate(m.head.elements, Object.values(m.head.elements).filter((e): e is LoadPointElement => e.kind === "load_point"), locator, "max").naive.mbh).toBe(430);
    expect(new RequirementsEngine({ locator }).counted(m.head)).toEqual(engine.counted(m.head));
  });

  it("the policy is a model setting: actual only, allocation only, back to max", () => {
    const { m, locator } = kitchen();
    m.ok({ type: "create_load", loads: [{ id: "est-gas", anchor: { kind: "space", id: "sp-kitchen" }, values: { mbh: 200 } }, { id: "dev-fry-1", anchor: { kind: "part", partId: "fry-1" }, values: { mbh: 80 } }] });
    expect(allocationPolicyOf(m.head.elements)).toBe("max");
    expect(new RequirementsEngine({ locator, policy: allocationPolicyOf(m.head.elements) }).counted(m.head).mbh).toBe(200);
    m.ok({ type: "set_load_allocation_policy", policy: "actual_only" });
    expect(new RequirementsEngine({ locator, policy: allocationPolicyOf(m.head.elements) }).counted(m.head).mbh).toBe(80);
    const cs = m.ok({ type: "set_load_allocation_policy", policy: "allocation_only" });
    expect(new RequirementsEngine({ locator, policy: allocationPolicyOf(m.head.elements) }).counted(m.head).mbh).toBe(200);
    m.undo(cs);
    expect(allocationPolicyOf(m.head.elements)).toBe("actual_only");
  });

  it("estimate → concentrated → device keeps one id; a lump breaks into pieces anywhere with totals unchanged", () => {
    const { m, locator } = kitchen();
    m.ok({ type: "create_load", loads: [{ id: "est-kitchen", anchor: { kind: "space", id: "sp-kitchen" }, values: { mbh: 300 } }] });
    const engine = new RequirementsEngine({ locator });
    expect(engine.statusOf(m.head, "est-kitchen")?.stage).toBe("estimate");
    m.ok({ type: "split_load", loadId: "est-kitchen", into: [{ id: "lp-fry-1", anchor: { kind: "point", levelId: "lvl-1", position: { x: 0, y: 0 } }, values: { mbh: 120 } }, { id: "lp-fry-2", anchor: { kind: "part", partId: "fry-2" }, values: { mbh: 100 } }] });
    expect(m.load("est-kitchen").values.mbh).toBe(80);
    expect(new RequirementsEngine({ locator }).statusOf(m.head, "lp-fry-1")?.stage).toBe("concentrated");
    m.ok({ type: "move_load", loadId: "lp-fry-1", to: { kind: "part", partId: "fry-1", connector: "g" } });
    const fresh = new RequirementsEngine({ locator });
    expect(fresh.statusOf(m.head, "lp-fry-1")?.stage).toBe("device");
    // 80 left on the estimate vs 220 in devices: the devices govern, nothing counted twice.
    expect(fresh.counted(m.head).mbh).toBe(220);
  });

  it("refuses density without rates or off a space, and a source that is gone reads as a mismatch", () => {
    const { m } = kitchen();
    expect(m.refused({ type: "create_load", loads: [{ id: "d1", anchor: { kind: "space", id: "sp-kitchen" }, basis: "density" }] }).message).toContain("needs its rates");
    expect(m.refused({ type: "create_load", loads: [{ id: "d2", basis: "density", rates: [{ key: "va", per: "area", value: 10 }] }] }).message).toContain("anchor it to a space or zone");
    expect(m.refused({ type: "create_load", loads: [{ id: "d3", anchor: { kind: "space", id: "nope" } }] }).code).toBe("element_not_found");
  });
});
