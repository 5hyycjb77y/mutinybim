/**
 * @jest-environment node
 *
 * A part read back by importIfc has its connection points (#65, #135 step 2).
 * It used to come in with none ("10 ton: its 2 connection points weren't
 * brought in; join it by hand"), so nothing could be joined to it. The reader
 * now hands the importer each port's position, the way it faces, what it
 * connects to and carries, its opening's size and its flow direction, and the
 * part rule writes them as the part type's connectors, measured from the
 * part's own point along its own axes. A port the file gives no position, or
 * says nothing of the kind of, stays out, and the report says how many and why.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, landImport, planIfcImport, resolveConnectors, worldConnector, type BimElement, type ModelState, type PartConnector, type PartInstance } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc, readIfcSource } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";
import plumbingRiser from "../../bim-script/examples/plumbing-riser";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import smallOffice from "../../bim-script/examples/small-office";
import { IfcText, hostModel } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";
const SOURCE = { referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture", "mechanical", "electrical", "plumbing"] };
const EMPTY: ModelState = { modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };

/** Runs a script on an empty model and commits its edits through the kernel. */
async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-part-connectors" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

const ofKind = <K extends BimElement["kind"]>(els: readonly BimElement[], kind: K) => els.filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);

/** A placed part's connectors where they are in the model: plan position, height above the level's floor, and the way each faces. */
function placedConnectors(els: readonly BimElement[], part: PartInstance) {
  const type = els.find((e) => e.id === part.typeId);
  if (type?.kind !== "part_type") throw new Error(`${part.id} has no part type`);
  return resolveConnectors(type.definition, part.values).map((c) => {
    const world = worldConnector(part, c);
    const stored = type.definition.connectors.find((d) => d.id === c.id);
    return { ...c, flowDirection: stored?.flowDirection, widthAxis: stored?.widthAxis, at: world.position, facing: world.direction };
  });
}

/** The connection-point notes that say something wasn't brought in. */
const leftOut = (notes: readonly string[]): string[] => notes.filter((n) => n.includes("connection point") && /(wasn't|weren't) brought in/.test(n));

/** A model's export read back into an empty model, each placed part paired with what it became. */
function roundTrip(model: ModelState) {
  const { text, report } = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const plan = importIfc(text, { model: EMPTY, ...SOURCE });
  const source = readIfcSource(text, SOURCE);
  const stored = Object.values(model.elements);
  const imported = new Map(ofKind(plan.records, "part").map((p) => [p.provenance?.ifcGlobalId, p]));
  const pairs = ofKind(stored, "part").map((was) => {
    const guid = report.globalIds[was.id];
    const got = imported.get(guid);
    const product = source.products.find((p) => p.sourceId === guid);
    if (!got || !product) throw new Error(`${was.id} didn't come back as a part`);
    return { was, got, product, before: placedConnectors(stored, was), after: placedConnectors(plan.records, got) };
  });
  return { text, plan, pairs };
}

describe("importIfc brings a part's connection points back (#65)", () => {
  it.each([
    ["rooftop-unit", rooftopUnit, 1, 2],
    ["electrical-room", electricalRoom, 12, 12],
    ["plumbing-riser", plumbingRiser, 8, 28],
    ["small-office", smallOffice, 0, 0],
  ] as const)("%s: every connector comes back where it was, connecting to and carrying what it did", async (_name, script, parts, connectors) => {
    const { plan, pairs } = roundTrip(await build(script));
    expect(pairs).toHaveLength(parts);
    expect(pairs.reduce((n, p) => n + p.before.length, 0)).toBe(connectors);
    for (const { before, after, product } of pairs) {
      expect(after.map((c) => c.label).sort()).toEqual(before.map((c) => c.label).sort());
      for (const was of before) {
        const got = after.find((c) => c.label === was.label);
        const port = product.ports.find((p) => p.name === was.label);
        if (!got || !port) throw new Error(`${was.label} didn't come back`);
        // Where it is in the model, to 0.1 mm.
        for (const axis of ["x", "y", "z"] as const) expect(Math.abs(got.at[axis] - was.at[axis])).toBeLessThanOrEqual(0.1);
        expect(got).toMatchObject({ domain: was.domain, systemKind: was.systemKind });
        expect(got.flowDirection).toBe(was.flowDirection);
        // It faces the way it did: the file says so for every port of ours.
        expect(port.direction).not.toBeNull();
        for (const axis of ["x", "y", "z"] as const) expect(got.facing[axis]).toBeCloseTo(was.facing[axis], 6);
        // Its opening is the shape and size it was.
        expect(got.shape).toBe(was.shape);
        for (const side of ["width", "height", "diameter"] as const) {
          if (was[side] === undefined) expect(got[side]).toBeUndefined();
          else expect(got[side]).toBeCloseTo(was[side] ?? 0, 5);
        }
        // What it is rated at: a duct's or pipe's design flow, an electrical connector's voltage. A flow of nothing isn't written.
        if (was.domain !== "electrical" && was.flow) expect(got.flow).toBeCloseTo(was.flow, 4);
        else expect(got.flow).toBeUndefined();
        if (was.voltage === undefined) expect(got.voltage).toBeUndefined();
        else expect(got.voltage).toBeCloseTo(was.voltage, 5);
      }
    }
    expect(leftOut(plan.report.notes)).toEqual([]);
    // Nothing is left to check by hand: every port says which way it faces.
    expect(plan.report.notes.filter((n) => n.includes("which way"))).toEqual([]);
    expect(landImport(EMPTY, plan.records).dropped).toEqual([]);
  });

  it("rooftop-unit: the 10 ton unit has its supply and return openings on its underside", async () => {
    const { plan, pairs } = roundTrip(await build(rooftopUnit));
    const type = plan.records.find((r) => r.id === pairs[0]?.got.typeId);
    expect(type?.kind === "part_type" ? type.definition.connectors : null).toMatchObject([
      { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", position: [-762, 0, 0], direction: [0, 0, -1], shape: "rect", width: 1168.4, height: 305, widthAxis: [0, 1, 0] },
      { id: "return", label: "Return", domain: "duct", systemKind: "return_air", position: [762, 0, 0], direction: [0, 0, -1], shape: "rect", width: 1168.4, height: 305, widthAxis: [0, 1, 0] },
    ]);
    expect(plan.report.notes).toEqual([]);
  });

  it("electrical-room: panel LP-1 has its feeder connector, and the receptacles share one type with theirs", async () => {
    const { plan, pairs } = roundTrip(await build(electricalRoom));
    const panel = pairs.find((p) => p.was.mark === "LP-1");
    const panelType = plan.records.find((r) => r.id === panel?.got.typeId);
    expect(panelType?.kind === "part_type" ? panelType.definition.connectors : null).toEqual([{ id: "feeder", label: "Feeder", domain: "electrical", systemKind: "power", position: [0, 0, 762], direction: [0, 0, 1], shape: "none", voltage: 208 }]);
    const receptacles = pairs.filter((p) => p.was.mark !== "LP-1");
    // Turned onto all four walls, each with its connector at the same point of the part: one part type still.
    expect(new Set(receptacles.map((p) => p.got.rotationDeg))).toEqual(new Set([0, 90, 180, 270]));
    expect(new Set(receptacles.map((p) => p.got.typeId)).size).toBe(1);
    expect(ofKind(plan.records, "part_type")).toHaveLength(2);
  });
});

describe("an imported part can be connected by hand (#65)", () => {
  it("rooftop-unit: a duct routes from the imported unit's supply opening and is joined to it", async () => {
    // A file that joins the unit to nothing (its port joins left out): the unit comes in with its openings free. With the joins, it comes in joined (import-run-fittings).
    const read = readIfcSource(exportIfc({ model: await build(rooftopUnit), project: PROJECT, timeStamp: TIME_STAMP }).text, SOURCE);
    const plan = planIfcImport({ ...read, products: read.products.map((p) => ({ ...p, ports: p.ports.map((port) => ({ ...port, connectedTo: [] })) })) }, { model: EMPTY, ...SOURCE });
    const unit = ofKind(plan.records, "part")[0];
    if (!unit) throw new Error("the unit didn't come back");
    expect(unit.links).toBeUndefined();
    const m = new Log(landImport(EMPTY, plan.records).model);
    m.ok({
      type: "route_run",
      idPrefix: "by-hand",
      levelId: unit.levelId,
      domain: "duct",
      size: { shape: "rect", width: 600, height: 300 },
      elevationMm: 3000,
      system: { id: "sa-by-hand", kind: "supply_air", name: "Supply air by hand" },
      points: [{ x: unit.position.x - 762, y: unit.position.y - 3000 }],
      from: { kind: "part", partId: unit.id, connectorId: "supply" },
    });
    const joined = m.head.elements[unit.id];
    expect(joined?.kind === "part" ? joined.links?.supply?.elementId : null).toEqual(expect.stringContaining("by-hand"));
  });

  it("electrical-room: an imported receptacle goes on a circuit; an imported panel can't feed one yet (its type's values aren't brought in)", async () => {
    const model = await build(electricalRoom);
    const { text } = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
    // Read back into the model it came from, beside the parts it was made from.
    const plan = importIfc(text, { model, ...SOURCE });
    const m = new Log(landImport(model, plan.records).model);
    const own = ofKind(Object.values(model.elements), "part");
    const ownPanel = own.find((p) => p.mark === "LP-1");
    const came = ofKind(plan.records, "part");
    const panel = came.find((p) => p.mark === "LP-1");
    const receptacle = came.find((p) => p.mark !== "LP-1");
    if (!ownPanel || !panel || !receptacle) throw new Error("the panel or a receptacle is missing");
    // Fed from the model's own panel: the receptacle's one connector is found, with the 120 V the file's port set gives it.
    const type = plan.records.find((r) => r.id === receptacle.typeId);
    expect(type?.kind === "part_type" ? type.definition.connectors : null).toMatchObject([{ id: "power", domain: "electrical", voltage: 120 }]);
    m.ok({ type: "create_service_link", linkId: "by-hand", sourceId: ownPanel.id, members: [{ elementId: receptacle.id }] });
    const link = m.head.elements["by-hand"];
    expect(link?.kind === "service_link" ? link.members.map((x) => ({ elementId: x.elementId, connector: x.connector })) : null).toEqual([{ elementId: receptacle.id, connector: "power" }]);
    // Feeding from the imported panel needs its voltage and phases as values of its type, which aren't brought in yet.
    expect(m.refused({ type: "create_service_link", linkId: "from-imported", sourceId: panel.id, members: [{ elementId: receptacle.id }] })).toContain("can't feed anything");
  });
});

interface PortSpec {
  readonly name: string;
  /** In the host's own frame, in the file's unit. Absent: the port has no placement. */
  readonly at?: readonly [number, number, number];
  /** The port's own z (the way it faces) and x (along its width), in the host's frame. */
  readonly facing?: readonly [number, number, number];
  readonly across?: readonly [number, number, number];
  /** `.SINK.,.DUCT.,.AIRCONDITIONING.`: FlowDirection, PredefinedType, SystemType. Absent: the older, shorter port with a flow direction only. */
  readonly kind?: string;
  /** A standard port property set and its lengths, in the file's unit. */
  readonly set?: readonly [string, Readonly<Record<string, number>>];
}

interface Host {
  readonly id: number;
  readonly placement: number;
}

/** An air terminal at a placement the test spells out (`x` is its own x axis in the storey's frame). */
function terminal(t: IfcText, name: string, at: readonly [number, number, number], shape: number, opts: { readonly storey?: string; readonly x?: readonly [number, number, number]; readonly z?: readonly [number, number, number] } = {}): Host {
  const storey = t.storeys.get(opts.storey ?? "Level 1") ?? 0;
  const placement = t.place(t.storeyPlacements.get(opts.storey ?? "Level 1") ?? null, t.axis3(at, opts.z ?? [0, 0, 1], opts.x ?? [1, 0, 0]));
  const id = t.add("IFCAIRTERMINAL", `${t.guid()},$,'${name}',$,$,#${placement},#${shape},'${name}',.DIFFUSER.`);
  t.contained.set(storey, [...(t.contained.get(storey) ?? []), id]);
  return { id, placement };
}

/** A port as the file writes it: placed from `rel` (the host's placement, or anything else), or not placed at all. */
function port(t: IfcText, rel: number | null, spec: PortSpec): number {
  const placement = spec.at ? `#${t.place(rel, t.axis3(spec.at, spec.facing, spec.across))}` : "$";
  const id = t.add("IFCDISTRIBUTIONPORT", `${t.guid()},$,'${spec.name}',$,$,${placement},$,${spec.kind ?? ".NOTDEFINED."}`);
  if (spec.set) {
    const props = Object.entries(spec.set[1]).map(([k, v]) => `#${t.add("IFCPROPERTYSINGLEVALUE", `'${k}',$,IFCPOSITIVELENGTHMEASURE(${Number.isInteger(v) ? `${v}.` : v}),$`)}`);
    const set = t.add("IFCPROPERTYSET", `${t.guid()},$,'${spec.set[0]}',$,(${props.join(",")})`);
    t.add("IFCRELDEFINESBYPROPERTIES", `${t.guid()},$,$,$,(#${id}),#${set}`);
  }
  return id;
}

/** Ports nested on their host, placed from its placement: what IFC4 files (and exportIfc) write. */
function nest(t: IfcText, host: Host, specs: readonly PortSpec[]): number[] {
  const ids = specs.map((spec) => port(t, host.placement, spec));
  t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${host.id},(${ids.map((i) => `#${i}`).join(",")})`);
  return ids;
}

function foreign(make: (t: IfcText) => void, units: "mm" | "ft" = "mm") {
  const t = IfcText.start(units);
  t.storey("Level 1", 0);
  t.storey("Level 2", units === "ft" ? 12 : 3600);
  make(t);
  const text = t.text();
  const host = hostModel([
    { id: "L1", name: "Level 1", elevationMm: 0 },
    { id: "L2", name: "Level 2", elevationMm: units === "ft" ? 3657.6 : 3600 },
  ]);
  const source = readIfcSource(text, { sourceId: "ver-1", label: "Acme MEP", disciplines: ["mechanical"] });
  const plan = importIfc(text, { model: host, referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label: "Acme MEP", disciplines: ["mechanical"] });
  const records = [...plan.records, ...Object.values(host.elements)];
  const part = (name: string): PartInstance => {
    const p = ofKind(plan.records, "part").find((r) => r.mark === name);
    if (!p) throw new Error(`${name} didn't come in as a part`);
    return p;
  };
  const connectors = (name: string): readonly PartConnector[] => {
    const type = plan.records.find((r) => r.id === part(name).typeId);
    return type?.kind === "part_type" ? type.definition.connectors : [];
  };
  /** Each connector of a part where the model has it, in the host frame (heights from the host's zero). */
  const inModel = (name: string) => {
    const level = records.find((r) => r.id === part(name).levelId);
    const up = level?.kind === "level" ? level.elevationMm : 0;
    return placedConnectors(records, part(name)).map((c) => ({ label: c.label, at: { x: c.at.x, y: c.at.y, z: c.at.z + up }, facing: c.facing }));
  };
  const ports = (name: string) => source.products.find((p) => p.name === name)?.ports ?? [];
  return { host, source, plan, part, connectors, inModel, ports };
}

const COS30 = Math.cos(Math.PI / 6);
const DUCT_SUPPLY = ".SINK.,.DUCT.,.AIRCONDITIONING.";
const box = (t: IfcText, k = 1): number => t.body([t.extrude(t.rect(600 * k, 400 * k), 300 * k)]);
const near = (p: { readonly x: number; readonly y: number; readonly z: number }, digits = 4) => ({ x: expect.closeTo(p.x, digits), y: expect.closeTo(p.y, digits), z: expect.closeTo(p.z, digits) });

describe("importIfc reads ports from any file (#65)", () => {
  it("the reader gives a port's place and facing in the host frame, what it connects to and carries, and its opening", () => {
    const { ports } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t), { x: [0, 1, 0] });
      nest(t, host, [{ name: "Supply air", at: [300, 0, 150], facing: [1, 0, 0], across: [0, 1, 0], kind: DUCT_SUPPLY, set: ["Pset_DistributionPortTypeDuct", { NominalWidth: 400, NominalHeight: 200 }] }]);
    });
    // The host is turned 90°: its own x is the model's y, its own y the model's -x.
    expect(ports("SD-1")).toEqual([
      expect.objectContaining({ name: "Supply air", position: near({ x: 5000, y: 4300, z: 2850 }), direction: near({ x: 0, y: 1, z: 0 }), across: near({ x: -1, y: 0, z: 0 }), flow: "SINK", domain: "duct", systemType: "AIRCONDITIONING", size: { shape: "rect", width: 400, height: 200 } }),
    ]);
  });

  it("a turned part on an upper level: its connector is where the port is, measured from the part's own point", () => {
    const { plan, part, connectors, inModel, ports } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t), { storey: "Level 2", x: [COS30, 0.5, 0] });
      nest(t, host, [{ name: "Supply air", at: [300, 0, 150], facing: [1, 0, 0], across: [0, 1, 0], kind: DUCT_SUPPLY, set: ["Pset_DistributionPortTypeDuct", { NominalWidth: 400, NominalHeight: 200 }] }]);
    });
    expect(part("SD-1")).toMatchObject({ levelId: "L2", position: { x: 5000, y: 4000 }, offsetMm: 2700, rotationDeg: 30 });
    expect(connectors("SD-1")).toEqual([{ id: "supply_air", label: "Supply air", domain: "duct", systemKind: "supply_air", position: [300, 0, 150], direction: [1, 0, 0], shape: "rect", width: 400, height: 200, flowDirection: "in", widthAxis: [0, 1, 0] }]);
    const [at] = ports("SD-1");
    expect(at?.position).toEqual(near({ x: 5000 + 300 * COS30, y: 4150, z: 3600 + 2700 + 150 }));
    expect(inModel("SD-1")).toEqual([{ label: "Supply air", at: near(at?.position ?? { x: 0, y: 0, z: 0 }, 1), facing: near({ x: COS30, y: 0.5, z: 0 }) }]);
    expect(plan.report.notes).toEqual([]);
  });

  it("a file in feet: positions and opening sizes come in as millimetres", () => {
    const k = 1 / 304.8;
    const { part, connectors, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000 * k, 4000 * k, 2700 * k], box(t, k), { x: [0, 1, 0] });
      nest(t, host, [
        { name: "Supply air", at: [300 * k, 0, 150 * k], facing: [1, 0, 0], kind: DUCT_SUPPLY, set: ["Pset_DistributionPortTypeDuct", { NominalWidth: 1.5, NominalHeight: 0.5 }] },
        { name: "Drain", at: [0, -200 * k, 0], facing: [0, 0, -1], kind: ".SOURCE.,.PIPE.,.DRAINAGE.", set: ["Pset_DistributionPortTypePipe", { NominalDiameter: 0.25 }] },
        { name: "Round neck", at: [0, 0, 300 * k], facing: [0, 0, 1], kind: ".NOTDEFINED.,.DUCT.,.AIRCONDITIONING.", set: ["Pset_DistributionPortTypeDuct", { NominalWidth: 0.5 }] },
      ]);
    }, "ft");
    expect(part("SD-1")).toMatchObject({ position: { x: 5000, y: 4000 }, offsetMm: 2700, rotationDeg: 90 });
    expect(connectors("SD-1")).toMatchObject([
      { id: "supply_air", position: [300, 0, 150], direction: [1, 0, 0], shape: "rect", width: 457.2, height: 152.4, flowDirection: "in" },
      { id: "drain", domain: "pipe", systemKind: "condensate", position: [0, -200, 0], direction: [0, 0, -1], shape: "round", diameter: 76.2, flowDirection: "out" },
      // A width with no height is a round opening's diameter.
      { id: "round_neck", position: [0, 0, 300], direction: [0, 0, 1], shape: "round", diameter: 152.4 },
    ]);
    expect(connectors("SD-1")[2]).not.toHaveProperty("flowDirection");
    expect(leftOut(plan.report.notes)).toEqual([]);
  });

  it("one property set shared by many ports, with bounded values: each port gets its size, flow and voltage in the connector's units", () => {
    const { connectors, plan } = foreign((t) => {
      const one = terminal(t, "SD-1", [1000, 1000, 2700], box(t));
      const two = terminal(t, "SD-2", [5000, 4000, 2700], box(t));
      const ducts = [one, two].map((host) => nest(t, host, [{ name: "Supply air", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY }])[0] ?? 0);
      const [drain, power] = nest(t, two, [
        { name: "Drain", at: [0, -200, 0], facing: [0, 0, -1], kind: ".SOURCE.,.PIPE.,.DRAINAGE." },
        { name: "Power", at: [300, 0, 150], facing: [1, 0, 0], kind: ".SINK.,.CABLE.,.ELECTRICAL." },
      ]);
      const bounded = (name: string, measure: string, unit: number | null) => `#${t.add("IFCPROPERTYBOUNDEDVALUE", `'${name}',$,$,$,${unit ? `#${unit}` : "$"},${measure}`)}`;
      const share = (name: string, props: readonly string[], to: readonly number[]) => {
        const set = t.add("IFCPROPERTYSET", `${t.guid()},$,'${name}',$,(${props.join(",")})`);
        t.add("IFCRELDEFINESBYPROPERTIES", `${t.guid()},$,$,$,(${to.map((p) => `#${p}`).join(",")}),#${set}`);
      };
      // The file names no flow unit: a flow with none is cubic metres a second. 0.2 m3/s is 423.776 cfm.
      share("Pset_DistributionPortTypeDuct", [`#${t.add("IFCPROPERTYSINGLEVALUE", `'NominalWidth',$,IFCNONNEGATIVELENGTHMEASURE(250.),$`)}`, bounded("VolumetricFlowRate", "IFCVOLUMETRICFLOWRATEMEASURE(0.2)", null)], ducts);
      // A flow in litres a minute, the unit named on the property: 37.854118 L/min is 10 US gallons a minute.
      const litre = t.add("IFCCONVERSIONBASEDUNIT", `#${t.add("IFCDIMENSIONALEXPONENTS", "3,0,0,0,0,0,0")},.VOLUMEUNIT.,'LITRE',#${t.add("IFCMEASUREWITHUNIT", `IFCVOLUMEMEASURE(0.001),#${t.add("IFCSIUNIT", "*,.VOLUMEUNIT.,$,.CUBIC_METRE.")}`)}`);
      const minute = t.add("IFCCONVERSIONBASEDUNIT", `#${t.add("IFCDIMENSIONALEXPONENTS", "0,0,1,0,0,0,0")},.TIMEUNIT.,'MINUTE',#${t.add("IFCMEASUREWITHUNIT", `IFCTIMEMEASURE(60.),#${t.add("IFCSIUNIT", "*,.TIMEUNIT.,$,.SECOND.")}`)}`);
      const perMinute = t.add("IFCDERIVEDUNIT", `(#${t.add("IFCDERIVEDUNITELEMENT", `#${litre},1`)},#${t.add("IFCDERIVEDUNITELEMENT", `#${minute},-1`)}),.VOLUMETRICFLOWRATEUNIT.,$,$`);
      share("Pset_DistributionPortTypePipe", [`#${t.add("IFCPROPERTYSINGLEVALUE", `'NominalDiameter',$,IFCPOSITIVELENGTHMEASURE(31.75),$`)}`, bounded("VolumetricFlowRate", "IFCVOLUMETRICFLOWRATEMEASURE(37.854118)", perMinute)], [drain ?? 0]);
      // A voltage in kilovolts, the unit named on the property.
      share("Pset_DistributionPortTypeCable", [bounded("Voltage", "IFCELECTRICVOLTAGEMEASURE(0.48)", t.add("IFCSIUNIT", "*,.ELECTRICVOLTAGEUNIT.,.KILO.,.VOLT."))], [power ?? 0]);
    });
    const duct = { id: "supply_air", shape: "round", diameter: 250, flow: expect.closeTo(423.776, 2) };
    expect(connectors("SD-1")).toMatchObject([duct]);
    expect(connectors("SD-2")).toMatchObject([duct, { id: "drain", shape: "round", diameter: 31.75, flow: expect.closeTo(10, 4) }, { id: "power", domain: "electrical", systemKind: "power", shape: "none", voltage: 480 }]);
    expect(connectors("SD-2")[2]).not.toHaveProperty("flow");
    expect(plan.report.notes).toEqual([]);
  });

  it("a flow unit with a prefix on a cubic or square metre: the prefix counts once for each dimension", () => {
    const { connectors } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      const [cubic, square] = nest(t, host, [
        { name: "Supply air", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY },
        { name: "Return", at: [0, 0, 0], facing: [0, 0, -1], kind: DUCT_SUPPLY },
      ]);
      const second = () => t.add("IFCDERIVEDUNITELEMENT", `#${t.add("IFCSIUNIT", "*,.TIMEUNIT.,$,.SECOND.")},-1`);
      const flow = (to: number, value: string, elements: readonly number[]) => {
        const unit = t.add("IFCDERIVEDUNIT", `(${elements.map((e) => `#${e}`).join(",")}),.VOLUMETRICFLOWRATEUNIT.,$,$`);
        const prop = t.add("IFCPROPERTYSINGLEVALUE", `'VolumetricFlowRate',$,IFCVOLUMETRICFLOWRATEMEASURE(${value}),#${unit}`);
        const set = t.add("IFCPROPERTYSET", `${t.guid()},$,'Pset_DistributionPortTypeDuct',$,(#${prop})`);
        t.add("IFCRELDEFINESBYPROPERTIES", `${t.guid()},$,$,$,(#${to}),#${set}`);
      };
      // Cubic millimetres a second: a milli cubic metre is a millimetre cubed, 1e-9 m3. 1e9 mm3/s is 1 m3/s.
      flow(cubic ?? 0, "1.E9", [t.add("IFCDERIVEDUNITELEMENT", `#${t.add("IFCSIUNIT", "*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.")},1`), second()]);
      // Square millimetres times metres a second: a milli square metre is a millimetre squared, 1e-6 m2. 1e6 of them is 1 m3/s.
      flow(square ?? 0, "1.E6", [t.add("IFCDERIVEDUNITELEMENT", `#${t.add("IFCSIUNIT", "*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.")},1`), t.add("IFCDERIVEDUNITELEMENT", `#${t.add("IFCSIUNIT", "*,.LENGTHUNIT.,$,.METRE.")},1`), second()]);
    });
    // 1 m3/s is 2118.88 cubic feet a minute.
    expect(connectors("SD-1")).toMatchObject([
      { id: "supply_air", flow: expect.closeTo(2118.88, 2) },
      { id: "return", flow: expect.closeTo(2118.88, 2) },
    ]);
  });

  it("an older port with no kind of its own keeps the flow its duct property set gives it", () => {
    const { connectors, ports, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      // IFC2X3's port stops at its flow direction: what it connects to is said only by its standard property set and its element's system.
      const id = port(t, host.placement, { name: "Inlet", at: [0, 0, 300], facing: [0, 0, 1], kind: ".SINK." });
      t.add("IFCRELCONNECTSPORTTOELEMENT", `${t.guid()},$,$,$,#${id},#${host.id}`);
      t.assign(t.system("Supply Air 1", "AIRCONDITIONING"), [host.id]);
      const props = [t.add("IFCPROPERTYSINGLEVALUE", `'NominalWidth',$,IFCPOSITIVELENGTHMEASURE(250.),$`), t.add("IFCPROPERTYSINGLEVALUE", `'VolumetricFlowRate',$,IFCVOLUMETRICFLOWRATEMEASURE(0.2),$`)];
      const set = t.add("IFCPROPERTYSET", `${t.guid()},$,'Pset_DistributionPortTypeDuct',$,(${props.map((p) => `#${p}`).join(",")})`);
      t.add("IFCRELDEFINESBYPROPERTIES", `${t.guid()},$,$,$,(#${id}),#${set}`);
    });
    expect(ports("SD-1")).toMatchObject([{ domain: "duct", systemType: null }]);
    // 0.2 m3/s is 423.776 cubic feet a minute.
    expect(connectors("SD-1")).toEqual([{ id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", position: [0, 0, 300], direction: [0, 0, 1], shape: "round", diameter: 250, flow: expect.closeTo(423.776, 2), flowDirection: "in" }]);
    expect(leftOut(plan.report.notes)).toEqual([]);
  });

  it("a cable-carrier port on a part comes in as an electrical connector", () => {
    const { connectors, ports, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      nest(t, host, [{ name: "Raceway", at: [0, 0, 300], facing: [0, 0, 1], kind: ".SINK.,.CABLECARRIER.,.ELECTRICAL." }]);
    });
    expect(ports("SD-1")).toMatchObject([{ domain: "electrical" }]);
    expect(connectors("SD-1")).toEqual([{ id: "raceway", label: "Raceway", domain: "electrical", systemKind: "power", position: [0, 0, 300], direction: [0, 0, 1], shape: "none", flowDirection: "in" }]);
    expect(plan.report.notes).toEqual([]);
  });

  it("a port placed from the storey, not from its host, lands at the same point of the part", () => {
    const { connectors, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t), { x: [0, 1, 0] });
      // The same point and facing as a port at (300, 0, 150) facing the host's own x, written in the storey's frame.
      const id = port(t, t.storeyPlacements.get("Level 1") ?? null, { name: "Supply air", at: [5000, 4300, 2850], facing: [0, 1, 0], kind: DUCT_SUPPLY });
      t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${host.id},(#${id})`);
    });
    expect(connectors("SD-1")).toMatchObject([{ id: "supply_air", position: [300, 0, 150], direction: [1, 0, 0], shape: "none" }]);
    expect(plan.report.notes).toEqual([]);
  });

  it("an older file: a port tied to its element, with no kind of its own, takes it from the element's system", () => {
    const { connectors, plan, ports } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      // IFC2X3's port stops at its flow direction, and is tied to its element by IfcRelConnectsPortToElement.
      const id = port(t, host.placement, { name: "Inlet", at: [0, 0, 300], facing: [0, 0, 1], kind: ".SINK." });
      t.add("IFCRELCONNECTSPORTTOELEMENT", `${t.guid()},$,$,$,#${id},#${host.id}`);
      // A file that says it both ways still has one port.
      t.add("IFCRELNESTS", `${t.guid()},$,$,$,#${host.id},(#${id})`);
      t.assign(t.system("Supply Air 1", "AIRCONDITIONING"), [host.id]);
    });
    expect(ports("SD-1")).toHaveLength(1);
    expect(ports("SD-1")[0]).toMatchObject({ domain: null, systemType: null, flow: "SINK" });
    expect(connectors("SD-1")).toEqual([{ id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", position: [0, 0, 300], direction: [0, 0, 1], shape: "none", flowDirection: "in" }]);
    expect(leftOut(plan.report.notes)).toEqual([]);
  });

  it("a port with no placement isn't brought in, and the report says how many and why", () => {
    const { connectors, plan, ports } = foreign((t) => {
      const one = terminal(t, "SD-1", [1000, 1000, 2700], box(t));
      nest(t, one, [{ name: "Supply air", kind: DUCT_SUPPLY }]);
      const two = terminal(t, "SD-2", [5000, 4000, 2700], box(t));
      nest(t, two, [
        { name: "Supply air", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY },
        { name: "Return air", kind: DUCT_SUPPLY },
        { name: "Sensor", at: [0, 200, 150], facing: [0, 1, 0] },
      ]);
    });
    expect(ports("SD-1")).toMatchObject([{ name: "Supply air", position: null, direction: null }]);
    expect(connectors("SD-1")).toEqual([]);
    expect(connectors("SD-2").map((c) => c.id)).toEqual(["supply_air"]);
    expect(plan.report.notes).toEqual([
      "SD-1: its connection point wasn't brought in (no position in the file); add it to the type by hand",
      "SD-2: 2 of its 3 connection points weren't brought in (1: no position in the file; 1: nothing in the file says what it connects to); add them to the type by hand",
    ]);
    expect(landImport(hostModel(), plan.records).dropped).toEqual([]);
  });

  it("a port the file gives no facing faces out of the side of the box it is on, and the report says so", () => {
    const { connectors, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      // The box is 600 x 400 x 300 about the part's point, its underside at the point's height.
      const duct = ".NOTDEFINED.,.DUCT.,.NOTDEFINED.";
      nest(t, host, [
        { name: "Top", at: [0, 0, 300], kind: duct },
        { name: "Underside", at: [100, 0, 0], kind: duct },
        { name: "East", at: [300, 50, 150], kind: duct },
        { name: "South", at: [0, -190, 150], kind: duct },
      ]);
    });
    expect(connectors("SD-1").map((c) => [c.id, c.direction])).toEqual([
      ["top", [0, 0, 1]],
      ["underside", [0, 0, -1]],
      ["east", [1, 0, 0]],
      ["south", [0, -1, 0]],
    ]);
    expect(plan.report.notes).toEqual(["SD-1: the file doesn't say which way its connection points face, so they were brought in facing out of the nearest side of its box; check them before you route from them"]);
  });

  it("a port whose system type fits several kinds takes the one its name says, or the first with a note", () => {
    const { connectors, plan } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      nest(t, host, [
        { name: "Return", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY },
        { name: "Neck", at: [0, 0, 0], facing: [0, 0, -1], kind: DUCT_SUPPLY },
        { name: "Side", at: [-300, 0, 150], facing: [-1, 0, 0], kind: DUCT_SUPPLY },
        { name: "Spare", at: [300, 0, 150], facing: [1, 0, 0], kind: ".NOTDEFINED.,.DUCT.,.NOTDEFINED." },
      ]);
    });
    expect(connectors("SD-1").map((c) => [c.id, c.systemKind])).toEqual([
      ["return", "return_air"],
      ["neck", "supply_air"],
      ["side", "supply_air"],
      // Nothing says what it carries: the registry's own "other".
      ["spare", "other"],
    ]);
    expect(plan.report.notes).toEqual([`SD-1: the file doesn't say whether "Neck" and "Side" carry supply air or return air, so they were brought in as supply air; change them on the type if that is wrong`]);
  });

  it("a tilted part comes in as the box around it, its connector still where the port is", () => {
    const { part, inModel, ports } = foreign((t) => {
      // Its own z axis points east: it lies on its side, and its port faces east with it.
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t), { z: [1, 0, 0], x: [0, 1, 0] });
      nest(t, host, [{ name: "Supply air", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY }]);
    });
    expect(part("SD-1").rotationDeg).toBe(0);
    const [at] = ports("SD-1");
    expect(at?.position).toEqual(near({ x: 5300, y: 4000, z: 2700 }));
    expect(inModel("SD-1")).toEqual([{ label: "Supply air", at: near(at?.position ?? { x: 0, y: 0, z: 0 }, 1), facing: near({ x: 1, y: 0, z: 0 }) }]);
  });

  it("parts of one file type share a part type while their ports match, at any turn and in any order", () => {
    const turns = [0, 30, 37, 90, 123, 271];
    const specs: readonly PortSpec[] = [
      { name: "Supply air", at: [300.05, 0, 150], facing: [1, 0, 0], kind: DUCT_SUPPLY },
      { name: "Drain", at: [0, -6.35, 0], facing: [0, 0, -1], kind: ".SOURCE.,.PIPE.,.DRAINAGE." },
    ];
    const { plan, part, connectors } = foreign((t) => {
      const ids = turns.map((deg, i) => {
        const a = (deg * Math.PI) / 180;
        const host = terminal(t, `SD-${deg}`, [1000 + i * 2000, 4000, 2700], box(t), { x: [Math.cos(a), Math.sin(a), 0] });
        // Every other one lists its ports the other way round.
        nest(t, host, i % 2 === 0 ? specs : [...specs].reverse());
        return host.id;
      });
      // One whose supply opening is on the other side: the same file type, its own part type.
      const odd = terminal(t, "SD-odd", [20_000, 4000, 2700], box(t));
      nest(t, odd, [{ ...specs[0], name: "Supply air", at: [-300.05, 0, 150], facing: [-1, 0, 0] }, specs[1] ?? { name: "Drain" }]);
      t.type("IFCAIRTERMINALTYPE", "Diffuser", [...ids, odd.id], "DIFFUSER");
    });
    expect(new Set(turns.map((deg) => part(`SD-${deg}`).typeId)).size).toBe(1);
    expect(part("SD-odd").typeId).not.toBe(part("SD-0").typeId);
    expect(ofKind(plan.records, "part_type")).toHaveLength(2);
    expect(connectors("SD-0")).toMatchObject([
      { id: "supply_air", position: [300.1, 0, 150], direction: [1, 0, 0] },
      { id: "drain", position: [0, -6.4, 0], direction: [0, 0, -1] },
    ]);
    expect(connectors("SD-odd")).toMatchObject([{ id: "supply_air", position: [-300.1, 0, 150], direction: [-1, 0, 0] }, { id: "drain" }]);
    expect(plan.report.notes).toEqual([]);
    expect(landImport(hostModel(), plan.records).dropped).toEqual([]);
  });

  it("ports with no name, or sharing one, are numbered in order of place", () => {
    const { connectors } = foreign((t) => {
      const host = terminal(t, "SD-1", [5000, 4000, 2700], box(t));
      nest(t, host, [
        { name: "Outlet", at: [300, 0, 150], facing: [1, 0, 0], kind: DUCT_SUPPLY },
        { name: "", at: [0, 0, 300], facing: [0, 0, 1], kind: DUCT_SUPPLY },
        { name: "Outlet", at: [-300, 0, 150], facing: [-1, 0, 0], kind: DUCT_SUPPLY },
      ]);
    });
    expect(connectors("SD-1").map((c) => [c.id, c.label])).toEqual([
      ["port_3", "Outlet"],
      ["port_2", "Connection 2"],
      ["port_1", "Outlet"],
    ]);
  });
});
