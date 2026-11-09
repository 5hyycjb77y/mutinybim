/**
 * @jest-environment node
 *
 * Load points (plumbing wave 1, P-A): a load on an open pipe end or a tap
 * without a fixture; a fixture attached later takes the point's connection
 * type and its plumbing values are the point's (one record); lumps break out
 * with totals unchanged; the trade-neutral connection-type catalog still
 * reads electrical records saved before trades. Golden numbers are the
 * issued 7492 sheet (fixtures/sample-market.ts).
 */
import { DEFAULT_SETTINGS, applyChangeset, builtinPartType, canonicalJson, connectionTypeQuantityWarnings, executeCommand, fieldText, resolveField, catalogElementId, connectionTypeOf, connectionTypeTrade, connectionTypes, connectionTypesOfTrade, loadPointFindings, loadPointId, loadPointPlacementRows, loadPointPosition, loadPointsOfPart, planCommit, readQuantityBag, readQuantityValue, recomputeDerived, type BimElement, type Changeset, type Command, type ModelState, type RunSegment, type ServiceCatalogElement } from "../src";
import { PipeHydraulicsEngine, pipeCarriesLine, PlumbingNetworkEngine, gasNetwork, type DrainageReport, type WaterReport } from "@permitzip/bim-pack-plumbing";
import { STACK_TOTALS, stackLoadPointCommand, threeStoreyStack } from "./fixtures/three-storey-stack";
import { buildGasLine, GAS_LINE_SYSTEM } from "./fixtures/gas-pe-line";
import { SAMPLE_MARKET_FIXTURES, SAMPLE_MARKET_SANITARY_RUNNING, SAMPLE_MARKET_TOTALS, sampleMarketLoadPointCommand, sampleMarket } from "./fixtures/sample-market";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-23T12:00:00.000Z";

class Model {
  head: ModelState = { modelId: "lp", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  private seq = 0;

  /** The plain-words summary of the last committed edit (what approval cards and the undo menu show). */
  summary: readonly string[] = [];

  submit(command: Command, key = `lp-key-${++this.seq}`) {
    const run = executeCommand(this.head, command, { history: this.log, actorId: "avery" });
    this.summary = run.ok ? (run.summary ?? []) : [];
    const d = planCommit(this.head, [], { idempotencyKey: key, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
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

  refused(command: Command): { code: string; message: string; elementIds: readonly string[] } {
    const d = this.submit(command);
    if (d.ok) throw new Error(`${command.type} was expected to be refused`);
    return d.error;
  }

  undo(cs: Changeset): void {
    this.ok({ type: "undo", revision: cs.revision });
  }

  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
    return el;
  }
}

function sampleMarketModel(): { m: Model; build: ReturnType<typeof sampleMarket>; placed: readonly string[] } {
  const m = new Model();
  const build = sampleMarket();
  for (const c of build.setup) m.ok(c);
  m.ok(sampleMarketLoadPointCommand(build.points));
  return { m, build, placed: m.summary };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

describe("trade-neutral connection-type catalog", () => {
  it("reads an electrical record saved before trades unchanged, and lists it only for electrical", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    // Exactly what main stored: no trade, no quantities, trade "electrical" on the element.
    const id = catalogElementId("connection_type", "E.05");
    const legacy: ServiceCatalogElement = {
      id,
      version: 1,
      authoredRev: {},
      kind: "service_catalog",
      trade: "electrical",
      entry: { type: "connection_type", designator: "E.05", description: "Reach-in freezer", connection: "5-20R receptacle", loadVa: 1320, voltage: 120, poles: 1, loadClass: "kitchen", continuous: false, comments: "" },
    };
    m.head = { ...m.head, elements: { ...m.head.elements, [id]: legacy } };
    const entry = connectionTypeOf(m.head.elements, "e.05");
    expect(entry).toEqual(legacy.entry);
    expect(entry && connectionTypeTrade(entry)).toBe("electrical");
    m.ok({ type: "save_connection_type", entry: { designator: "P01", trade: "plumbing", description: "Water closet", quantities: { wsfu_cold: 5, wsfu_total: 5, dfu: 5 } } });
    expect(connectionTypes(m.head).map((r) => r.entry.designator)).toEqual(["E.05", "P01"]);
    expect(connectionTypesOfTrade(m.head, "electrical").map((r) => r.entry.designator)).toEqual(["E.05"]);
    expect(connectionTypesOfTrade(m.head, "plumbing").map((r) => r.entry.designator)).toEqual(["P01"]);
    // A plumbing record needs no electrical fields; they default to "no electrical load".
    expect(connectionTypeOf(m.head.elements, "P01")).toMatchObject({ trade: "plumbing", loadVa: 0, quantities: { dfu: 5 } });
    expect((m.head.elements[catalogElementId("connection_type", "P01")] as ServiceCatalogElement).trade).toBe("plumbing");
  });

  it("refuses to delete a connection type a load point names, and renames follow onto the point", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "save_connection_type", entry: { designator: "FD3", trade: "plumbing", description: "Floor drain", quantities: { dfu: 5 } } });
    m.ok({ type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.ok({ type: "create_load_point", points: [{ hostId: "d-s1", port: "start", connectionType: "FD3", mark: "FD3-1" }] });
    const why = m.refused({ type: "delete_catalog_entry", entryType: "connection_type", name: "FD3" });
    expect(why.code).toBe("in_use");
    expect(why.message).toBe("Connection type FD3 is used by load point FD3-1; change it first");
    m.ok({ type: "save_connection_type", entry: { designator: "FD-3", trade: "plumbing", description: "Floor drain", quantities: { dfu: 5 } }, replaces: "FD3" });
    expect(m.head.elements[loadPointId("d-s1", "start")]).toMatchObject({ connectionType: "FD-3" });
    expect(m.seg("d-s1").flow).toBe(5);
  });
});

describe("Example A: Sample Market (7492) on load points", () => {
  it("the sheet adds up: 39 fixtures, 24 connection types, 37 / 15.75 / 43.25 WSFU, 88 DFU, 198 gal/h", () => {
    const sum = (f: (r: (typeof SAMPLE_MARKET_FIXTURES)[number]) => number) => r2(SAMPLE_MARKET_FIXTURES.reduce((a, r) => a + r.qty * f(r), 0));
    expect(SAMPLE_MARKET_FIXTURES.length).toBe(SAMPLE_MARKET_TOTALS.connectionTypes);
    expect(sum(() => 1)).toBe(SAMPLE_MARKET_TOTALS.fixtures);
    expect(sum((r) => r.cold)).toBe(SAMPLE_MARKET_TOTALS.cold);
    expect(sum((r) => r.hot)).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(sum((r) => r.total)).toBe(SAMPLE_MARKET_TOTALS.total);
    expect(sum((r) => r.dfu)).toBe(SAMPLE_MARKET_TOTALS.dfu);
    expect(sum((r) => r.gph)).toBe(SAMPLE_MARKET_TOTALS.gph);
  });

  it("places every fixture's points in one batch; the sanitary main carries 20 → 26 → 59 → 88 DFU to the outfall", () => {
    const { m, build, placed } = sampleMarketModel();
    expect(placed[0]).toMatch(/^Placed 55 load points \(/);
    expect(new Set(build.points.map((p) => p.mark)).size).toBe(39);
    expect(new Set(build.points.map((p) => p.connectionType)).size).toBe(24);
    expect(build.ids.sanLegs.map((id) => m.seg(id).flow)).toEqual([...SAMPLE_MARKET_SANITARY_RUNNING]);
    const report = new PipeHydraulicsEngine().report(m.head, "sys-san") as DrainageReport;
    expect(report.kind).toBe("drainage");
    expect(report.rootId).toBe("san-s4");
    const units = (id: string) => report.segments.find((s) => s.elementId === id)?.fixtureUnits;
    expect(build.ids.sanLegs.map(units)).toEqual([...SAMPLE_MARKET_SANITARY_RUNNING]);
    expect(report.warnings.filter((w) => /load point/i.test(w.message))).toEqual([]);
  });

  it("the cold service carries 43.25 WSFU total (not cold + hot), the hot system 15.75, the heater inlet its hot side", () => {
    const { m, build } = sampleMarketModel();
    expect(m.seg(build.ids.cwService).flow).toBe(SAMPLE_MARKET_TOTALS.total);
    expect(m.seg(build.ids.hwTrunk).flow).toBe(SAMPLE_MARKET_TOTALS.hot);
    expect(m.seg(build.ids.heaterInlet).flow).toBe(SAMPLE_MARKET_TOTALS.hot);
    const cw = new PipeHydraulicsEngine().report(m.head, "sys-cw") as WaterReport;
    const hw = new PipeHydraulicsEngine().report(m.head, "sys-hw") as WaterReport;
    expect(cw.segments.find((s) => s.elementId === build.ids.cwService)?.fixtureUnits).toBe(SAMPLE_MARKET_TOTALS.total);
    expect(hw.rootId).toBe("gwh");
    expect(hw.segments.find((s) => s.elementId === build.ids.hwTrunk)?.fixtureUnits).toBe(SAMPLE_MARKET_TOTALS.hot);
    // A cold-only branch carries its own cold units.
    expect(m.seg("cw-P01-1-s1").flow).toBe(5);
    expect(m.seg("cw-K01-1-s1").flow).toBe(1.5);
  });

  it("a hot-side edit reaches the cold service through the water heater", () => {
    const { m, build } = sampleMarketModel();
    const k04 = build.points.find((p) => p.mark === "K04-1" && p.system === "hot");
    if (!k04) throw new Error("no K04 hot point");
    m.ok({ type: "edit_load_point", loadPointId: loadPointId(k04.hostId, k04.port), values: { wsfu_hot: 3, wsfu_total: 3 } });
    expect(m.seg(build.ids.hwTrunk).flow).toBe(17.75);
    expect(m.seg(build.ids.cwService).flow).toBe(45.25);
  });
});

describe("attach a fixture: one record, two views", () => {
  it("attaching changes no total; editing the fixture's units edits its points and every total; undo restores both", () => {
    const { m, build } = sampleMarketModel();
    const wc = builtinPartType("builtin:plumbing-wc-flush-tank@1");
    if (!wc) throw new Error("no starter water closet");
    m.ok({ type: "place_part", partId: "p01-1", typeId: wc.id, partType: wc.definition, levelId: "lvl-1", position: { x: 70 * FT, y: -20 * FT }, offsetMm: 0, mark: "P01-1" });
    const san = build.points.find((p) => p.mark === "P01-1" && p.system === "sanitary");
    const cold = build.points.find((p) => p.mark === "P01-1" && p.system === "cold");
    if (!san || !cold) throw new Error("no P01-1 points");
    const sanId = loadPointId(san.hostId, san.port);
    const coldId = loadPointId(cold.hostId, cold.port);
    const before = [m.seg("san-s4").flow, m.seg(build.ids.cwService).flow];
    m.ok({ type: "attach_part_to_load_point", loadPointId: sanId, partId: "p01-1" });
    m.ok({ type: "attach_part_to_load_point", loadPointId: coldId, partId: "p01-1" });
    expect(m.summary[0]).toBe("Attached P01-1 to Load point P01-1 (Water closet); it takes the point's connection type and loads (totals unchanged)");
    expect(m.head.elements["p01-1"]).toMatchObject({ values: { connection_type: "P01" } });
    expect(loadPointsOfPart(m.head.elements, "p01-1").map((lp) => lp.id).sort()).toEqual([coldId, sanId].sort());
    expect([m.seg("san-s4").flow, m.seg(build.ids.cwService).flow]).toEqual(before);

    // Edit at the fixture: both of its points take the value; the totals move.
    const edit = m.ok({ type: "edit_load_point", partId: "p01-1", values: { wsfu_cold: 7, wsfu_total: 7, dfu: 6 } });
    expect(m.summary[0]).toMatch(/^Changed P01-1 \(fixture and its 2 load points\)/);
    expect(m.seg("san-s4").flow).toBe(89);
    expect(m.seg(build.ids.cwService).flow).toBe(45.25);
    expect(m.head.elements[coldId]).toMatchObject({ values: { wsfu_cold: 7 } });
    m.undo(edit);
    expect([m.seg("san-s4").flow, m.seg(build.ids.cwService).flow]).toEqual(before);
    expect((m.head.elements[coldId] as { values: object }).values).toEqual({});
  });

  it("a fixture routed into the same pipe as its point doesn't count twice", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const fd = builtinPartType("builtin:plumbing-floor-drain@1");
    if (!fd) throw new Error("no starter floor drain");
    m.ok({ type: "save_connection_type", entry: { designator: "FD", trade: "plumbing", description: "Floor drain", quantities: { dfu: 2 } } });
    m.ok({ type: "place_part", partId: "fd-1", typeId: fd.id, partType: fd.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: -1 * FT, mark: "FD-1", values: { connection_type: "FD" } });
    // The drain's own pipe, west to the outfall, and a branch into it with a load point for the same drain.
    m.ok({ type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -3 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }], from: { kind: "part", partId: "fd-1", connectorId: "w" } });
    const outfall = () => Object.values(m.head.elements).filter((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("d-")).reduce((a, e) => Math.max(a, e.flow), 0);
    const trunk = Object.values(m.head.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("d-") && Math.abs(e.start.y - e.end.y) < 1 && Math.abs(e.start.x - e.end.x) > 5 * FT);
    if (!trunk) throw new Error("no horizontal drain");
    m.ok({ type: "route_run", idPrefix: "x", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" }, system: { id: "san", kind: "sanitary" }, points: [{ x: 8 * FT, y: 6 * FT }, { x: 8 * FT, y: 0 }], to: { kind: "run_branch", segmentId: trunk.id } });
    m.ok({ type: "create_load_point", points: [{ hostId: "x-s1", port: "start", connectionType: "FD" }] });
    // Two drains: the modelled one (it names FD) and the point.
    expect(outfall()).toBe(4);
    // Attached, the point stands for the modelled drain: it counts once.
    m.ok({ type: "attach_part_to_load_point", loadPointId: loadPointId("x-s1", "start"), partId: "fd-1" });
    expect(outfall()).toBe(2);
  });
});

describe("lumps break out with totals unchanged", () => {
  function lump(): Model {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "k", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }] });
    for (let i = 1; i <= 6; i++) {
      m.ok({ type: "route_run", idPrefix: `b${i}`, levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" }, system: { id: "san", kind: "sanitary" }, points: [{ x: 5 * i * FT, y: 6 * FT }, { x: 5 * i * FT, y: 0 }], to: { kind: "run_branch", segmentId: "k-s1" } });
    }
    m.ok({ type: "create_load_point", points: [{ hostId: "k-s1", port: "start", values: { dfu: 30 }, mark: "Kitchen", schematic: true, note: "Kitchen lump" }] });
    return m;
  }

  it("one 30 DFU kitchen lump, broken out across 6 points: the main carries 30 before and after", () => {
    const m = lump();
    expect(m.seg("k-s1").flow).toBe(30);
    const cs = m.ok({ type: "split_load_point", loadPointId: loadPointId("k-s1", "start"), into: [1, 2, 3, 4, 5, 6].map((i) => ({ hostId: `b${i}-s1`, port: "start", values: { dfu: 5 }, mark: `K-${i}` })) });
    expect(m.summary[0]).toBe("Broke Load point Kitchen out onto 6 new load points; totals unchanged (the lump is used up and removed)");
    expect(m.seg("k-s1").flow).toBe(30);
    expect(m.head.elements[loadPointId("k-s1", "start")]).toBeUndefined();
    m.undo(cs);
    expect(m.head.elements[loadPointId("k-s1", "start")]).toMatchObject({ values: { dfu: 30 } });
    expect(m.head.elements[loadPointId("b1-s1", "start")]).toBeUndefined();
    expect(m.seg("k-s1").flow).toBe(30);
  });

  it("a partial break-out leaves the rest on the lump; taking more than it has is refused", () => {
    const m = lump();
    m.ok({ type: "split_load_point", loadPointId: loadPointId("k-s1", "start"), into: [{ hostId: "b1-s1", port: "start", values: { dfu: 12 } }] });
    expect(m.head.elements[loadPointId("k-s1", "start")]).toMatchObject({ values: { dfu: 18 } });
    expect(m.seg("k-s1").flow).toBe(30);
    const why = m.refused({ type: "split_load_point", loadPointId: loadPointId("k-s1", "start"), into: [{ hostId: "b2-s1", port: "start", values: { dfu: 20 } }] });
    expect(why).toEqual({ code: "invalid_value", message: "The new points take more than the lump has: drainage fixture units 20 of 18", elementIds: [loadPointId("k-s1", "start"), loadPointId("b2-s1", "start")] });
  });
});

describe("duct taps: a load point instead of an air device", () => {
  it("a 150 CFM point on a tap's open branch adds 150 to the trunk", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "t", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 300, height: 200 }, elevationMm: 3000, system: { id: "sa", kind: "supply_air" }, points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 200 }, system: { id: "sa", kind: "supply_air" }, points: [{ x: 3000, y: 2000 }, { x: 3000, y: 0 }], to: { kind: "run_branch", segmentId: "t-s1" } });
    const tap = Object.values(m.head.elements).find((e) => e.kind === "run_fitting" && e.host?.segmentId === "t-s1");
    if (tap?.kind !== "run_fitting") throw new Error("no tap");
    const before = m.seg("t-s1").flow;
    m.ok({ type: "create_load_point", points: [{ hostId: "br-s1", port: "start", values: { cfm: 150 }, mark: "Future diffuser" }] });
    expect(m.seg("t-s1").flow).toBe(before + 150);
    expect(m.seg("br-s1").flow).toBe(150);
  });
});

describe("hosts: follow, continue, lose", () => {
  it("a point is drawn at its pipe's end, follows the pipe, and is flagged (not deleted) when the pipe goes; undo puts it back", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.ok({ type: "create_load_point", points: [{ hostId: "d-s1", port: "start", connectionType: "FD", mark: "FD-1" }] });
    const lpId = loadPointId("d-s1", "start");
    const lp = m.head.elements[lpId];
    if (lp?.kind !== "load_point") throw new Error("no point");
    expect(loadPointPosition(m.head.elements, lp)?.point).toEqual(m.seg("d-s1").start);
    expect(loadPointFindings(m.head.elements)).toEqual([]);
    const del = m.ok({ type: "delete_elements", ids: ["d-s1"], policy: "disconnect" });
    expect(m.head.elements[lpId]).toBeDefined();
    expect(loadPointFindings(m.head.elements)).toEqual([{ code: "host_lost", message: "Load point FD-1 (Floor drain) lost its pipe (it was deleted), so it counts nowhere. Place it on another open end, or delete it", elementIds: [lpId] }]);
    m.undo(del);
    expect(loadPointFindings(m.head.elements)).toEqual([]);
    expect(m.seg("d-s1").flow).toBe(2);
  });

  it("refuses in plain words: a connected end, a second point, an unknown type; adds a starter type it names", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }] });
    expect(m.refused({ type: "create_load_point", points: [{ hostId: "d-s1", port: "end" }] }).code).toBe("in_use");
    expect(m.refused({ type: "create_load_point", points: [{ hostId: "d-s1", port: "start", connectionType: "ZZ9" }] }).message).toBe("There is no connection type ZZ9. Save it first (Connection types), or pick a starter one such as WC-FT, LAV or FD");
    m.ok({ type: "create_load_point", points: [{ hostId: "d-s1", port: "start", connectionType: "wc-ft" }] });
    expect(m.summary).toEqual(["Placed Load point WC-FT (Water closet, flush tank)", "Added connection type WC-FT (Water closet, flush tank) from the starter list"]);
    expect(connectionTypeOf(m.head.elements, "WC-FT")?.comments).toBe("Starter values, verify for permit work");
    expect(m.refused({ type: "create_load_point", points: [{ hostId: "d-s1", port: "start" }] }).code).toBe("already_exists");
  });

  it("a retried create can't make a second point: the point's id is its pipe end", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "d", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "san", kind: "sanitary" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    const cmd: Command = { type: "create_load_point", points: [{ hostId: "d-s1", port: "start", values: { dfu: 3 } }] };
    m.ok(cmd);
    expect(m.refused(cmd)).toEqual({ code: "already_exists", message: `That end already has a load point (${loadPointId("d-s1", "start")}); edit it instead`, elementIds: [loadPointId("d-s1", "start")] });
    expect(m.seg("d-s1").flow).toBe(3);
  });
});

describe("derived state stays consistent", () => {
  it("recomputing from scratch changes nothing on Example A", () => {
    const { m } = sampleMarketModel();
    expect(recomputeDerived(m.head).changedIds).toEqual([]);
    const els: Record<string, BimElement> = { ...m.head.elements };
    expect(Object.values(els).filter((e) => e.kind === "load_point").length).toBe(55);
  });
});

describe("the network engine, field paths and the Carries line agree", () => {
  it("engine totals equal the pipe flows; advance after one edit moves only that path and matches a fresh engine", () => {
    const { m, build } = sampleMarketModel();
    const engine = new PlumbingNetworkEngine();
    expect(engine.carries(m.head, build.ids.cwService)).toEqual({ systemId: "sys-cw", quantity: "wsfu_cold", value: 43.25 });
    expect(engine.carries(m.head, "san-s4")?.value).toBe(88);
    expect(engine.systemTotal(m.head, "sys-san")?.value).toBe(88);
    const fd2 = build.points.find((p) => p.mark === "FD2-1");
    if (!fd2) throw new Error("no FD2");
    const d = executeCommand(m.head, { type: "edit_load_point", loadPointId: loadPointId(fd2.hostId, fd2.port), values: { dfu: 4 } });
    if (!d.ok) throw new Error(d.error.message);
    const changed = engine.advance(d.model, d.changedIds);
    expect(engine.stats.deltas).toBe(1);
    expect(changed).toEqual(expect.arrayContaining(["san-s3", "san-s4"]));
    expect(changed).not.toContain("san-s2");
    expect(engine.carries(d.model, "san-s4")?.value).toBe(89);
    expect(new PlumbingNetworkEngine().carries(d.model, "san-s4")?.value).toBe(89);
  });

  it("field paths read the one record on a point and on its attached fixture; pipes read what they carry", () => {
    const { m, build } = sampleMarketModel();
    const k01 = build.points.find((p) => p.mark === "K01-1" && p.system === "cold");
    if (!k01) throw new Error("no K01");
    const lpId = loadPointId(k01.hostId, k01.port);
    expect(fieldText(m.head.elements, lpId, "load.wsfu_total")).toBe("2");
    expect(fieldText(m.head.elements, lpId, "connection_type.mark")).toBe("K01");
    expect(fieldText(m.head.elements, lpId, "connection_type.description")).toBe("Hand sink");
    expect(resolveField(m.head.elements, "san-s3", "pipe.carries.dfu").value).toBe(59);
    expect(resolveField(m.head.elements, "san-s1", "system.total.dfu").value).toBe(88);
    expect(resolveField(m.head.elements, build.ids.cwService, "pipe.carries.wsfu_cold").value).toBe(43.25);
    // A fixture attached to the point reads the same values.
    const hs = builtinPartType("builtin:plumbing-hand-sink@1");
    if (!hs) throw new Error("no hand sink");
    m.ok({ type: "place_part", partId: "k01-1", typeId: hs.id, partType: hs.definition, levelId: "lvl-1", position: { x: 4 * FT, y: 48 * FT }, offsetMm: 0, mark: "K01-1" });
    m.ok({ type: "attach_part_to_load_point", loadPointId: lpId, partId: "k01-1" });
    expect(fieldText(m.head.elements, "k01-1", "load.wsfu_cold")).toBe("1.5");
    expect(fieldText(m.head.elements, "k01-1", "connection_type.mark")).toBe("K01");
  });

  it("the Properties line on a pipe says what it carries, from the pipe report", () => {
    const { m } = sampleMarketModel();
    const engine = new PipeHydraulicsEngine();
    expect(pipeCarriesLine(engine, m.head, "san-s4")).toMatch(/^Carries 88 DFU · [\d.]+ gpm$/);
    expect(pipeCarriesLine(engine, m.head, "san-P04-1-s1")).toMatch(/^Carries 3 DFU · [\d.]+ gpm$/);
  });
});

describe("Example B: three-storey restroom stack", () => {
  it("10 DFU per floor, 30 at the stack base and the building drain; 39 WSFU at the cold service, 9 at the hot riser's base", () => {
    const m = new Model();
    const b = threeStoreyStack();
    for (const c of b.setup) m.ok(c);
    m.ok(stackLoadPointCommand(b.points));
    expect(b.ids.floorBranches.map((id) => m.seg(id).flow)).toEqual([STACK_TOTALS.dfuPerFloor, STACK_TOTALS.dfuPerFloor, STACK_TOTALS.dfuPerFloor]);
    expect(m.seg(b.ids.stack).flow).toBe(STACK_TOTALS.dfuBase);
    expect(m.seg(b.ids.drain).flow).toBe(STACK_TOTALS.dfuBase);
    expect(m.seg(b.ids.cwRiser).flow).toBe(STACK_TOTALS.cwService);
    expect(m.seg(b.ids.hwRiser).flow).toBe(STACK_TOTALS.hwBase);
    const report = new PipeHydraulicsEngine().report(m.head, "sys-san") as DrainageReport;
    expect(report.stacks.map((s) => s.fixtureUnits)).toContain(STACK_TOTALS.dfuBase);
    expect(new PipeHydraulicsEngine().report(m.head, "sys-vent")?.kind).toBe("not_calculated");
  });
});

/**
 * Bug log #36 (reference building 7352): a batch of points was placed with nothing
 * checking a point's connection type against its pipe's system, so a LAV
 * point could sit on a sanitary run as "cold" and nobody could tell from the
 * result which point went where. A type with no sign at all of a connection
 * of the pipe's system (no size for it, no quantity of its family) is
 * refused, naming the point; a type that may connect but adds nothing there
 * (a sheet row with only total WSFU, a flush-tank closet on hot water), or own
 * values the system doesn't count, is a warning; the per-point rows say pipe,
 * mark, type, system and loads.
 */
describe("a point's connection type against its pipe's system", () => {
  function pipes(): Model {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 0.75 * IN, material: "copper" }, elevationMm: 9 * FT, system: { id: "sys-cw", kind: "domestic_cold_water", name: "DCW-1" }, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "hw", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 0.75 * IN, material: "copper" }, elevationMm: 9 * FT, system: { id: "sys-hw", kind: "domestic_hot_water", name: "DHW-1" }, points: [{ x: 0, y: 2 * FT }, { x: 10 * FT, y: 2 * FT }] });
    m.ok({ type: "route_run", idPrefix: "san", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "sys-san", kind: "sanitary", name: "SAN-1" }, points: [{ x: 0, y: 4 * FT }, { x: 10 * FT, y: 4 * FT }] });
    return m;
  }

  it("refuses the batch when a type has no connection of the pipe's system, naming each point", () => {
    const m = pipes();
    const r = m.refused({
      type: "create_load_point",
      points: [
        { hostId: "cw-s1", port: "end", connectionType: "WC-FT", mark: "WC-1" },
        { hostId: "hw-s1", port: "end", connectionType: "FD", mark: "FD-2" },
        { hostId: "cw-s1", port: "start", connectionType: "FD", mark: "FD-1" },
      ],
    });
    expect(r.code).toBe("profile_incompatible");
    expect(r.message).toBe(
      "2 points don't fit their pipe's system: FD-2 on hw-s1 (DHW-1, domestic hot water): FD (Floor drain) has no hot water connection (it has waste, vent); FD-1 on cw-s1 (DCW-1, domestic cold water): FD (Floor drain) has no cold water connection (it has waste, vent). Put each on a pipe of a system its type connects to, or pick another type",
    );
    expect(m.head.elements[loadPointId("cw-s1", "end")]).toBeUndefined();
  });

  it("places what fits, and the rows say pipe, mark, type, system, loads and any warning", () => {
    const m = pipes();
    // A sheet row like Sample Market's P02 (1 DFU, 4 gal/h, no cold/hot split, no sizes): water is likely, so a warning, not a refusal.
    m.ok({ type: "save_connection_type", entry: { designator: "P02", trade: "plumbing", description: "Lavatory - ADA", quantities: { dfu: 1, gph_demand: 4 } } });
    m.ok({
      type: "create_load_point",
      points: [
        { hostId: "cw-s1", port: "end", connectionType: "LAV", mark: "LAV-1" },
        { hostId: "san-s1", port: "end", connectionType: "LAV", mark: "LAV-1", values: { wsfu_cold: 1.5 } },
        { hostId: "hw-s1", port: "end", connectionType: "WH-T", mark: "WH-1" },
        { hostId: "hw-s1", port: "start", connectionType: "WC-FT", mark: "WC-1" },
        { hostId: "cw-s1", port: "start", connectionType: "P02", mark: "P02-1" },
      ],
    });
    const ids = [loadPointId("cw-s1", "end"), loadPointId("san-s1", "end"), loadPointId("hw-s1", "end"), loadPointId("hw-s1", "start"), loadPointId("cw-s1", "start")];
    expect(loadPointPlacementRows(m.head.elements, ids)).toEqual([
      { id: ids[0], pipe_id: "cw-s1", mark: "LAV-1", type: "LAV", system: "DCW-1 (domestic cold water)", adds: "1.5 WSFU", loads: "WSFU 1.5 cold / 1.5 hot / 2 total, 1 DFU, 4 gal/h", warnings: [] },
      {
        id: ids[1],
        pipe_id: "san-s1",
        mark: "LAV-1",
        type: "LAV",
        system: "SAN-1 (sanitary)",
        adds: "1 DFU",
        loads: "WSFU 1.5 cold / 1.5 hot / 2 total, 1 DFU, 4 gal/h",
        warnings: ["Its own wsfu_cold (1.5 WSFU) doesn't count on SAN-1 (sanitary); this point adds 1 DFU there. If it is the fixture's cold water, put it on the cold water pipe"],
      },
      { id: ids[2], pipe_id: "hw-s1", mark: "WH-1", type: "WH-T", system: "DHW-1 (domestic hot water)", adds: "0 WSFU", loads: "199 MBH, min inlet 6.92 in. w.c. (0.25 psi)", warnings: ["WH-T (Water heater, tank) connects to DHW-1 (domestic hot water) but adds no hot water fixture units there"] },
      { id: ids[3], pipe_id: "hw-s1", mark: "WC-1", type: "WC-FT", system: "DHW-1 (domestic hot water)", adds: "0 WSFU", loads: "WSFU 5 cold / 0 hot / 5 total, 4 DFU", warnings: ["WC-FT (Water closet, flush tank) connects to DHW-1 (domestic hot water) but adds no hot water fixture units there"] },
      { id: ids[4], pipe_id: "cw-s1", mark: "P02-1", type: "P02", system: "DCW-1 (domestic cold water)", adds: "0 WSFU", loads: "1 DFU, 4 gal/h", warnings: ["P02 (Lavatory - ADA) connects to DCW-1 (domestic cold water) but adds no cold water fixture units there"] },
    ]);
  });
});

/**
 * Bug log #37 (b): min_inlet_pressure is psi, but the agent wrote 7 meaning
 * in. w.c. and got 193.9 in. w.c. (7 × 27.7). Text with a unit is read by the
 * unit library; a bare number stays in psi; a gas minimum above what a load
 * point takes is flagged.
 */
describe("quantities written with a unit", () => {
  it("reads '7 in w.c.', '2 psi', '0.5 kPa' and '199,000 Btu/h' into each quantity's unit; a bare number is that unit", () => {
    // 7 in. w.c. × 249.0889 Pa = 1,743.62 Pa; ÷ 6,894.757 Pa/psi = 0.252891 psi
    // (7 / 27.7 = 0.2527 with the rounded 27.7 in. w.c. per psi; the library's 27.68 is the exact ratio).
    const r = readQuantityBag({ mbh: "199,000 Btu/h", min_inlet_pressure: "7 in w.c." });
    if (!r.ok) throw new Error(r.reason);
    expect(r.bag.min_inlet_pressure).toBeCloseTo(0.252891, 6);
    expect(r.bag.mbh).toBe(199);
    expect(r.read).toEqual(['mbh "199,000 Btu/h" → 199 MBH', 'min_inlet_pressure "7 in w.c." → min inlet 7 in. w.c. (0.253 psi)']);
    expect(readQuantityValue("min_inlet_pressure", "2 psi")).toEqual({ ok: true, value: 2 });
    // 0.5 kPa = 500 Pa ÷ 6,894.757 = 0.072519 psi
    expect(readQuantityValue("min_inlet_pressure", "0.5 kPa")).toEqual({ ok: true, value: 0.072519 });
    expect(readQuantityValue("min_inlet_pressure", 7)).toEqual({ ok: true, value: 7 });
    expect(readQuantityValue("min_inlet_pressure", "7")).toEqual({ ok: true, value: 7 });
    expect(readQuantityValue("min_inlet_pressure", "7 MBH")).toEqual({ ok: false, reason: expect.stringMatching(/^min_inlet_pressure "7 MBH": Pressure can't be written in/) });
  });

  it("a load point at 7 in. w.c. minimum on a 7 in. w.c. zone with 0.5 in. drop is short; at 5 in. w.c. it passes", () => {
    const line = buildGasLine({ fuel: "natural", end: { loadPointMbh: 150 } });
    const at = (minimum: string) => {
      const read = readQuantityValue("min_inlet_pressure", minimum);
      if (!read.ok) throw new Error(read.reason);
      const d = planCommit(line, [], { idempotencyKey: `lp-min-${minimum}`, baseRevision: line.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "edit_load_point", loadPointId: loadPointId("line-s1", "end"), values: { min_inlet_pressure: read.value } } }, NOW);
      if (!d.ok) throw new Error(d.error.message);
      return gasNetwork(d.model, GAS_LINE_SYSTEM)?.issues.map((i) => i.code) ?? [];
    };
    // Zone: 7 in. w.c. inlet, 0.5 in. allowable drop → 6.5 in. w.c. guaranteed. 5 ≤ 6.5 passes; 7 > 6.5 is short.
    expect(at("5 in. w.c.")).toEqual([]);
    expect(at("7 in w.c.")).toEqual(["zone_below_appliance_minimum"]);
  });

  it("flags a gas minimum above the 14 in. w.c. a load point takes: 55.4 written bare is 55.4 psi", () => {
    expect(connectionTypeQuantityWarnings({ trade: "gas", designator: "G-EXP-100", quantities: { mbh: 100, min_inlet_pressure: 55.4 } })).toEqual([
      "G-EXP-100: min_inlet_pressure 55.4 is psi (min inlet 55.4 psi = 1,533.5 in. w.c.), above the 14 in. w.c. (0.5 psi) a gas outlet takes; its zone check will fail. If you meant in. w.c., write \"55.4 in. w.c.\"",
    ]);
    expect(connectionTypeQuantityWarnings({ trade: "gas", designator: "WH-GT", quantities: { mbh: 199, min_inlet_pressure: 0.25 } })).toEqual([]);
    expect(connectionTypeQuantityWarnings({ trade: "plumbing", designator: "WC-FV", quantities: { min_inlet_pressure: 25 } })).toEqual([]);
  });
});
