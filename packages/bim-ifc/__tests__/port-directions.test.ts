/**
 * @jest-environment node
 *
 * What a reader can rely on about an exported IfcDistributionPort (#135 step 1, for #66):
 *
 * - Its ObjectPlacement is relative to its host's placement, sits where the kernel has the port, and its local z
 *   points out of the host along the connection: the kernel's own connector direction, for a part connector (as
 *   the part is turned and mounted), a run segment end and a fitting port.
 * - Its size, and what it is designed to carry, are in the IFC 4.3 standard port property sets, never in a
 *   MutinyBIM_* set.
 * - A branch fitting (a tap, a tee) on a trunk that stays one piece: the trunk has a nested port where the branch
 *   leaves it, facing the branch, joined to a port of the fitting.
 */
import {
  DEFAULT_SETTINGS,
  asElementId,
  asRevision,
  gatedRecordFeatures,
  RISER_DEFAULT_WIDTH_AXIS,
  hostedPoints,
  portWidthAxis,
  resolveConnectors,
  segmentPort,
  segmentWidthAxis,
  worldConnector,
  type BimElement,
  type ModelState,
  type PartInstance,
  type RunFitting,
  type RunSegment,
  type RunSize,
} from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { danglingReferences, exportIfc, readStep, rootedEntities, type ReadEntity, type StepFile } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";
import plumbingRiser from "../../bim-script/examples/plumbing-riser";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import { ofType, ref, refs, text } from "./a13a-ifc-support";

const FT = 304.8;
const IN = 25.4;
const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic ports" };
const TIME_STAMP = "2026-11-25T00:00:00";

type V3 = readonly [number, number, number];

async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "ports", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:port-directions" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

/** A level with a duct trunk and a round branch tapped off its side, and a cold water pipe with a tee. */
function tapAndTee(): ModelState {
  const m = new Log({ modelId: "ports", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 3000 });
  const air = { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" };
  m.ok({ type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: air, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  m.ok({ type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system: air, from: { kind: "run_branch", segmentId: "T-s1" }, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }] });
  const water = { id: "sys-cw", kind: "domestic_cold_water", name: "DCW 1" };
  m.ok({ type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "pex" }, elevationMm: -2 * FT, system: water, points: [{ x: 0, y: 30 * FT }, { x: 10 * FT, y: 30 * FT }, { x: 10 * FT, y: 38 * FT }] });
  const bend = Object.values(m.head.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.fittingType === "elbow" && e.domain === "pipe");
  const through = bend?.ports.find((p) => p.link?.elementId === "p-s2");
  if (!bend || !through) throw new Error("fixture: no pipe elbow");
  m.ok({ type: "elbow_to_tee", fittingId: bend.id, through: through.id, idPrefix: "plus" });
  return m.head;
}

function get(file: StepFile, id: number): ReadEntity {
  const e = file.entities.get(id);
  if (!e) throw new Error(`no entity #${id}`);
  return e;
}

function triple(file: StepFile, id: number): V3 {
  const a = get(file, id).args[0];
  const v = a?.kind === "list" ? a.items.map((c) => (c.kind === "number" ? c.value : NaN)) : [];
  return [v[0] ?? NaN, v[1] ?? NaN, v[2] ?? 0];
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Frame {
  readonly origin: V3;
  readonly x: V3;
  readonly y: V3;
  readonly z: V3;
  /** False when the placement states no axes of its own. */
  readonly hasAxis: boolean;
}

/** An IfcLocalPlacement in world coordinates, composed through every PlacementRelTo, as any IFC reader does it. */
function frameOf(file: StepFile, placementId: number): Frame {
  const lp = get(file, placementId);
  expect(lp.type).toBe("IFCLOCALPLACEMENT");
  const parent: Frame = lp.args[0]?.kind === "ref" ? frameOf(file, lp.args[0].id) : { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], hasAxis: false };
  const a = get(file, ref(lp, 1));
  const o = triple(file, ref(a, 0));
  const hasAxis = a.args[1]?.kind === "ref" && a.args[2]?.kind === "ref";
  const lz: V3 = hasAxis ? triple(file, ref(a, 1)) : [0, 0, 1];
  const lx: V3 = hasAxis ? triple(file, ref(a, 2)) : [1, 0, 0];
  const ly = cross(lz, lx);
  const out = (v: V3): V3 => [0, 1, 2].map((i) => v[0] * (parent.x[i] ?? 0) + v[1] * (parent.y[i] ?? 0) + v[2] * (parent.z[i] ?? 0)) as unknown as V3;
  const origin = out(o).map((c, i) => c + (parent.origin[i] ?? 0)) as unknown as V3;
  return { origin, x: out(lx), y: out(ly), z: out(lz), hasAxis };
}

interface Exported {
  readonly text: string;
  readonly file: StepFile;
  readonly warnings: readonly string[];
  readonly entityOf: (id: string) => ReadEntity;
  /** The ports nested on a model element, in the order the file lists them. */
  readonly portsOf: (id: string) => ReadEntity[];
  readonly connections: ReadEntity[];
  readonly partnerOf: (port: ReadEntity) => ReadEntity[];
  /** A port's property sets: set name, then property name, then the written entity type, measure type and value. */
  readonly setsOf: (port: ReadEntity) => Record<string, Record<string, { entity: string; measure: string; value: number }>>;
}

function exported(model: ModelState): Exported {
  const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  expect(file.schemas).toEqual(["IFC4X3_ADD2"]);
  expect(danglingReferences(file)).toEqual([]);
  const byGuid = new Map([...file.entities.values()].flatMap((e) => (e.args[0]?.kind === "string" ? [[e.args[0].value, e] as const] : [])));
  const entityOf = (id: string): ReadEntity => {
    const e = byGuid.get(out.report.globalIds[id] ?? "");
    if (!e) throw new Error(`no entity for ${id}`);
    return e;
  };
  const nests = ofType(file, "IFCRELNESTS");
  const portsOf = (id: string) => {
    const host = entityOf(id);
    return nests.filter((r) => ref(r, 4) === host.id).flatMap((r) => refs(r, 5)).map((p) => get(file, p)).filter((p) => p.type === "IFCDISTRIBUTIONPORT");
  };
  const connections = ofType(file, "IFCRELCONNECTSPORTS");
  const partnerOf = (port: ReadEntity) => connections.flatMap((c) => (ref(c, 4) === port.id ? [get(file, ref(c, 5))] : ref(c, 5) === port.id ? [get(file, ref(c, 4))] : []));
  const defines = ofType(file, "IFCRELDEFINESBYPROPERTIES");
  const setsOf = (port: ReadEntity) => {
    const sets: Record<string, Record<string, { entity: string; measure: string; value: number }>> = {};
    for (const set of defines.filter((r) => refs(r, 4).includes(port.id)).map((r) => get(file, ref(r, 5)))) {
      const props: Record<string, { entity: string; measure: string; value: number }> = {};
      for (const p of refs(set, 4).map((id) => get(file, id))) {
        // IfcPropertySingleValue: NominalValue is the third attribute. IfcPropertyBoundedValue: SetPointValue is the sixth, with no bounds.
        const v = p.type === "IFCPROPERTYSINGLEVALUE" ? p.args[2] : p.args[5];
        if (p.type === "IFCPROPERTYBOUNDEDVALUE") expect([p.args[2]?.kind, p.args[3]?.kind]).toEqual(["null", "null"]);
        props[text(p, 0) ?? "?"] = { entity: p.type, measure: v?.kind === "typed" ? v.type : "?", value: v?.kind === "typed" && v.value.kind === "number" ? v.value.value : NaN };
      }
      const name = text(set, 2) ?? "?";
      expect(sets[name]).toBeUndefined();
      sets[name] = props;
    }
    return sets;
  };
  return { text: out.text, file, warnings: out.report.warnings, entityOf, portsOf, connections, partnerOf, setsOf };
}

const ofKind = <K extends BimElement["kind"]>(model: ModelState, kind: K) => Object.values(model.elements).filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);

function elevationOf(model: ModelState, levelId: string): number {
  const lv = model.elements[levelId];
  return lv?.kind === "level" ? lv.elevationMm : 0;
}

/** Every port the kernel has on a part, a run segment or a fitting: the file's name for it, where it is and which way it faces (world). */
function kernelPorts(model: ModelState, el: BimElement): Array<{ name: string; position: V3; direction: V3 }> {
  if (el.kind === "run_segment") {
    const up = elevationOf(model, el.levelId);
    return (["start", "end"] as const).flatMap((end) => {
      const info = segmentPort(el, end);
      return info ? [{ name: end === "start" ? "Start" : "End", position: [info.position.x, info.position.y, info.position.z + up] as const, direction: [info.direction.x, info.direction.y, info.direction.z] as const }] : [];
    });
  }
  if (el.kind === "run_fitting") {
    const up = elevationOf(model, el.levelId);
    return el.ports.map((p) => ({ name: p.id, position: [p.position.x, p.position.y, p.position.z + up] as const, direction: [p.direction.x, p.direction.y, p.direction.z] as const }));
  }
  if (el.kind === "part") {
    const type = model.elements[el.typeId];
    if (type?.kind !== "part_type") return [];
    const up = elevationOf(model, el.levelId);
    return resolveConnectors(type.definition, el.values).map((c) => {
      const w = worldConnector(el, c);
      return { name: c.label, position: [w.position.x, w.position.y, w.position.z + up] as const, direction: [w.direction.x, w.direction.y, w.direction.z] as const };
    });
  }
  return [];
}

/** Checks every kernel port of `model` against the file; returns how many it compared. */
function expectPortsFaceAsTheKernelSays(model: ModelState, x: Exported): number {
  let compared = 0;
  for (const el of Object.values(model.elements)) {
    const wanted = kernelPorts(model, el);
    if (wanted.length === 0) continue;
    const host = x.entityOf(el.id);
    const written = x.portsOf(el.id);
    for (const want of wanted) {
      const port = written.find((p) => text(p, 2) === want.name);
      if (!port) throw new Error(`${el.id}: no port named ${want.name}`);
      const placement = get(x.file, ref(port, 5));
      // Relative to its host's own placement, not to the storey.
      expect(ref(placement, 0)).toBe(ref(host, 5));
      const frame = frameOf(x.file, placement.id);
      expect(frame.hasAxis).toBe(true);
      for (const i of [0, 1, 2]) {
        expect(frame.origin[i]).toBeCloseTo(want.position[i] ?? NaN, 2);
        // The kernel keeps directions to six decimals (dir3), so a reader that rounds the same way gets the same vector.
        expect(Math.round((frame.z[i] ?? NaN) * 1e6) / 1e6 + 0).toBeCloseTo(want.direction[i] ?? NaN, 6);
      }
      // A right-handed frame with x square to z.
      expect(Math.abs(dot(frame.x, frame.z))).toBeLessThan(1e-6);
      expect(Math.hypot(...frame.x)).toBeCloseTo(1, 6);
      compared++;
    }
  }
  return compared;
}

describe.each([
  ["rooftop-unit", rooftopUnit, 14],
  ["plumbing-riser", plumbingRiser, 100],
  ["electrical-room", electricalRoom, 12],
] satisfies [string, ScriptDefinition, number][])("%s", (_name, script, kernelPortCount) => {
  let model: ModelState;
  let x: Exported;
  beforeAll(async () => {
    model = await build(script);
    x = exported(model);
  });

  it("places every port on its host, where the kernel has it, facing the way the kernel says", () => {
    expect(expectPortsFaceAsTheKernelSays(model, x)).toBe(kernelPortCount);
  });

  it("joins ports that sit at one point and face each other, each port in one connection at most", () => {
    const seen = new Map<number, number>();
    for (const c of x.connections) {
      const a = get(x.file, ref(c, 4));
      const b = get(x.file, ref(c, 5));
      for (const p of [a, b]) seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
      const fa = frameOf(x.file, ref(a, 5));
      const fb = frameOf(x.file, ref(b, 5));
      expect(Math.hypot(fa.origin[0] - fb.origin[0], fa.origin[1] - fb.origin[1], fa.origin[2] - fb.origin[2])).toBeLessThan(0.01);
      // Opposite ways, as far as the model has them so: a drain laid to fall meets a fitting about a degree off square.
      expect(dot(fa.z, fb.z)).toBeLessThan(-0.999);
    }
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("writes the same bytes twice, with every GlobalId its own", () => {
    expect(exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP }).text).toBe(x.text);
    const rooted = rootedEntities(x.file);
    expect(new Set(rooted.map((r) => r.globalId)).size).toBe(rooted.length);
  });
});

describe("a part's ports follow the part as it is turned and mounted", () => {
  it.each([
    ["as drawn, turned 37 degrees", { rotationDeg: 37 }],
    ["turned over", { mount: "turned_over" as const, rotationDeg: 90 }],
    ["on its side", { mount: "on_side" as const, rotationDeg: 210 }],
  ])("%s", async (_name, change) => {
    const base = await build(rooftopUnit);
    const unit = ofKind(base, "part").find((p) => p.mark === "RTU-1");
    if (!unit) throw new Error("no RTU-1");
    const turned: PartInstance = { ...unit, ...change };
    const model: ModelState = { ...base, elements: { ...base.elements, [turned.id]: turned } };
    const x = exported(model);
    const wanted = kernelPorts(model, turned);
    expect(wanted.length).toBeGreaterThanOrEqual(2);
    for (const want of wanted) {
      const port = x.portsOf(turned.id).find((p) => text(p, 2) === want.name);
      if (!port) throw new Error(`no port ${want.name}`);
      const frame = frameOf(x.file, ref(port, 5));
      for (const i of [0, 1, 2]) {
        expect(frame.origin[i]).toBeCloseTo(want.position[i] ?? NaN, 2);
        expect(frame.z[i]).toBeCloseTo(want.direction[i] ?? NaN, 5);
      }
    }
  });

  it("takes a rectangular connector's width axis as the port's local x", async () => {
    const base = await build(rooftopUnit);
    const unit = ofKind(base, "part").find((p) => p.mark === "RTU-1");
    const type = unit ? base.elements[unit.typeId] : undefined;
    if (!unit || type?.kind !== "part_type") throw new Error("no RTU-1");
    const first = type.definition.connectors.find((c) => c.shape === "rect");
    if (!first) throw new Error("no rectangular connector");
    const [dx, dy, dz] = first.direction;
    // A width axis square to the connector's direction, and not the level one a port gets when none is stated.
    const across: [number, number, number] = Math.abs(dz) > 0.9 ? [0.6, 0.8, 0] : [-dy * 0.6, dx * 0.6, 0.8 * Math.hypot(dx, dy)];
    const stated = { ...type, definition: { ...type.definition, connectors: type.definition.connectors.map((c) => (c.id === first.id ? { ...c, widthAxis: across } : c)) } };
    const level: PartInstance = { ...unit, rotationDeg: 0 };
    const x = exported({ ...base, elements: { ...base.elements, [stated.id]: stated, [level.id]: level } });
    const port = x.portsOf(unit.id).find((p) => text(p, 2) === first.label);
    if (!port) throw new Error("no port");
    const frame = frameOf(x.file, ref(port, 5));
    const n = Math.hypot(...across);
    for (const i of [0, 1, 2]) expect(frame.x[i]).toBeCloseTo((across[i] ?? NaN) / n, 6);
  });
});

describe("standard port property sets", () => {
  const MM = "IFCPOSITIVELENGTHMEASURE";
  const duct = (id: string, size: RunSize, flow: number): RunSegment => ({
    id: asElementId(id), kind: "run_segment", version: 1, authoredRev: {}, domain: "duct", systemId: asElementId("sys-sa"), levelId: asElementId("lvl-1"),
    start: { x: 0, y: 0, z: 1000 }, end: { x: 2000, y: 0, z: 1000 }, size, flow, links: {}, branches: [],
  });

  /** The tap-and-tee model with these run segments added to its air system. */
  function withRuns(...runs: RunSegment[]): { model: ModelState; x: Exported } {
    const base = tapAndTee();
    const model: ModelState = { ...base, elements: { ...base.elements, ...Object.fromEntries(runs.map((r) => [r.id, r])) } };
    return { model, x: exported(model) };
  }

  it("a rectangular duct end: NominalWidth and NominalHeight in millimetres, and the air it carries as a flow rate", () => {
    const { x } = withRuns(duct("rect-run", { shape: "rect", width: 400, height: 300 }, 2000));
    const [start, end] = x.portsOf("rect-run");
    if (!start || !end) throw new Error("no ports");
    expect([text(start, 2), text(end, 2), text(start, 8)]).toEqual(["Start", "End", "DUCT"]);
    const sets = x.setsOf(start);
    expect(Object.keys(sets)).toEqual(["Pset_DistributionPortTypeDuct"]);
    expect(sets.Pset_DistributionPortTypeDuct).toEqual({
      NominalWidth: { entity: "IFCPROPERTYSINGLEVALUE", measure: "IFCNONNEGATIVELENGTHMEASURE", value: 400 },
      NominalHeight: { entity: "IFCPROPERTYSINGLEVALUE", measure: MM, value: 300 },
      // 2000 CFM in the file's flow unit, cubic metres per second.
      VolumetricFlowRate: { entity: "IFCPROPERTYBOUNDEDVALUE", measure: "IFCVOLUMETRICFLOWRATEMEASURE", value: expect.closeTo(2000 * 0.3048 ** 3 / 60, 9) },
    });
    expect(x.setsOf(end)).toEqual(sets);
    expect(ofType(x.file, "IFCDERIVEDUNIT").map((u) => text(u, 1))).toContain("VOLUMETRICFLOWRATEUNIT");
  });

  it("a round duct end: its diameter as NominalWidth and no NominalHeight; a flat oval one: both", () => {
    const { x } = withRuns(duct("round-run", { shape: "round", diameter: 250 }, 0), duct("oval-run", { shape: "oval", width: 500, height: 200 }, 0));
    expect(x.setsOf(x.portsOf("round-run")[0]!)).toEqual({ Pset_DistributionPortTypeDuct: { NominalWidth: { entity: "IFCPROPERTYSINGLEVALUE", measure: "IFCNONNEGATIVELENGTHMEASURE", value: 250 } } });
    expect(Object.keys(x.setsOf(x.portsOf("oval-run")[0]!).Pset_DistributionPortTypeDuct ?? {}).sort()).toEqual(["NominalHeight", "NominalWidth"]);
  });

  it("a pipe end: NominalDiameter, and no flow rate (a pipe's number may be fixture units)", () => {
    const { model, x } = withRuns();
    const pipe = ofKind(model, "run_segment").find((s) => s.domain === "pipe");
    if (!pipe) throw new Error("no pipe");
    const carrying: RunSegment = { ...pipe, flow: 12 };
    const y = exported({ ...model, elements: { ...model.elements, [carrying.id]: carrying } });
    for (const out of [x, y]) {
      for (const port of out.portsOf(pipe.id).slice(0, 2)) {
        expect(text(port, 8)).toBe("PIPE");
        expect(out.setsOf(port)).toEqual({ Pset_DistributionPortTypePipe: { NominalDiameter: { entity: "IFCPROPERTYSINGLEVALUE", measure: MM, value: 25.4 } } });
      }
    }
  });

  it("a fitting port: the size of that opening", () => {
    const { model, x } = withRuns();
    const tap = ofKind(model, "run_fitting").find((f) => f.domain === "duct" && f.host);
    if (!tap) throw new Error("no tap");
    const branch = x.portsOf(tap.id).find((p) => text(p, 2) === tap.ports[0]?.id);
    if (!branch) throw new Error("no branch port");
    expect(x.setsOf(branch)).toEqual({ Pset_DistributionPortTypeDuct: { NominalWidth: { entity: "IFCPROPERTYSINGLEVALUE", measure: "IFCNONNEGATIVELENGTHMEASURE", value: 8 * IN } } });
  });

  it("a conduit end has no standard set of its own, and gets none of ours", () => {
    const conduit: RunSegment = { ...duct("conduit-run", { shape: "conduit", tradeSizeMm: 19.05, conduitType: "emt" }, 0), domain: "conduit" };
    const { x } = withRuns(conduit);
    const [start] = x.portsOf("conduit-run");
    if (!start) throw new Error("no port");
    expect(text(start, 8)).toBe("CABLECARRIER");
    expect(x.setsOf(start)).toEqual({});
  });

  it("a part's connectors: a duct opening's size, an electrical one's voltage, and its design flow where the type states one", async () => {
    const air = await build(rooftopUnit);
    const unit = ofKind(air, "part").find((p) => p.mark === "RTU-1");
    const type = unit ? air.elements[unit.typeId] : undefined;
    if (!unit || type?.kind !== "part_type") throw new Error("no RTU-1");
    // The unit as placed, and again with a design flow of 4000 CFM stated on its first duct connector.
    const first = type.definition.connectors.find((c) => c.domain === "duct" && c.shape === "rect");
    if (!first) throw new Error("no duct connector");
    const stated = { ...type, definition: { ...type.definition, connectors: type.definition.connectors.map((c) => (c.id === first.id ? { ...c, flow: 4000 } : c)) } };
    const x = exported({ ...air, elements: { ...air.elements, [stated.id]: stated } });
    const resolved = resolveConnectors(stated.definition, unit.values).find((c) => c.id === first.id);
    const port = x.portsOf(unit.id).find((p) => text(p, 2) === first.label);
    if (!port || !resolved) throw new Error("no port");
    expect(x.setsOf(port)).toEqual({
      Pset_DistributionPortTypeDuct: {
        NominalWidth: { entity: "IFCPROPERTYSINGLEVALUE", measure: "IFCNONNEGATIVELENGTHMEASURE", value: expect.closeTo(resolved.width ?? NaN, 6) },
        NominalHeight: { entity: "IFCPROPERTYSINGLEVALUE", measure: MM, value: expect.closeTo(resolved.height ?? NaN, 6) },
        VolumetricFlowRate: { entity: "IFCPROPERTYBOUNDEDVALUE", measure: "IFCVOLUMETRICFLOWRATEMEASURE", value: expect.closeTo(4000 * 0.3048 ** 3 / 60, 9) },
      },
    });

    const power = await build(electricalRoom);
    const y = exported(power);
    let withVoltage = 0;
    for (const part of ofKind(power, "part")) {
      const t = power.elements[part.typeId];
      if (t?.kind !== "part_type") continue;
      for (const c of resolveConnectors(t.definition, part.values)) {
        if (c.domain !== "electrical" || !(c.voltage && c.voltage > 0)) continue;
        const p = y.portsOf(part.id).find((q) => text(q, 2) === c.label);
        if (!p) throw new Error(`no port ${c.label}`);
        expect(text(p, 8)).toBe("CABLE");
        expect(y.setsOf(p)).toEqual({ Pset_DistributionPortTypeCable: { Voltage: { entity: "IFCPROPERTYBOUNDEDVALUE", measure: "IFCELECTRICVOLTAGEMEASURE", value: c.voltage } } });
        withVoltage++;
      }
    }
    expect(withVoltage).toBeGreaterThan(0);
  });

  it("ports with the same values share one set, and no port has a MutinyBIM set", async () => {
    const x = exported(await build(plumbingRiser));
    const ports = ofType(x.file, "IFCDISTRIBUTIONPORT");
    const portSets = ofType(x.file, "IFCPROPERTYSET").filter((s) => (text(s, 2) ?? "").startsWith("Pset_DistributionPort"));
    const sizes = new Set(ports.map((p) => JSON.stringify(x.setsOf(p))));
    expect(portSets.length).toBe(sizes.size);
    expect(portSets.length).toBeLessThan(ports.length / 4);
    for (const p of ports) expect(Object.keys(x.setsOf(p)).filter((n) => !n.startsWith("Pset_"))).toEqual([]);
  });
});

describe("a branch fitting on a trunk that stays one piece", () => {
  let model: ModelState;
  let x: Exported;
  beforeAll(() => {
    model = tapAndTee();
    x = exported(model);
  });

  const hosted = (domain: "duct" | "pipe"): { fitting: RunFitting; trunk: RunSegment } => {
    const fitting = ofKind(model, "run_fitting").find((f) => f.domain === domain && f.host);
    const trunk = fitting?.host ? model.elements[fitting.host.segmentId] : undefined;
    if (!fitting || trunk?.kind !== "run_segment") throw new Error(`no ${domain} branch fitting`);
    return { fitting, trunk };
  };

  it("the fixture has a duct tap and a pipe tee, each with one port of its own", () => {
    expect([hosted("duct").fitting.fittingType, hosted("duct").fitting.ports.length]).toEqual(["tap", 1]);
    expect([hosted("pipe").fitting.fittingType, hosted("pipe").fitting.ports.length]).toEqual(["tee", 1]);
  });

  it.each(["duct", "pipe"] as const)("%s: the trunk has a port where the branch leaves it, at the right distance along it, facing the branch", (domain) => {
    const { fitting, trunk } = hosted(domain);
    const host = fitting.host;
    if (!host) throw new Error("no host");
    const ports = x.portsOf(trunk.id);
    // Its two ends first, then its branches.
    expect(ports.map((p) => [text(p, 2), text(p, 4)])).toEqual([["Start", null], ["End", null], ["Branch", "Branch"]]);
    const branchPort = ports[2]!;
    expect(ref(get(x.file, ref(branchPort, 5)), 0)).toBe(ref(x.entityOf(trunk.id), 5));
    const frame = frameOf(x.file, ref(branchPort, 5));
    const up = elevationOf(model, trunk.levelId);
    const start: V3 = [trunk.start.x, trunk.start.y, trunk.start.z + up];
    const length = Math.hypot(trunk.end.x - trunk.start.x, trunk.end.y - trunk.start.y, trunk.end.z - trunk.start.z);
    const along: V3 = [(trunk.end.x - trunk.start.x) / length, (trunk.end.y - trunk.start.y) / length, (trunk.end.z - trunk.start.z) / length];
    // The distance along the trunk from its start is the kernel's `host.s`, strictly inside the trunk.
    const s = dot([frame.origin[0] - start[0], frame.origin[1] - start[1], frame.origin[2] - start[2]], along);
    expect(s).toBeCloseTo(host.s, 2);
    expect(host.s).toBeGreaterThan(0);
    expect(host.s).toBeLessThan(length);
    const where = hostedPoints(trunk, host.s, host.side, host.dir, host.face, host.t);
    expect([frame.origin[0], frame.origin[1], frame.origin[2] - up].map((c) => Math.round(c * 100) / 100)).toEqual([where.onAxis.x, where.onAxis.y, where.onAxis.z].map((c) => Math.round(c * 100) / 100));
    for (const [i, c] of [where.outward.x, where.outward.y, where.outward.z].entries()) expect(frame.z[i]).toBeCloseTo(c, 6);
    // Out of the side of the trunk, the way the fitting's own port leaves.
    expect(Math.abs(dot(frame.z, along))).toBeLessThan(1e-6);
    const own = fitting.ports[0]!;
    expect(dot(frame.z, [own.direction.x, own.direction.y, own.direction.z])).toBeCloseTo(1, 5);
    // The opening in the trunk is the branch's size.
    const size = Object.values(x.setsOf(branchPort))[0] ?? {};
    expect(Object.values(size).map((v) => v.value)).toEqual([own.size.shape === "round" ? own.size.diameter : own.size.shape === "pipe" ? own.size.nominalMm : NaN]);
  });

  it.each(["duct", "pipe"] as const)("%s: that port is joined once to a port of the fitting that faces into the trunk, and the fitting's own port still meets the branch", (domain) => {
    const { fitting, trunk } = hosted(domain);
    const branchPort = x.portsOf(trunk.id)[2]!;
    const fittingPorts = x.portsOf(fitting.id);
    const own = fitting.ports[0]!;
    expect(fittingPorts.map((p) => [text(p, 2), text(p, 4)])).toEqual([[own.id, null], ["Trunk", "Trunk"]]);
    const trunkPort = fittingPorts[1]!;
    expect(x.partnerOf(branchPort).map((p) => p.id)).toEqual([trunkPort.id]);
    expect(x.partnerOf(trunkPort).map((p) => p.id)).toEqual([branchPort.id]);
    const a = frameOf(x.file, ref(branchPort, 5));
    const b = frameOf(x.file, ref(trunkPort, 5));
    expect(Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2])).toBeLessThan(0.01);
    expect(dot(a.z, b.z)).toBeCloseTo(-1, 6);
    expect(ref(get(x.file, ref(trunkPort, 5)), 0)).toBe(ref(x.entityOf(fitting.id), 5));
    // The kernel's own branch port keeps its one join, to the branch run.
    const branchRun = own.link ? x.portsOf(own.link.elementId).find((p) => text(p, 2) === (own.link?.port === "start" ? "Start" : "End")) : undefined;
    expect(x.partnerOf(fittingPorts[0]!).map((p) => p.id)).toEqual([branchRun?.id]);
  });

  it("no port is in more than one connection, no connection is written twice, and every port is nested once", () => {
    const uses = new Map<number, number>();
    const pairs = new Set<string>();
    for (const c of x.connections) {
      const pair = [ref(c, 4), ref(c, 5)].sort((p, q) => p - q).join("~");
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
      expect(ref(c, 4)).not.toBe(ref(c, 5));
      for (const id of [ref(c, 4), ref(c, 5)]) uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    expect([...uses.values()].filter((n) => n !== 1)).toEqual([]);
    const nested = ofType(x.file, "IFCRELNESTS").flatMap((r) => refs(r, 5));
    expect(new Set(nested).size).toBe(nested.length);
    for (const p of ofType(x.file, "IFCDISTRIBUTIONPORT")) expect(nested).toContain(p.id);
  });

  it("the ports and their join keep their GlobalIds when something else in the model changes", () => {
    const { fitting, trunk } = hosted("duct");
    const ids = (out: Exported) => {
      const branchPort = out.portsOf(trunk.id)[2]!;
      const trunkPort = out.portsOf(fitting.id)[1]!;
      const join = out.connections.find((c) => [ref(c, 4), ref(c, 5)].includes(branchPort.id));
      return [text(branchPort, 0), text(trunkPort, 0), text(join, 0)];
    };
    const other: RunSegment = { ...trunk, id: asElementId("another-run"), start: { ...trunk.start, y: 9000 }, end: { ...trunk.end, y: 9000 }, links: {}, branches: [] };
    const after = exported({ ...model, elements: { ...model.elements, [other.id]: other } });
    expect(ids(after)).toEqual(ids(x));
    expect(ids(x).every((id) => /^[0-3][0-9A-Za-z_$]{21}$/.test(id ?? ""))).toBe(true);
  });

  it("says so in plain words when the trunk is not in the file, and writes the fitting's own port as before", () => {
    const { fitting } = hosted("duct");
    const host = fitting.host;
    if (!host) throw new Error("no host");
    const lost: RunFitting = { ...fitting, host: { ...host, segmentId: asElementId("gone") } };
    const out = exported({ ...model, elements: { ...model.elements, [lost.id]: lost } });
    expect(out.warnings.filter((w) => w.startsWith(`${fitting.id}:`))).toEqual([`${fitting.id}: the run it branches from is not in the file, so the file does not say where on that run it sits`]);
    expect(out.portsOf(fitting.id).map((p) => text(p, 2))).toEqual([fitting.ports[0]?.id]);
    expect(ofType(out.file, "IFCDISTRIBUTIONPORT").filter((p) => text(p, 4) === "Branch" && out.partnerOf(p).length === 0)).toEqual([]);
  });
});

describe("a rectangular duct's port keeps the kernel's width axis where the port faces straight up or down", () => {
  const WIDE: RunSize = { shape: "rect", width: 24 * IN, height: 8 * IN };
  const AIR = { id: "sys-sa", kind: "supply_air", name: "Supply Air 1" };
  const Z0 = 10 * FT;

  /** A level leg along `heading`, then straight up: a wide flat duct turning into a riser. */
  function intoRiser(heading: "north" | "east"): ModelState {
    const m = new Log({ modelId: "ports", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const corner = heading === "north" ? { x: 0, y: 10 * FT } : { x: 10 * FT, y: 0 };
    m.ok({ type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "duct", size: WIDE, elevationMm: Z0, system: AIR, points: [{ x: 0, y: 0 }, corner, { ...corner, elevationMm: Z0 + 8 * FT }] });
    return m.head;
  }

  const riserOf = (model: ModelState): RunSegment => {
    const riser = ofKind(model, "run_segment").find((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 1e-6);
    if (!riser) throw new Error("no riser");
    return riser;
  };

  /** |cosine| between a port frame's local x and an axis: 1 when the port's width lies along it. */
  const along = (frame: Frame, axis: { readonly x: number; readonly y: number; readonly z: number }) => Math.abs(dot(frame.x, [axis.x, axis.y, axis.z]));

  it.each([
    ["north", [1, 0, 0]],
    ["east", [0, 1, 0]],
  ] satisfies ["north" | "east", V3][])("turning from %s into a riser: the riser's ends and the elbow's port up have their width along the kernel's axis, as the elbow's body has", (heading, expected) => {
    const model = intoRiser(heading);
    const riser = riserOf(model);
    const kernel = segmentWidthAxis(model.elements, riser);
    expect([Math.abs(kernel.x), Math.abs(kernel.y), Math.abs(kernel.z)].map((c) => Math.round(c * 1e6) / 1e6)).toEqual(expected);
    const x = exported(model);
    for (const port of x.portsOf(riser.id)) {
      const frame = frameOf(x.file, ref(port, 5));
      expect(Math.abs(frame.z[2])).toBeCloseTo(1, 6);
      expect(along(frame, kernel)).toBeCloseTo(1, 6);
    }
    const elbow = ofKind(model, "run_fitting").find((f) => f.fittingType === "elbow");
    const up = elbow?.ports.find((p) => Math.abs(p.direction.z) > 0.999);
    if (!elbow || !up) throw new Error("no elbow into the riser");
    const atPort = portWidthAxis(model.elements, { elementId: elbow.id, port: up.id });
    expect(atPort ? Math.abs(dot([atPort.x, atPort.y, atPort.z], [kernel.x, kernel.y, kernel.z])) : NaN).toBeCloseTo(1, 6);
    const upPort = x.portsOf(elbow.id).find((p) => text(p, 2) === up.id);
    if (!upPort) throw new Error("no port");
    expect(along(frameOf(x.file, ref(upPort, 5)), kernel)).toBeCloseTo(1, 6);

    // The elbow's exported body agrees: where it meets the riser it is 24 in across along that axis and 8 in the other way.
    const body = get(x.file, refs(get(x.file, refs(get(x.file, ref(x.entityOf(elbow.id), 6)), 2)[0] ?? -1), 3)[0] ?? -1);
    expect(body.type).toBe("IFCTRIANGULATEDFACESET");
    const coords = get(x.file, ref(body, 0)).args[0];
    const points = coords?.kind === "list" ? coords.items.map((p) => (p.kind === "list" ? p.items.map((c) => (c.kind === "number" ? c.value : NaN)) : [])) : [];
    const top = Math.max(...points.map((p) => p[2] ?? -Infinity));
    const face = points.filter((p) => Math.abs((p[2] ?? NaN) - top) < 0.5);
    const extent = (i: number) => Math.max(...face.map((p) => p[i] ?? NaN)) - Math.min(...face.map((p) => p[i] ?? NaN));
    expect(expected[0] === 1 ? extent(0) : extent(1)).toBeCloseTo(24 * IN, 0);
    expect(expected[0] === 1 ? extent(1) : extent(0)).toBeCloseTo(8 * IN, 0);
  });

  it("a level or sloped end keeps its width level and square to the run, as the kernel has it", () => {
    const model = intoRiser("north");
    const level = ofKind(model, "run_segment").find((s) => s.id !== riserOf(model).id);
    if (!level) throw new Error("no level leg");
    const sloped: RunSegment = { ...level, id: asElementId("sloped-run"), start: { x: 5000, y: 0, z: 3000 }, end: { x: 8000, y: 4000, z: 3600 }, links: {}, branches: [] };
    const full: ModelState = { ...model, elements: { ...model.elements, [sloped.id]: sloped } };
    const x = exported(full);
    for (const seg of [level, sloped]) {
      const kernel = segmentWidthAxis(full.elements, seg);
      for (const port of x.portsOf(seg.id)) {
        const frame = frameOf(x.file, ref(port, 5));
        expect(along(frame, kernel)).toBeCloseTo(1, 6);
        expect(frame.x[2]).toBeCloseTo(0, 9);
      }
    }
  });

  it("a riser joined to nothing takes the kernel's default width axis, and a round riser needs none", () => {
    const base = intoRiser("north");
    const riser = riserOf(base);
    const alone: RunSegment = { ...riser, id: asElementId("alone-riser"), start: { x: 9000, y: 9000, z: 0 }, end: { x: 9000, y: 9000, z: 2000 }, links: {}, branches: [] };
    const round: RunSegment = { ...alone, id: asElementId("round-riser"), start: { x: 12000, y: 9000, z: 0 }, end: { x: 12000, y: 9000, z: 2000 }, size: { shape: "round", diameter: 250 } };
    const model: ModelState = { ...base, elements: { ...base.elements, [alone.id]: alone, [round.id]: round } };
    const x = exported(model);
    expect(segmentWidthAxis(model.elements, alone)).toEqual(RISER_DEFAULT_WIDTH_AXIS);
    for (const port of x.portsOf(alone.id)) expect(along(frameOf(x.file, ref(port, 5)), RISER_DEFAULT_WIDTH_AXIS)).toBeCloseTo(1, 6);
    for (const port of x.portsOf(round.id)) {
      const frame = frameOf(x.file, ref(port, 5));
      expect(frame.hasAxis).toBe(true);
      expect(Math.abs(dot(frame.x, frame.z))).toBeLessThan(1e-9);
    }
  });

  it("a tap off the top of a trunk: the trunk's branch port and the tap's ports have their width along the trunk", () => {
    const m = new Log({ modelId: "ports", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 24 * IN, height: 12 * IN }, elevationMm: Z0, system: AIR, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
    const small: RunSize = { shape: "rect", width: 12 * IN, height: 6 * IN };
    m.ok({ type: "route_run", idPrefix: "D", levelId: "lvl-1", domain: "duct", size: small, elevationMm: Z0 + 4 * FT, system: AIR, points: [{ x: 8 * FT, y: 8 * FT }, { x: 8 * FT, y: 0, elevationMm: Z0 + 3 * FT }] });
    m.ok({ type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "duct", size: small, elevationMm: Z0 + 6 * IN, system: AIR, points: [{ x: 8 * FT, y: 0 }], from: { kind: "run_end", elementId: "D-s2", port: "end" }, to: { kind: "run_branch", segmentId: "T-s1", face: "top" } });
    const model = m.head;
    const tap = ofKind(model, "run_fitting").find((f) => f.host?.segmentId === "T-s1");
    const own = tap?.ports[0];
    if (!tap || !own) throw new Error("no tap");
    expect(Math.abs(own.direction.z)).toBeCloseTo(1, 6);
    const x = exported(model);
    const ports = [x.portsOf("T-s1").find((p) => text(p, 4) === "Branch"), ...x.portsOf(tap.id)];
    expect(ports).toHaveLength(3);
    for (const port of ports) {
      if (!port) throw new Error("no port");
      const frame = frameOf(x.file, ref(port, 5));
      expect(Math.abs(frame.z[2])).toBeCloseTo(1, 6);
      expect(along(frame, { x: 1, y: 0, z: 0 })).toBeCloseTo(1, 6);
    }
  });
});
