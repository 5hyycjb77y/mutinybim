/**
 * @jest-environment node
 *
 * importIfc brings run fittings back and re-joins the runs through them
 * (#59, #66, the shape agreed in #135). An exported elbow, transition, cap or
 * tap came back as nothing ("no class in this model takes it"), and every
 * straight piece came back with no links. A fitting now converts from what
 * the file joins its openings to, and each join the file states between two
 * converted records (run to run, run to fitting, run or fitting to a part's
 * connector) is made on both sides. What can't convert stays on the linked
 * model with its reason, and a join that can't be made is listed in the
 * report.
 */
import { DEFAULT_SETTINGS, GLOBAL_PARTITION, KERNEL_IMPORT_RULES, asRevision, gatedRecordFeatures, importChunks, landImport, planIfcImport, validateModel, type BimElement, type IfcImportPlan, type ImportPort, type ImportProduct, type ImportRuleDef, type ImportSource, type MepSystem, type ModelState, type PortRef, type RunSegment } from "@permitzip/bim-kernel";
import { building, defineScript, equipment, parts, routes, runScript, sliceModel, units, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc, readIfcSource } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import plumbingRiser from "../../bim-script/examples/plumbing-riser";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import { IfcText, hostModel } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";
const FT = 304.8;

/** Runs a script on an empty model and commits its edits; returns the log so a test can add commands. */
async function build(def: ScriptDefinition): Promise<Log> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-run-fittings" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m;
}

const ofKind = <K extends BimElement["kind"]>(elements: readonly BimElement[], kind: K) => elements.filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);
const empty = (): ModelState => ({ modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
const READ = { sourceId: "rt", label: "Round trip", disciplines: ["mechanical"] };
const PLAN = { referenceId: "ref", sourceKey: "rt" };

function twins(model: ModelState, globalIds: Readonly<Record<string, string>>, plan: IfcImportPlan) {
  const byId = new Map(plan.records.map((r) => [r.id as string, r]));
  /** The record an original element came back as, or undefined when it stayed linked. */
  const twin = (id: string): BimElement | undefined => byId.get(plan.converted.get(globalIds[id] ?? "") ?? "");
  /** A link on an original element, as it should read on the imported side. */
  const twinRef = (ref: PortRef | undefined): PortRef | undefined => {
    const t = ref ? twin(ref.elementId) : undefined;
    return ref && t ? { elementId: t.id, port: ref.port } : undefined;
  };
  const original = Object.values(model.elements);
  return { twin, twinRef, fittings: ofKind(original, "run_fitting"), segments: ofKind(original, "run_segment") };
}

/** The model exported and read back: the plan, and each original element's imported twin (through its GlobalId). */
function roundTrip(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const plan = importIfc(out.text, { model: empty(), ...PLAN, ...READ });
  return { ifc: out.text, globalIds: out.report.globalIds, plan, ...twins(model, out.report.globalIds, plan) };
}

const fittingLine = (plan: IfcImportPlan) => plan.report.classes.find((c) => c.classId === "mep.run_fitting");
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const joinNotes = (plan: IfcImportPlan) => plan.report.notes.filter((n) => /joins? in the file/.test(n));

/** Every join among the records is on both records: a link points at a record that points back, a branch fitting is listed by the run it sits on. Returns how many link ends there are. */
function expectLinksMutual(records: readonly BimElement[]) {
  const byId = new Map(records.map((r) => [r.id as string, r]));
  const linkAt = (ref: PortRef): PortRef | undefined => {
    const el = byId.get(ref.elementId);
    if (el?.kind === "run_segment") return ref.port === "start" ? el.links.start : ref.port === "end" ? el.links.end : undefined;
    if (el?.kind === "run_fitting") return el.ports.find((p) => p.id === ref.port)?.link;
    if (el?.kind === "part") return el.links?.[ref.port];
    return undefined;
  };
  let seen = 0;
  for (const r of records) {
    const mine: Array<readonly [string, PortRef | undefined]> = r.kind === "run_segment" ? [["start", r.links.start], ["end", r.links.end]] : r.kind === "run_fitting" ? r.ports.map((p) => [p.id, p.link] as const) : r.kind === "part" ? Object.entries(r.links ?? {}) : [];
    for (const [port, link] of mine) {
      if (!link) continue;
      seen += 1;
      expect(linkAt(link)).toEqual({ elementId: r.id, port });
    }
    if (r.kind === "run_fitting" && r.host) {
      const host = byId.get(r.host.segmentId);
      expect(host?.kind === "run_segment" && host.branches.includes(r.id)).toBe(true);
    }
    if (r.kind === "run_segment") {
      for (const id of r.branches) {
        const b = byId.get(id);
        expect(b?.kind === "run_fitting" ? b.host?.segmentId : null).toBe(r.id);
      }
    }
  }
  return seen;
}

/** No chunk holds one side of a join without the other, so every revision an import commits is whole. */
function expectChunksWhole(records: readonly BimElement[], size?: number) {
  const chunks = importChunks(records, size);
  expect(chunks.flat().map((r) => r.id).sort()).toEqual(records.map((r) => r.id).sort());
  for (const chunk of chunks) {
    const here = new Set(chunk.map((r) => r.id as string));
    for (const r of chunk) {
      const far = r.kind === "run_segment" ? [r.links.start?.elementId, r.links.end?.elementId, ...r.branches] : r.kind === "run_fitting" ? [...r.ports.map((p) => p.link?.elementId), r.host?.segmentId] : r.kind === "part" ? Object.values(r.links ?? {}).map((l) => l.elementId) : [];
      for (const id of far) if (id) expect(here.has(id)).toBe(true);
    }
  }
  return chunks;
}

function runIssues(model: ModelState) {
  const runIds = new Set(Object.values(model.elements).filter((e) => e.kind === "run_fitting" || e.kind === "run_segment" || e.kind === "part").map((e) => e.id as string));
  return validateModel(model).filter((i) => i.elementIds.some((id) => runIds.has(id)));
}

/** rooftop-unit with a transition and cap on the supply, the return carried straight on, a round tap off the return's side and another off the top of the piece after it, off its centre line. */
async function withBranches() {
  const log = await build(rooftopUnit);
  const open = (name: string): RunSegment => {
    const system = Object.values(log.head.elements).find((e) => e.kind === "mep_system" && e.name === name);
    const seg = ofKind(Object.values(log.head.elements), "run_segment").find((s) => s.systemId === system?.id && !s.links.end);
    if (!seg) throw new Error(`no open end on ${name}`);
    return seg;
  };
  const supply = open("Supply air");
  const ret = open("Return air");
  const sa = log.head.elements[supply.systemId];
  const ra = log.head.elements[ret.systemId];
  if (sa?.kind !== "mep_system" || ra?.kind !== "mep_system") throw new Error("no systems");
  log.ok({ type: "route_run", idPrefix: "narrow", levelId: supply.levelId, domain: "duct", size: { shape: "rect", width: 609.6, height: 305 }, system: { id: sa.id, kind: sa.systemKind }, from: { kind: "run_end", elementId: supply.id, port: "end" }, points: [{ x: supply.end.x - 6 * FT, y: supply.end.y }], capEnd: true });
  log.ok({ type: "route_run", idPrefix: "on", levelId: ret.levelId, domain: "duct", size: ret.size, system: { id: ra.id, kind: ra.systemKind }, from: { kind: "run_end", elementId: ret.id, port: "end" }, points: [{ x: ret.end.x + 6 * FT, y: ret.end.y }] });
  const tapX = ret.start.x + 8 * FT;
  log.ok({ type: "route_run", idPrefix: "branch", levelId: ret.levelId, domain: "duct", size: { shape: "round", diameter: 254 }, system: { id: ra.id, kind: ra.systemKind }, from: { kind: "run_branch", segmentId: ret.id }, points: [{ x: tapX, y: ret.start.y }, { x: tapX, y: ret.start.y + 8 * FT }] });
  // Up out of the top of the next piece, 150 mm off its centre line.
  const topX = ret.end.x + 3 * FT;
  const round8 = { shape: "round", diameter: 203.2 } as const;
  const system = { id: ra.id, kind: ra.systemKind };
  const top = ret.end.z + (ret.size.shape === "rect" ? ret.size.height / 2 : 0);
  // A drop from above that ends over the point, then on down onto the trunk's top.
  log.ok({ type: "route_run", idPrefix: "drop", levelId: ret.levelId, domain: "duct", size: round8, elevationMm: top + 4 * FT, system, points: [{ x: topX, y: ret.end.y + 6 * FT }, { x: topX, y: ret.end.y + 150, elevationMm: top + 3 * FT }] });
  log.ok({ type: "route_run", idPrefix: "up", levelId: ret.levelId, domain: "duct", size: round8, elevationMm: top, system, points: [{ x: topX, y: ret.end.y + 150 }], from: { kind: "run_end", elementId: "drop-s2", port: "end" }, to: { kind: "run_branch", segmentId: "on-s1", face: "top", t: 150 } });
  const model = log.head;
  const fittings = ofKind(Object.values(model.elements), "run_fitting");
  const transition = fittings.find((f) => f.fittingType === "transition");
  const cap = fittings.find((f) => f.fittingType === "cap");
  const tap = fittings.find((f) => f.host?.segmentId === ret.id);
  const topTap = fittings.find((f) => f.host?.segmentId === "on-s1");
  if (!transition || !cap || !tap || !topTap) throw new Error(`fixture: ${fittings.map((f) => f.fittingType).join(", ")}`);
  const trunk = model.elements[ret.id];
  if (trunk?.kind !== "run_segment") throw new Error("fixture: trunk");
  return { model, fittings, transition, cap, tap, topTap, trunk };
}

/** A unit whose opening is smaller than the duct routed from it, so a transition sits right on the opening: a fitting joined to a part. */
const unitWithTransition = defineScript({
  kind: "route",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    const level = building.level(ctx, { name: "Level 1", elevation: units.ft(0) });
    const fan = parts.part("Fan box", { type: "Small", category: "mechanical_equipment" });
    fan.box({ length: units.in(48), width: units.in(48), height: units.in(36) });
    fan.connector("bottom", { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", shape: "rect", width: units.mm(500), height: units.mm(300), offset: [units.in(0), units.in(0)] });
    ctx.edit({ type: "save_part_types", label: "Fan box", types: [{ typeId: "test.fan", definition: fan.build() }] });
    const unit = equipment.place(ctx, { level, type: "test.fan", at: { x: units.ft(20), y: units.ft(10) }, height: units.ft(14), mark: "F-1" });
    routes.along(ctx, { level, domain: "duct", size: routes.rect(units.mm(700), units.mm(300)), system: { id: "sa-1", kind: "supply_air", name: "Supply air" }, height: units.ft(10), from: unit.connector("supply"), points: [{ x: units.ft(10), y: units.ft(10) }] });
  },
});

const NO_PLACE = "it branches off the side of a run, and the file doesn't say where on that run";

describe("importIfc: run fittings and the joins through them (#59, #66)", () => {
  it("brings rooftop-unit's elbows back as fittings, and all six of the file's joins back on both records", async () => {
    const model = (await build(rooftopUnit)).head;
    const { ifc, plan, twin, twinRef, fittings, segments } = roundTrip(model);
    expect(fittings).toHaveLength(2);
    expect(segments).toHaveLength(4);
    expect(ifc.match(/IFCRELCONNECTSPORTS\(/g)).toHaveLength(6);

    // Both elbows convert; nothing about them stays behind.
    expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 2, linked: [] });
    expect(plan.report.summary).toMatch(/2 fittings/);

    for (const f of fittings) {
      const back = twin(f.id);
      if (back?.kind !== "run_fitting") throw new Error(`${f.id} did not come back as a fitting`);
      expect(back.fittingType).toBe("elbow");
      expect(back.label).toBe(f.label);
      expect(back.angleDeg).toBe(90);
      expect(back.domain).toBe("duct");
      expect(back.position).toEqual(f.position);
      expect(back.provenance).toEqual({ ifcGlobalId: expect.any(String), source: "rt" });
      // In the system its duct is in, on the level it sits on.
      const joined = twin(f.ports[0]?.link?.elementId ?? "");
      expect(joined?.kind === "run_segment" ? joined.systemId : "?").toBe(back.systemId);
      const system = plan.records.find((r) => r.id === back.systemId);
      const was = model.elements[f.systemId];
      expect(system?.kind === "mep_system" ? [system.name, system.systemKind] : null).toEqual(was?.kind === "mep_system" ? [was.name, was.systemKind] : undefined);
      expect(plan.records.find((r) => r.id === back.levelId)?.kind).toBe("level");
      // Each opening: where it is, which way it faces, its size, and the piece it joins.
      expect(back.ports.map((p) => p.id)).toEqual(f.ports.map((p) => p.id));
      for (const port of f.ports) {
        const p = back.ports.find((x) => x.id === port.id);
        expect(p?.position).toEqual(port.position);
        expect(near(p?.direction ?? { x: NaN, y: NaN, z: NaN }, port.direction)).toBeLessThan(1e-9);
        expect(p?.size).toEqual(port.size);
        expect(p?.link).toEqual(twinRef(port.link));
        expect(p?.link).toBeDefined();
      }
    }

    // Every end of every duct is joined to what it was: four ends on the elbows, two on the rooftop unit's supply and return openings.
    let ends = 0;
    for (const s of segments) {
      const back = twin(s.id);
      if (back?.kind !== "run_segment") throw new Error(`${s.id} did not come back as a run segment`);
      for (const end of ["start", "end"] as const) {
        expect(back.links[end]).toEqual(twinRef(s.links[end]));
        if (back.links[end]) ends += 1;
      }
    }
    expect(ends).toBe(6);
    // The rooftop unit names the two ducts back, by its own connectors.
    const [unit] = ofKind(Object.values(model.elements), "part");
    const unitBack = twin(unit?.id ?? "");
    if (!unit?.links || unitBack?.kind !== "part") throw new Error("the rooftop unit did not come back");
    expect(Object.keys(unit.links).sort()).toEqual(["return", "supply"]);
    expect(unitBack.links).toEqual({ supply: twinRef(unit.links.supply), return: twinRef(unit.links.return) });
    // Six joins, each on both records: twelve link ends, every one answered. Nothing is left to report.
    expect(expectLinksMutual(plan.records)).toBe(12);
    expect(plan.report.notes).toEqual([]);
  });

  it("lands in a model whose checks find the runs joined, whole at every revision, at the usual chunk size and at 3", async () => {
    const model = (await build(rooftopUnit)).head;
    const { plan } = roundTrip(model);
    const landed = landImport(empty(), plan.records);
    expect(landed.dropped).toEqual([]);
    expect(ofKind(Object.values(landed.model.elements), "run_fitting")).toHaveLength(2);
    expect(expectLinksMutual(Object.values(landed.model.elements))).toBe(12);
    expect(runIssues(landed.model)).toEqual([]);
    expectChunksWhole(plan.records);

    // A join is two records; cut every 3 records, the plan would split pairs, so joined pieces land together (each duct run, from the unit's opening through its elbow, is one chunk of four).
    const chunks = expectChunksWhole(plan.records, 3);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.filter((c) => c.length > 3).map((c) => c.map((r) => r.kind).sort())).toEqual([["part", "run_fitting", "run_segment", "run_segment", "run_fitting", "run_segment", "run_segment"].sort()]);
    const small = landImport(empty(), plan.records, { size: 3 });
    expect(small.dropped).toEqual([]);
    expect(small.revisions).toBe(chunks.length);
    expect(expectLinksMutual(Object.values(small.model.elements))).toBe(12);
    expect(runIssues(small.model)).toEqual([]);
  });

  it("brings back a transition, an end cap, a straight join and two taps, each tap on its trunk where it was", async () => {
    const { model, fittings, transition, cap, tap, topTap, trunk } = await withBranches();
    const { ifc, plan, twin, twinRef } = roundTrip(model);
    // What the writer says of a branch fitting: a `Branch` port on the trunk at the branch point, joined to a `Trunk` port on the fitting.
    expect(ifc.match(/IFCDISTRIBUTIONPORT\([^;]*'Branch'/g)).toHaveLength(2);
    expect(ifc.match(/IFCDISTRIBUTIONPORT\([^;]*'Trunk'/g)).toHaveLength(2);

    expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: fittings.length, linked: [] });
    expect(fittings).toHaveLength(7);
    for (const f of [transition, cap]) {
      const back = twin(f.id);
      if (back?.kind !== "run_fitting") throw new Error(`${f.fittingType} did not come back as a fitting`);
      expect(back.fittingType).toBe(f.fittingType);
      expect(back.label).toBe(f.label);
      expect(back.position).toEqual(f.position);
      expect(back.ports).toHaveLength(f.ports.length);
      for (const port of f.ports) {
        const p = back.ports.find((x) => x.id === port.id);
        expect(near(p?.direction ?? { x: NaN, y: NaN, z: NaN }, port.direction)).toBeLessThan(1e-9);
        expect(p?.size).toEqual(port.size);
        expect(p?.link).toEqual(twinRef(port.link));
        expect(p?.link).toBeDefined();
      }
    }
    // The two trunk pieces joined end to end are joined again, each to the other.
    const back = twin(trunk.id);
    const on = twin("on-s1");
    if (back?.kind !== "run_segment" || on?.kind !== "run_segment") throw new Error("the return trunk did not come back");
    expect(trunk.links.end).toEqual({ elementId: "on-s1", port: "start" });
    expect(back.links.end).toEqual({ elementId: on.id, port: "start" });
    expect(on.links.start).toEqual({ elementId: back.id, port: "end" });

    // Each tap: on the same trunk, as far along it, leaving the same way, with its one opening on the branch.
    expect(tap.host).toEqual({ segmentId: trunk.id, s: expect.any(Number), side: expect.any(Number) });
    expect(topTap.host).toEqual({ segmentId: "on-s1", s: expect.any(Number), side: 1, face: "top", t: 150 });
    for (const f of [tap, topTap]) {
      const got = twin(f.id);
      const host = twin(f.host?.segmentId ?? "");
      const was = model.elements[f.host?.segmentId ?? ""];
      if (got?.kind !== "run_fitting" || host?.kind !== "run_segment" || was?.kind !== "run_segment") throw new Error("a tap or its trunk did not come back");
      expect(got.fittingType).toBe(f.fittingType);
      expect(got.label).toBe(f.label);
      expect(got.host).toEqual({ ...f.host, segmentId: host.id });
      expect(got.position).toEqual(f.position);
      expect(got.levelId).toBe(host.levelId);
      expect(got.systemId).toBe(host.systemId);
      // The trunk lists its branches again; the fitting's own port on the trunk in the file is not an opening of the fitting.
      expect(host.branches).toEqual(was.branches.map((id) => twin(id)?.id));
      expect(got.ports).toHaveLength(1);
      const [port] = f.ports;
      const [gotPort] = got.ports;
      if (!port || !gotPort) throw new Error("fixture: the tap's branch");
      expect(gotPort.id).toBe(port.id);
      expect(gotPort.position).toEqual(port.position);
      expect(near(gotPort.direction, port.direction)).toBeLessThan(1e-9);
      expect(gotPort.size).toEqual(port.size);
      expect(gotPort.link).toEqual(twinRef(port.link));
      const branch = twin(port.link?.elementId ?? "");
      expect(branch?.kind === "run_segment" ? branch.links[port.link?.port === "end" ? "end" : "start"] : null).toEqual({ elementId: got.id, port: gotPort.id });
    }
    // Every join in the file is made: nothing to report.
    expect(plan.report.notes).toEqual([]);
    expectLinksMutual(plan.records);
    for (const size of [undefined, 3]) {
      expectChunksWhole(plan.records, size);
      const landed = landImport(empty(), plan.records, size ? { size } : {});
      expect(landed.dropped).toEqual([]);
      expect(runIssues(landed.model)).toEqual([]);
      expect(Object.keys(landed.model.elements)).toHaveLength(plan.records.length);
    }
  });

  describe("a branch fitting in a file that says less", () => {
    /** The model's export as the reader sees it, its connection points changed before planning. */
    async function planWithPorts(change: (port: ImportPort, product: ImportProduct) => ImportPort | null) {
      const made = await withBranches();
      const out = exportIfc({ model: made.model, project: PROJECT, timeStamp: TIME_STAMP });
      const read = readIfcSource(out.text, READ);
      const source: ImportSource = { ...read, products: read.products.map((p) => ({ ...p, ports: p.ports.flatMap((port) => change(port, p) ?? []) })) };
      const plan = planIfcImport(source, { model: empty(), ...PLAN });
      return { ...made, plan, ...twins(made.model, out.report.globalIds, plan) };
    }

    it("stays linked with the reason when the file has no point on the trunk (an older export, or another tool's)", async () => {
      const { plan, twin, tap, topTap, trunk } = await planWithPorts((port) => (port.name === "Branch" || port.name === "Trunk" ? null : { ...port, connectedTo: port.connectedTo }));
      expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 5, linked: [{ reason: NO_PLACE, count: 2 }] });
      // Each branch's own duct came in; its end on the tap is open, the trunk lists no branch, and the report says the joins were left out.
      for (const f of [tap, topTap]) {
        expect(twin(f.id)).toBeUndefined();
        const branch = twin(f.ports[0]?.link?.elementId ?? "");
        expect(branch?.kind === "run_segment" ? branch.links[f.ports[0]?.link?.port === "end" ? "end" : "start"] : "?").toBeUndefined();
      }
      const back = twin(trunk.id);
      expect(back?.kind === "run_segment" ? back.branches : null).toEqual([]);
      expect(joinNotes(plan)).toEqual(["2 joins in the file weren't made (one side stayed on the linked model); the end that came in is open there"]);
      expectLinksMutual(plan.records);
      for (const size of [undefined, 3]) {
        expectChunksWhole(plan.records, size);
        const landed = landImport(empty(), plan.records, size ? { size } : {});
        expect(landed.dropped).toEqual([]);
        expect(runIssues(landed.model)).toEqual([]);
      }
    });

    it("comes back the same when no connection point says which way it faces: the branch's own first piece says which way out", async () => {
      const { model, plan, twin, tap, topTap } = await planWithPorts((port) => ({ ...port, direction: null }));
      expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 7, linked: [] });
      for (const f of [tap, topTap]) {
        const got = twin(f.id);
        const host = twin(f.host?.segmentId ?? "");
        expect(got?.kind === "run_fitting" ? got.host : null).toEqual({ ...f.host, segmentId: host?.id });
        expect(got?.kind === "run_fitting" ? got.position : null).toEqual(f.position);
      }
      expect(joinNotes(plan)).toEqual([]);
      expect(landImport(empty(), plan.records).dropped).toEqual([]);
      expect(model.elements[tap.id]).toBe(tap);
    });
  });

  it("joins a fitting to a part: a transition right on a unit's opening comes back linked to the unit's connector, and the unit to it", async () => {
    const model = (await build(unitWithTransition)).head;
    const { plan, twin, twinRef, fittings } = roundTrip(model);
    const [unit] = ofKind(Object.values(model.elements), "part");
    const transition = fittings.find((f) => f.ports.some((p) => p.link?.elementId === unit?.id));
    if (!unit?.links?.supply || !transition) throw new Error(`fixture: a transition on the unit (${fittings.map((f) => f.fittingType).join(", ")})`);
    expect(transition.fittingType).toBe("transition");
    expect(unit.links.supply.elementId).toBe(transition.id);

    expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: fittings.length, linked: [] });
    const back = twin(transition.id);
    const unitBack = twin(unit.id);
    if (back?.kind !== "run_fitting" || unitBack?.kind !== "part") throw new Error("the transition or the unit did not come back");
    expect(back.position).toEqual(transition.position);
    for (const port of transition.ports) {
      const p = back.ports.find((x) => x.id === port.id);
      expect(p?.position).toEqual(port.position);
      expect(near(p?.direction ?? { x: NaN, y: NaN, z: NaN }, port.direction)).toBeLessThan(1e-9);
      expect(p?.size).toEqual(port.size);
      expect(p?.link).toEqual(twinRef(port.link));
    }
    expect(unitBack.links).toEqual({ supply: twinRef(unit.links.supply) });
    expect(plan.report.notes).toEqual([]);
    expectLinksMutual(plan.records);
    for (const size of [undefined, 3]) {
      expectChunksWhole(plan.records, size);
      const landed = landImport(empty(), plan.records, size ? { size } : {});
      expect(landed.dropped).toEqual([]);
      expect(runIssues(landed.model)).toEqual([]);
    }
  });

  describe("plumbing-riser: a drain with a wye for each fixture arm", () => {
    it("as the file is read today: the pipes stay linked (their material isn't in the file), so the fittings on them do too", async () => {
      const model = (await build(plumbingRiser)).head;
      const { plan, fittings, segments } = roundTrip(model);
      expect([segments.length, fittings.length]).toEqual([22, 18]);
      expect(plan.report.classes).toEqual([
        { classId: "mep.plumbing_fixture", label: "Plumbing fixtures", converted: 8, linked: [] },
        { classId: "mep.run_fitting", label: "Fittings", converted: 0, linked: [{ reason: "something it joins stays on the linked model", count: 18 }] },
        { classId: "mep.pipe", label: "Pipe", converted: 0, linked: [{ reason: "its size needs the add-on that owns these runs' sizes (nominal size and material) to come in", count: 22 }] },
      ]);
      expect(plan.report.notes).toEqual([
        "1 system wasn't brought in (Sanitary); anything in it that converted came in on its own, so set it up again by hand",
        "8 joins in the file weren't made (one side stayed on the linked model); the end that came in is open there",
      ]);
      expect(plan.report.summary).toBe("Converted 8 plumbing fixtures. Left 18 fittings and 22 pipes as the linked model.");
    });

    it("once its pipes come in (here through a stand-in rule that takes each pipe's size from the model it was written from), every bend and wye comes back, each wye on its trunk where it was", async () => {
      const model = (await build(plumbingRiser)).head;
      const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
      const wasId = new Map(Object.entries(out.report.globalIds).map(([id, guid]) => [guid, id]));
      const kernel = KERNEL_IMPORT_RULES.find((r) => r.id === "kernel.run_segment");
      if (!kernel) throw new Error("fixture: the run segment rule");
      // The file gives a pipe's diameter only; a pipe here is a nominal size of a material. Until an import rule reads that, this stands in for it.
      const pipes: ImportRuleDef = {
        ...kernel,
        convert(p, ctx) {
          const was = model.elements[wasId.get(p.sourceId) ?? ""];
          if (ctx.fields.domain !== "pipe" || was?.kind !== "run_segment") return kernel.convert(p, ctx);
          const level = ctx.level(p);
          const groupId = p.groupIds.find((id) => ctx.group(id) !== null);
          const wasSystem = model.elements[was.systemId];
          if (!level || !groupId || wasSystem?.kind !== "mep_system") return { ok: false, reason: "fixture: its level or system" };
          const system = ctx.shared<MepSystem>(`system:${groupId}`, () => ({ id: ctx.idFor(groupId), kind: "mep_system", version: 0, authoredRev: {}, partition: { ...GLOBAL_PARTITION, discipline: ctx.cls.discipline }, name: wasSystem.name, systemKind: wasSystem.systemKind, domain: "pipe", provenance: { ifcGlobalId: groupId, source: ctx.provenance(p).source } }));
          if (typeof system === "string") return { ok: false, reason: system };
          const record: RunSegment = { id: ctx.idFor(p.sourceId), version: 0, authoredRev: {}, partition: ctx.partition(level), provenance: ctx.provenance(p), kind: "run_segment", domain: "pipe", systemId: system.id, levelId: level.id, start: was.start, end: was.end, size: was.size, links: {}, branches: [], flow: 0 };
          return { ok: true, records: [record] };
        },
      };
      const plan = planIfcImport(readIfcSource(out.text, READ), { model: empty(), ...PLAN, rules: KERNEL_IMPORT_RULES.map((r) => (r === kernel ? pipes : r)) });
      const { twin, twinRef, fittings, segments } = twins(model, out.report.globalIds, plan);

      expect(plan.report.classes.map((c) => [c.classId, c.converted, c.linked])).toEqual([["mep.pipe", 22, []], ["mep.run_fitting", 18, []], ["mep.plumbing_fixture", 8, []]]);
      // Every join in the file is made, the fixtures' too: nothing to report.
      expect(plan.report.notes).toEqual([]);

      const wyes = fittings.filter((f) => f.host !== undefined);
      expect(wyes).toHaveLength(8);
      expect(new Set(wyes.map((f) => f.fittingType))).toEqual(new Set(["wye"]));
      for (const f of fittings) {
        const got = twin(f.id);
        if (got?.kind !== "run_fitting") throw new Error(`${f.label} did not come back as a fitting`);
        expect(got.fittingType).toBe(f.fittingType);
        expect(got.label).toBe(f.label);
        // A quarter bend on a pitched drain turns a little under 90 degrees; it is still the 90 it was made as.
        expect(got.angleDeg).toBe(f.angleDeg);
        // Heights are kept to a tenth of a millimetre on the way in.
        expect(near(got.position, f.position)).toBeLessThan(0.1);
        expect(got.host).toEqual(f.host ? { ...f.host, segmentId: twin(f.host.segmentId)?.id } : undefined);
        expect(got.ports.map((p) => [p.id, p.link])).toEqual(f.ports.map((p) => [p.id, twinRef(p.link)]));
      }
      for (const seg of segments) {
        const got = twin(seg.id);
        if (got?.kind !== "run_segment") throw new Error(`${seg.id} did not come back`);
        for (const end of ["start", "end"] as const) {
          const link = seg.links[end];
          // A fixture's connector takes its id from its name in the file ("Waste" for the model's "w"), so only what it joins is compared; that each side names the other is checked below.
          if (link && model.elements[link.elementId]?.kind === "part") expect(got.links[end]?.elementId).toBe(twin(link.elementId)?.id);
          else expect(got.links[end]).toEqual(twinRef(link));
        }
        expect(got.branches).toEqual(seg.branches.map((id) => twin(id)?.id));
      }
      expectLinksMutual(plan.records);
      for (const size of [undefined, 3]) {
        expectChunksWhole(plan.records, size);
        const landed = landImport(empty(), plan.records, size ? { size } : {});
        expect(landed.dropped).toEqual([]);
        expect(runIssues(landed.model)).toEqual([]);
      }
    });
  });

  it("joins a file from another tool: ports and port joins, no MutinyBIM property sets", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const duct = (name: string, at: readonly [number, number, number], along: "x" | "y", length: number) =>
      t.product("Level 1", "IFCDUCTSEGMENT", name, at, t.body([t.extrude(t.rect(400, 300), length, t.axis3([0, 0, 0], along === "x" ? [1, 0, 0] : [0, 1, 0], along === "x" ? [0, 1, 0] : [1, 0, 0]))]), ".RIGIDSEGMENT.");
    const a = duct("A", [0, 0, 3000], "x", 3000);
    const b = duct("B", [3000, 0, 3000], "y", 3000);
    const c = duct("C", [3000, 3000, 3000], "y", 3000);
    const bend = t.product("Level 1", "IFCDUCTFITTING", "Bend 1", [3000, 0, 3000], t.body([t.extrude(t.rect(400, 400), 300)]), ".BEND.");
    t.assign(t.system("Supply Air 1", "AIRCONDITIONING"), [a, b, c, bend]);
    let n = 0;
    const port = (owner: number, at: readonly [number, number, number]) => {
      const id = t.add("IFCDISTRIBUTIONPORT", `${t.guid()},$,'Port ${++n}',$,$,#${t.place(null, t.axis3(at))},$,.NOTDEFINED.,.DUCT.,$`);
      t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${owner},(#${id})`);
      return id;
    };
    const join = (x: number, y: number) => t.add("IFCRELCONNECTSPORTS", `${t.guid()},$,$,$,#${x},#${y},$`);
    const corner = [3000, 0, 3000] as const;
    const mid = [3000, 3000, 3000] as const;
    join(port(a, corner), port(bend, corner));
    join(port(bend, corner), port(b, corner));
    // Two straight pieces joined end to end, with no fitting between them.
    join(port(b, mid), port(c, mid));
    const text = t.text();
    expect(text).not.toMatch(/MutinyBIM/);

    const plan = importIfc(text, { model: hostModel(), referenceId: "ref", sourceKey: "other", sourceId: "other", label: "Other tool", disciplines: ["mechanical"] });
    expect(plan.report.classes.map((l) => [l.classId, l.converted, l.linked])).toEqual([["mep.duct", 3, []], ["mep.run_fitting", 1, []]]);
    expect(joinNotes(plan)).toEqual([]);
    const [fitting] = ofKind([...plan.records], "run_fitting");
    const pieces = ofKind([...plan.records], "run_segment");
    const piece = (x: number, y: number) => pieces.find((s) => s.start.x === x && s.start.y === y);
    const [pa, pb, pc] = [piece(0, 0), piece(3000, 0), piece(3000, 3000)];
    if (!fitting || !pa || !pb || !pc) throw new Error("the pieces did not come in");
    expect(fitting).toMatchObject({ fittingType: "elbow", angleDeg: 90, label: "Bend 1", position: { x: 3000, y: 0, z: 3000 }, systemId: pa.systemId });
    // The file's port names aren't ids, so the openings are lettered in the file's order.
    expect(fitting.ports.map((p) => [p.id, p.link])).toEqual([["a", { elementId: pa.id, port: "end" }], ["b", { elementId: pb.id, port: "start" }]]);
    expect(pa.links).toEqual({ end: { elementId: fitting.id, port: "a" } });
    expect(pb.links).toEqual({ start: { elementId: fitting.id, port: "b" }, end: { elementId: pc.id, port: "start" } });
    expect(pc.links).toEqual({ start: { elementId: pb.id, port: "end" } });
    expect(expectLinksMutual(plan.records)).toBe(6);
    for (const size of [undefined, 3]) {
      expectChunksWhole(plan.records, size);
      const landed = landImport(hostModel(), plan.records, size ? { size } : {});
      expect(landed.dropped).toEqual([]);
      expect(runIssues(landed.model)).toEqual([]);
    }
  });

  describe("what can't convert stays linked, in plain words", () => {
    /** rooftop-unit as the reader sees it, with its products changed before planning. */
    async function planWith(change: (p: ImportProduct) => ImportProduct | null): Promise<{ plan: IfcImportPlan; source: ImportSource }> {
      const model = (await build(rooftopUnit)).head;
      const read = readIfcSource(exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP }).text, READ);
      const source: ImportSource = { ...read, products: read.products.flatMap((p) => change(p) ?? []) };
      return { plan: planIfcImport(source, { model: empty(), ...PLAN }), source };
    }

    it("a fitting on a run that stays linked stays linked too, and the run's other pieces still land with that end open", async () => {
      // The horizontal supply trunk comes in with a shape the run rule can't read.
      const { plan } = await planWith((p) => (p.entity === "IfcDuctSegment" && /Supply/.test(p.name ?? "") && (p.geometry.bounds?.max.x ?? 0) - (p.geometry.bounds?.min.x ?? 0) > 1000 ? { ...p, geometry: { ...p.geometry, extrusions: [], unread: "a mesh" } } : p));
      expect(fittingLine(plan)).toEqual({ classId: "mep.run_fitting", label: "Fittings", converted: 1, linked: [{ reason: "something it joins stays on the linked model", count: 1 }] });
      expect(ofKind([...plan.records], "run_fitting")).toHaveLength(1);
      expect(expectLinksMutual(plan.records)).toBe(8);
      expect(joinNotes(plan)).toContain("1 join in the file wasn't made (one side stayed on the linked model); the end that came in is open there");
      expect(landImport(empty(), plan.records).dropped).toEqual([]);
    });

    it("a fitting the file joins to nothing stays linked", async () => {
      const { plan } = await planWith((p) => (p.entity === "IfcDuctFitting" ? { ...p, ports: p.ports.map((port) => ({ ...port, connectedTo: [] })) } : p));
      expect(fittingLine(plan)?.converted).toBe(0);
      expect(fittingLine(plan)?.linked).toEqual([{ reason: "the file doesn't say what its openings join", count: 2 }]);
      expect(expectLinksMutual(plan.records)).toBe(4);
    });

    it("a fitting written as a transition where its runs turn, or of a kind that isn't read yet, stays linked", async () => {
      const kinds = ["TRANSITION", "USERDEFINED"];
      const { plan } = await planWith((p) => (p.entity === "IfcDuctFitting" ? { ...p, predefinedType: kinds.pop() ?? null } : p));
      expect(fittingLine(plan)?.converted).toBe(0);
      expect((fittingLine(plan)?.linked ?? []).map((l) => l.reason).sort()).toEqual(["it is a kind of fitting that isn't read from the file yet", "it is written as a transition, but the runs it joins turn there"]);
      // Neither left a link on the runs it would have joined: only the two onto the unit's openings are there, each on both records.
      expect(expectLinksMutual(plan.records)).toBe(4);
    });

    it("says so when the file joins two straight pieces where they turn, with no fitting between them", async () => {
      // No elbows in the file; the supply riser and trunk are joined to each other at the corner instead.
      const { plan, source } = await planWith((p) => (p.entity === "IfcDuctFitting" ? null : p));
      expect(fittingLine(plan)).toBeUndefined();
      const [a, b] = source.products.filter((p) => p.entity === "IfcDuctSegment" && /Supply/.test(p.name ?? ""));
      if (!a || !b) throw new Error("fixture: two supply pieces");
      const meet = a.ports.flatMap((pa) => b.ports.flatMap((pb) => (pa.position && pb.position && near(pa.position, pb.position) < 1 ? [[pa, pb] as const] : [])))[0];
      if (!meet) throw new Error("fixture: the pieces meet");
      const rejoined: ImportSource = {
        ...source,
        products: source.products.map((p) => (p === a || p === b ? { ...p, ports: p.ports.map((port) => (port === meet[0] ? { ...port, connectedTo: [meet[1].id] } : port === meet[1] ? { ...port, connectedTo: [meet[0].id] } : port)) } : p)),
      };
      const joined = planIfcImport(rejoined, { model: empty(), ...PLAN });
      expect(ofKind([...joined.records], "run_segment")).toHaveLength(4);
      expect(expectLinksMutual(joined.records)).toBe(4);
      expect(joinNotes(joined)).toContain("1 join in the file wasn't made (the file joins them where they turn, with no fitting between them); the ends there are open, so join them by hand");
    });

    it("disambiguates an AIRCONDITIONING port with a generic name using the product's system group so return-air joins land", async () => {
      const model = (await build(rooftopUnit)).head;
      const source = readIfcSource(exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP }).text, READ);
      const returnGroup = source.groups.find((g) => /return/i.test(g.name ?? ""));
      if (!returnGroup) throw new Error("fixture: return-air group");
      const modified: ImportSource = {
        ...source,
        products: source.products.map((p) => {
          if (p.entity !== "IfcUnitaryEquipment") return p;
          return {
            ...p,
            groupIds: [returnGroup.sourceId],
            ports: p.ports.map((port) => (/return/i.test(port.name ?? "") ? { ...port, name: "Neck", systemType: "AIRCONDITIONING" } : port)),
          };
        }),
      };
      const plan = planIfcImport(modified, { model: empty(), ...PLAN });
      const partTypes = ofKind([...plan.records], "part_type");
      const neck = partTypes.flatMap((t) => t.definition.connectors).find((c) => c.label === "Neck");
      expect(neck?.systemKind).toBe("return_air");
      expect(joinNotes(plan)).toEqual([]);
      expect(expectLinksMutual(plan.records)).toBe(12);
    });

    it("joins both runs when a part has two distinct IFC ports at the exact same coordinates", () => {
      const t = IfcText.start();
      t.storey("Level 1", 0);
      const unit = t.product("Level 1", "IFCUNITARYEQUIPMENT", "AHU-1", [0, 0, 2500], t.body([t.extrude(t.rect(1000, 1000), 1000)]), ".AIRHANDLER.");
      const duct = (name: string, at: readonly [number, number, number], length: number) =>
        t.product("Level 1", "IFCDUCTSEGMENT", name, at, t.body([t.extrude(t.rect(400, 300), length, t.axis3([0, 0, 0], [1, 0, 0], [0, 1, 0]))]), ".RIGIDSEGMENT.");
      const supplyDuct = duct("Supply 1", [0, 0, 3000], 3000);
      const returnDuct = duct("Return 1", [-3000, 0, 3000], 3000);
      t.assign(t.system("Supply Air 1", "AIRCONDITIONING"), [supplyDuct]);
      t.assign(t.system("Return Air 1", "AIRCONDITIONING"), [returnDuct]);
      const sharedAt = [0, 0, 3000] as const;
      const port = (owner: number, name: string, dir: readonly [number, number, number]) => {
        const id = t.add("IFCDISTRIBUTIONPORT", `${t.guid()},$,'${name}',$,$,#${t.place(null, t.axis3(sharedAt, dir, [0, 1, 0]))},$,.NOTDEFINED.,.DUCT.,.AIRCONDITIONING.`);
        t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${owner},(#${id})`);
        return id;
      };
      const join = (x: number, y: number) => t.add("IFCRELCONNECTSPORTS", `${t.guid()},$,$,$,#${x},#${y},$`);
      join(port(unit, "Supply", [1, 0, 0]), port(supplyDuct, "Start", [-1, 0, 0]));
      join(port(unit, "Return", [-1, 0, 0]), port(returnDuct, "End", [1, 0, 0]));

      const plan = importIfc(t.text(), { model: hostModel(), referenceId: "ref", sourceKey: "colocated", sourceId: "colocated", label: "Other tool", disciplines: ["mechanical"] });
      expect(joinNotes(plan)).toEqual([]);
      expect(expectLinksMutual(plan.records)).toBe(4);
      const [part] = ofKind([...plan.records], "part");
      expect(Object.keys(part?.links ?? {}).sort()).toEqual(["return", "supply"]);
    });
  });
});
