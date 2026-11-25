/**
 * @jest-environment node
 *
 * A part read back by importIfc sits at the point the file places it, turned
 * the way the file turns it (#65). It used to sit at the middle of its box,
 * never turned: electrical-room's panel moved 50.8 mm off its wall and 300 mm
 * up, and every receptacle on a side wall lost its turn. The reader now
 * hands the importer the product's own placement and its shape's box along
 * its own axes, and the part rule builds the part from those. A product
 * whose placement can't be a part's (tilted, or away from its shape) still
 * comes in as the box it was, and the report says so.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, landImport, type BimElement, type ModelState, type PartInstance } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc, readIfcSource } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";
import plumbingRiser from "../../bim-script/examples/plumbing-riser";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import { IfcText, hostModel } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";
const SOURCE = { referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture", "mechanical", "electrical", "plumbing"] };

/** Runs a script on an empty model and commits its edits through the kernel. */
async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-part-placement" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

const ofKind = <K extends BimElement["kind"]>(els: readonly BimElement[], kind: K) => els.filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);

interface Box {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/** The world box of an imported part: its type's one box, turned and moved the way the part is. */
function worldBox(records: readonly BimElement[], part: PartInstance): Box {
  const type = records.find((r) => r.id === part.typeId);
  const level = records.find((r) => r.id === part.levelId);
  const box = type?.kind === "part_type" ? type.definition.geometry[0] : undefined;
  if (box?.kind !== "box" || level?.kind !== "level") throw new Error(`${part.id} has no box or no level`);
  const n = (v: unknown): number => {
    if (typeof v !== "number") throw new Error(`${part.id}: an imported box is plain numbers`);
    return v;
  };
  const [cx, cy, cz] = box.center.map(n) as [number, number, number];
  const [sx, sy, sz] = box.size.map(n) as [number, number, number];
  const a = (part.rotationDeg * Math.PI) / 180;
  const corners = [-1, 1].flatMap((i) => [-1, 1].map((j) => {
    const x = cx + (i * sx) / 2;
    const y = cy + (j * sy) / 2;
    return { x: part.position.x + x * Math.cos(a) - y * Math.sin(a), y: part.position.y + x * Math.sin(a) + y * Math.cos(a) };
  }));
  const z = level.elevationMm + part.offsetMm + cz;
  return {
    min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)), z: z - sz / 2 },
    max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)), z: z + sz / 2 },
  };
}

/** Every coordinate of two boxes within `mm` of each other. */
function expectSameBox(got: Box, want: Box, mm = 0.25): void {
  for (const end of ["min", "max"] as const) for (const axis of ["x", "y", "z"] as const) expect(Math.abs(got[end][axis] - want[end][axis])).toBeLessThanOrEqual(mm);
}

/** A model's export read back into an empty model, each placed part paired with what it became. */
function roundTrip(model: ModelState) {
  const { text, report } = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const empty: ModelState = { modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const plan = importIfc(text, { model: empty, ...SOURCE });
  const source = readIfcSource(text, SOURCE);
  const imported = new Map(ofKind(plan.records, "part").map((p) => [p.provenance?.ifcGlobalId, p]));
  const pairs = ofKind(Object.values(model.elements), "part").map((stored) => {
    const guid = report.globalIds[stored.id];
    const got = imported.get(guid);
    const product = source.products.find((p) => p.sourceId === guid);
    if (!got || !product?.geometry.bounds) throw new Error(`${stored.id} didn't come back as a part`);
    return { stored, got, bounds: product.geometry.bounds };
  });
  return { plan, pairs };
}

describe("importIfc keeps a part at its placement (#65)", () => {
  it.each([
    ["electrical-room", electricalRoom, 12],
    ["rooftop-unit", rooftopUnit, 1],
    ["plumbing-riser", plumbingRiser, 8],
  ] as const)("%s: every part comes back at its insertion point, height and turn, its box where the file has it", async (_name, script, count) => {
    const { plan, pairs } = roundTrip(await build(script));
    expect(pairs).toHaveLength(count);
    for (const { stored, got, bounds } of pairs) {
      expect(got).toMatchObject({ position: stored.position, offsetMm: stored.offsetMm, rotationDeg: stored.rotationDeg });
      expectSameBox(worldBox(plan.records, got), bounds);
    }
  });

  it("electrical-room: the panel stays on its wall, its box in front of and above its insertion point", async () => {
    const model = await build(electricalRoom);
    const { plan, pairs } = roundTrip(model);
    const panel = pairs.find((p) => p.stored.mark === "LP-1");
    expect(panel?.got).toMatchObject({ position: { x: 304.8, y: 3962.4 }, offsetMm: 0, rotationDeg: 0 });
    const type = plan.records.find((r) => r.id === panel?.got.typeId);
    const box = type?.kind === "part_type" ? type.definition.geometry[0] : undefined;
    // 361.95 wide, 101.6 deep, 762 tall; the back on the wall and the bottom 300 mm up, as the type draws it.
    const width = expect.closeTo(361.95, 0);
    expect(box).toEqual({ kind: "box", center: [0, 50.8, 681], size: [width, 101.6, 762] });
    expect(type?.kind === "part_type" ? type.definition.symbol : null).toEqual([{ kind: "rect", center: [0, 50.8], size: [width, 101.6] }]);
  });

  it("electrical-room: receptacles turned onto all four walls share one type and keep their turns", async () => {
    const { plan, pairs } = roundTrip(await build(electricalRoom));
    const receptacles = pairs.filter((p) => p.stored.mark !== "LP-1");
    expect(new Set(receptacles.map((p) => p.stored.rotationDeg))).toEqual(new Set([0, 90, 180, 270]));
    expect(receptacles.map((p) => p.got.rotationDeg).sort((a, b) => a - b)).toEqual(receptacles.map((p) => p.stored.rotationDeg).sort((a, b) => a - b));
    expect(new Set(receptacles.map((p) => p.got.typeId)).size).toBe(1);
    expect(ofKind(plan.records, "part_type")).toHaveLength(2);
    // Nothing about placement is left to say; notes about what wasn't brought in (connection points, groups) are other changes'.
    expect(plan.report.notes.filter((n) => !n.includes("brought in"))).toEqual([]);
  });
});

/** A product at a placement the test spells out (`z` and `x` are its own axes in the storey's frame). */
function placed(t: IfcText, name: string, at: readonly [number, number, number], shape: number, axes: { readonly z?: readonly [number, number, number]; readonly x?: readonly [number, number, number] } = {}): number {
  const storey = t.storeys.get("Level 1") ?? 0;
  const placement = t.place(t.storeyPlacements.get("Level 1") ?? null, t.axis3(at, axes.z ?? [0, 0, 1], axes.x ?? [1, 0, 0]));
  const id = t.add("IFCAIRTERMINAL", `${t.guid()},$,'${name}',$,$,#${placement},#${shape},'${name}',.DIFFUSER.`);
  t.contained.set(storey, [...(t.contained.get(storey) ?? []), id]);
  return id;
}

function foreign(make: (t: IfcText) => void) {
  const t = IfcText.start("mm");
  t.storey("Level 1", 0);
  make(t);
  const text = t.text();
  const source = readIfcSource(text, { sourceId: "ver-1", label: "Acme MEP", disciplines: ["mechanical"] });
  const plan = importIfc(text, { model: hostModel(), referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label: "Acme MEP", disciplines: ["mechanical"] });
  const part = (name: string): PartInstance => {
    const p = ofKind(plan.records, "part").find((r) => r.mark === name);
    if (!p) throw new Error(`${name} didn't come in as a part`);
    return p;
  };
  const bounds = (name: string): Box => {
    const b = source.products.find((p) => p.name === name)?.geometry.bounds;
    if (!b) throw new Error(`${name} has no bounds`);
    return b;
  };
  return { source, plan, part, bounds, records: [...plan.records, ...Object.values(hostModel().elements)] };
}

const COS30 = Math.cos(Math.PI / 6);

describe("importIfc reads a part's placement from any file (#65)", () => {
  it("the reader gives a product's own origin, axes and its box along them", () => {
    const { source } = foreign((t) => {
      placed(t, "SD-1", [5000, 4000, 2700], t.body([t.extrude(t.rect(600, 400, [300, 200]), 300)]), { x: [COS30, 0.5, 0] });
    });
    const p = source.products.find((x) => x.name === "SD-1")?.placement;
    expect(p?.origin).toEqual({ x: 5000, y: 4000, z: 2700 });
    expect(p?.xAxis).toEqual({ x: expect.closeTo(COS30, 9), y: expect.closeTo(0.5, 9), z: 0 });
    expect(p?.zAxis).toEqual({ x: 0, y: 0, z: 1 });
    expect(p?.bounds).toEqual({ min: { x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(0, 6) }, max: { x: expect.closeTo(600, 6), y: expect.closeTo(400, 6), z: expect.closeTo(300, 6) } });
  });

  it("a part turned 30° about a corner keeps the corner, the turn and its true size", () => {
    const { plan, part, bounds, records } = foreign((t) => {
      placed(t, "SD-1", [5000, 4000, 2700], t.body([t.extrude(t.rect(600, 400, [300, 200]), 300)]), { x: [COS30, 0.5, 0] });
    });
    const got = part("SD-1");
    expect(got).toMatchObject({ position: { x: 5000, y: 4000 }, offsetMm: 2700, rotationDeg: 30 });
    const [type] = ofKind(plan.records, "part_type");
    expect(type?.definition.geometry).toEqual([{ kind: "box", center: [300, 200, 150], size: [600, 400, 300] }]);
    expectSameBox(worldBox(records, got), bounds("SD-1"));
    expect(plan.report.notes).toEqual([]);
  });

  it("a tilted part comes in upright as the box around it, and the report says so", () => {
    const { plan, part, bounds, records } = foreign((t) => {
      // Its own z axis points east: it lies on its side.
      placed(t, "SD-1", [5000, 4000, 2700], t.body([t.extrude(t.rect(600, 400), 300)]), { z: [1, 0, 0], x: [0, 1, 0] });
    });
    const got = part("SD-1");
    expect(got).toMatchObject({ position: { x: 5150, y: 4000 }, offsetMm: 2500, rotationDeg: 0 });
    expectSameBox(worldBox(records, got), bounds("SD-1"));
    expect(plan.report.notes).toEqual(["SD-1: it is tilted in the file, so it came in upright, as the box around it"]);
  });

  it("a part whose insertion point is away from its shape sits at the middle of its box, and the report says so", () => {
    const { plan, part, bounds, records } = foreign((t) => {
      // Placed at the storey's origin, its shape 8 m east and 6 m north of that.
      placed(t, "SD-1", [0, 0, 0], t.body([t.extrude(t.rect(600, 400, [8000, 6000]), 300)]), { x: [0, 1, 0] });
    });
    const got = part("SD-1");
    expect(got).toMatchObject({ position: { x: -6000, y: 8000 }, offsetMm: 0, rotationDeg: 0 });
    expectSameBox(worldBox(records, got), bounds("SD-1"));
    expect(plan.report.notes).toEqual(["SD-1: its insertion point is away from its shape in the file, so it sits at the middle of its box, not turned"]);
  });

  it.each([
    ["a metric box that hangs off its point by an odd tenth", 600.1, 400, 300.05, 200],
    ["a half-inch-thick plate with its point on one face", 609.6, 12.7, 304.8, 6.35],
  ])("one file type keeps one part type at every turn: %s", (_name, width, depth, cx, cy) => {
    // The box's centre is at a rounding half (300.05, 6.35), where float noise from each turned frame could tip it either way.
    const turns = [0, 30, 37, 53, 90, 123, 180, 271];
    const { plan, part, bounds, records } = foreign((t) => {
      const ids = turns.map((deg, i) => {
        const a = (deg * Math.PI) / 180;
        return placed(t, `SD-${deg}`, [1000 + i * 2000, 4000, 2700], t.body([t.extrude(t.rect(width, depth, [cx, cy]), 300)]), { x: [Math.cos(a), Math.sin(a), 0] });
      });
      t.type("IFCAIRTERMINALTYPE", "Diffuser", ids, "DIFFUSER");
    });
    expect(ofKind(plan.records, "part_type")).toHaveLength(1);
    expect(new Set(turns.map((deg) => part(`SD-${deg}`).typeId)).size).toBe(1);
    expect(turns.map((deg) => part(`SD-${deg}`).rotationDeg)).toEqual(turns);
    for (const deg of turns) expectSameBox(worldBox(records, part(`SD-${deg}`)), bounds(`SD-${deg}`));
    expect(plan.report.notes).toEqual([]);
  });

  it("two upright parts of one file type whose boxes sit differently each keep their own box", () => {
    const { plan, part, bounds, records } = foreign((t) => {
      // The same 600 x 400 x 300 box: centred on SD-1's insertion point, and off SD-2's by (300, 200).
      const centred = placed(t, "SD-1", [1000, 1000, 2700], t.body([t.extrude(t.rect(600, 400), 300)]));
      const corner = placed(t, "SD-2", [5000, 4000, 2700], t.body([t.extrude(t.rect(600, 400, [300, 200]), 300)]));
      const again = placed(t, "SD-3", [8000, 4000, 2700], t.body([t.extrude(t.rect(600, 400, [300, 200]), 300)]));
      t.type("IFCAIRTERMINALTYPE", "Diffuser 600x400", [centred, corner, again], "DIFFUSER");
    });
    for (const name of ["SD-1", "SD-2", "SD-3"]) expectSameBox(worldBox(records, part(name)), bounds(name));
    // The first box met keeps the file type's plain id; the other box is a variant, shared by the parts that sit that way.
    expect(part("SD-1").typeId).not.toBe(part("SD-2").typeId);
    expect(part("SD-3").typeId).toBe(part("SD-2").typeId);
    const types = ofKind(plan.records, "part_type");
    expect(types).toHaveLength(2);
    expect(new Set(types.map((t) => t.id)).size).toBe(2);
    expect(types.map((t) => t.definition.geometry)).toEqual([[{ kind: "box", center: [0, 0, 150], size: [600, 400, 300] }], [{ kind: "box", center: [300, 200, 150], size: [600, 400, 300] }]]);
    expect(plan.report.notes).toEqual([]);
    expect(landImport(hostModel(), plan.records).dropped).toEqual([]);
  });

  it("an upright and a tilted part of one type in the file each land on their own shape", () => {
    const { plan, part, bounds, records } = foreign((t) => {
      const shape = () => t.body([t.extrude(t.rect(600, 400, [300, 200]), 300)]);
      const upright = placed(t, "SD-1", [1000, 1000, 2700], shape());
      const tilted = placed(t, "SD-2", [5000, 4000, 2700], shape(), { z: [1, 0, 0], x: [0, 1, 0] });
      t.type("IFCAIRTERMINALTYPE", "Diffuser 600x400", [upright, tilted], "DIFFUSER");
    });
    expect(part("SD-1")).toMatchObject({ position: { x: 1000, y: 1000 }, offsetMm: 2700, rotationDeg: 0 });
    expectSameBox(worldBox(records, part("SD-1")), bounds("SD-1"));
    expectSameBox(worldBox(records, part("SD-2")), bounds("SD-2"));
    expect(part("SD-1").typeId).not.toBe(part("SD-2").typeId);
    expect(ofKind(plan.records, "part_type").map((t) => t.definition.typeName)).toEqual(["Diffuser 600x400", "Diffuser 600x400"]);
  });
});

describe("a part a hair off the origin", () => {
  it("sits at 0, 0, not -0, -0", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    t.product("Level 1", "IFCAIRTERMINAL", "SD-1", [-0.04, -0.04, 0], t.body([t.extrude(t.rect(600, 400), 300)]), ".DIFFUSER.", { tag: "SD-1" });
    const { records } = importIfc(t.text(), { model: hostModel(), ...SOURCE });
    const [part] = ofKind(records, "part");
    expect(Object.is(part?.position.x, 0) && Object.is(part?.position.y, 0)).toBe(true);
  });
});
