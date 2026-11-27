/**
 * @jest-environment node
 *
 * Ceilings and run fittings leave exportIfc with a placement and a body
 * (#59). A ceiling was written as a bare IfcCovering (no name, placement or
 * body), so a reader skipped it without a word; a fitting had a placement but
 * no body, so a reader called it shapeless. A ceiling is now the board the 3D
 * view draws, in its room; a fitting is the library body the 3D view draws,
 * or one swept leg per port when the library has none for it.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { danglingReferences, exportIfc, importIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import smallOffice from "../../bim-script/examples/small-office";
import { num, ofType, ref, refs, text } from "./a13a-ifc-support";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";

/** Runs a script on an empty model and commits its edits through the kernel. */
async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:ceiling-fitting-bodies" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

const ofKind = <K extends BimElement["kind"]>(model: ModelState, kind: K) => Object.values(model.elements).filter((e): e is Extract<BimElement, { kind: K }> => e.kind === kind);

/** The same model with one element replaced. */
const withElement = (model: ModelState, el: BimElement): ModelState => ({ ...model, elements: { ...model.elements, [el.id]: el } });

/** The export read back as STEP, its warnings, and a lookup from a model id to its IFC entity. */
function exported(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  expect(danglingReferences(file)).toEqual([]);
  const entityOf = (id: string): ReadEntity => {
    const guid = out.report.globalIds[id];
    const e = [...file.entities.values()].find((x) => x.args[0]?.kind === "string" && x.args[0].value === guid);
    if (!e) throw new Error(`no entity for ${id}`);
    return e;
  };
  return { text: out.text, file, entityOf, warnings: out.report.warnings };
}

function get(file: StepFile, id: number): ReadEntity {
  const e = file.entities.get(id);
  if (!e) throw new Error(`no entity #${id}`);
  return e;
}

/** A product's body: its shape representation and that representation's items. */
function bodyOf(file: StepFile, product: ReadEntity) {
  const rep = get(file, refs(get(file, ref(product, 6)), 2)[0] ?? -1);
  return { type: text(rep, 2), items: refs(rep, 3).map((id) => get(file, id)) };
}

/** The x, y of each point of a polyline. */
const polyline = (file: StepFile, curve: ReadEntity) =>
  refs(curve, 0).map((id) => {
    const coords = get(file, id).args[0];
    return coords?.kind === "list" ? coords.items.map((t) => (t.kind === "number" ? t.value : NaN)) : [];
  });

/** What importIfc says of the export, read into an empty model. */
function importReport(ifc: string) {
  const empty: ModelState = { modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return importIfc(ifc, { model: empty, referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture", "mechanical"] }).report;
}

const NO_SHAPE = /no shape of its own/;

describe("exportIfc: a ceiling's placement and body (#59)", () => {
  it("writes small-office's ceiling as a named board at its height, in its room", async () => {
    const model = await build(smallOffice);
    const ceiling = ofKind(model, "ceiling")[0];
    if (!ceiling) throw new Error("small-office has no ceiling");
    expect(ceiling.heightMm).toBeCloseTo(2743.2, 6);
    const { text: ifc, file, entityOf } = exported(model);
    const covering = entityOf(ceiling.id);

    expect(covering.type).toBe("IFCCOVERING");
    expect(text(covering, 2)).toBe("Ceiling");
    expect(text(covering, 8)).toBe("CEILING");
    expect(get(file, ref(covering, 5)).type).toBe("IFCLOCALPLACEMENT");

    // Its outline, pushed up 20 mm from its height above the level.
    const body = bodyOf(file, covering);
    expect(body.type).toBe("SweptSolid");
    expect(body.items).toHaveLength(1);
    const solid = body.items[0];
    if (!solid) throw new Error("no solid");
    expect(solid.type).toBe("IFCEXTRUDEDAREASOLID");
    expect(num(solid, 3)).toBe(20);
    const origin = get(file, ref(get(file, ref(solid, 1)), 0)).args[0];
    expect(origin?.kind === "list" ? origin.items.map((t) => (t.kind === "number" ? t.value : NaN)) : []).toEqual([0, 0, 2743.2]);
    const profile = get(file, ref(solid, 0));
    expect(profile.type).toBe("IFCARBITRARYCLOSEDPROFILEDEF");
    const ring = polyline(file, get(file, ref(profile, 2)));
    expect(ring.slice(0, -1)).toEqual(ceiling.outline.map((p) => [p.x, p.y]));
    expect(ring[ring.length - 1]).toEqual(ring[0]);

    // Contained in the room it is hosted in, not loose on the storey.
    const containers = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").filter((r) => refs(r, 4).includes(covering.id));
    expect(containers).toHaveLength(1);
    const room = containers[0] ? get(file, ref(containers[0], 5)) : undefined;
    expect(room?.type).toBe("IFCSPACE");
    expect(ceiling.spaceId).toBeDefined();
    expect(room?.id).toBe(entityOf(ceiling.spaceId ?? "").id);

    // A reader now sees the ceilings and says so, instead of skipping them without a word.
    const report = importReport(ifc);
    const line = report.classes.find((c) => /ceiling/i.test(c.label));
    expect(line).toBeDefined();
    expect((line?.converted ?? 0) + (line?.linked ?? []).reduce((n, l) => n + l.count, 0)).toBe(ofKind(model, "ceiling").length);
    expect((line?.linked ?? []).some((l) => NO_SHAPE.test(l.reason))).toBe(false);
  });

  it("cuts a ceiling's holes out of its board", async () => {
    const model = await build(smallOffice);
    const ceiling = ofKind(model, "ceiling")[0];
    if (!ceiling) throw new Error("small-office has no ceiling");
    const [a] = ceiling.outline;
    if (!a) throw new Error("no outline");
    const hole = [{ x: a.x + 1000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 1000 }, { x: a.x + 2000, y: a.y + 2000 }, { x: a.x + 1000, y: a.y + 2000 }];
    const { file, entityOf } = exported(withElement(model, { ...ceiling, holes: [hole] }));

    const solid = bodyOf(file, entityOf(ceiling.id)).items[0];
    if (!solid) throw new Error("no solid");
    const profile = get(file, ref(solid, 0));
    expect(profile.type).toBe("IFCARBITRARYPROFILEDEFWITHVOIDS");
    const inner = refs(profile, 3).map((id) => polyline(file, get(file, id)));
    expect(inner).toHaveLength(1);
    expect(inner[0]?.slice(0, -1)).toEqual(hole.map((p) => [p.x, p.y]));
  });

  it("says so when a sloped ceiling is written flat", async () => {
    const model = await build(smallOffice);
    const ceiling = ofKind(model, "ceiling")[0];
    if (!ceiling) throw new Error("small-office has no ceiling");
    expect(exported(model).warnings.filter((w) => w.includes(ceiling.id))).toEqual([]);
    const { file, entityOf, warnings } = exported(withElement(model, { ...ceiling, form: "sloped", slope: { directionDeg: 0, pitch: 0.25 } }));
    expect(bodyOf(file, entityOf(ceiling.id)).items).toHaveLength(1);
    expect(warnings.filter((w) => w.includes(ceiling.id))).toEqual([`${ceiling.id}: a sloped ceiling is written flat at its stated height, so its body is only right where that height is measured`]);
  });
});

describe("exportIfc: a run fitting's body (#59)", () => {
  it("writes rooftop-unit's elbows with the sheet metal the 3D view draws", async () => {
    const model = await build(rooftopUnit);
    const fittings = ofKind(model, "run_fitting");
    expect(fittings.length).toBeGreaterThan(0);
    const { text: ifc, file, entityOf, warnings } = exported(model);

    for (const fitting of fittings) {
      const e = entityOf(fitting.id);
      expect(e.type).toBe("IFCDUCTFITTING");
      expect(text(e, 2)).toBe(fitting.label);
      // Placed at its own point on its level; the body is local to that point.
      const at = get(file, ref(get(file, ref(get(file, ref(e, 5)), 1)), 0)).args[0];
      expect(at?.kind === "list" ? at.items.map((t) => (t.kind === "number" ? t.value : NaN)) : []).toEqual([fitting.position.x, fitting.position.y, fitting.position.z]);
      const body = bodyOf(file, e);
      expect(body.type).toBe("Tessellation");
      expect(body.items.map((i) => i.type)).toEqual(["IFCTRIANGULATEDFACESET"]);
      // The schema's order: Coordinates, Normals, Closed, CoordIndex, PnIndex. No normals; sheet metal is an open shell.
      expect(body.items[0]?.args).toHaveLength(5);
      expect(body.items[0]?.args[1]).toEqual({ kind: "null" });
      expect(body.items[0]?.args[2]).toEqual({ kind: "enum", value: "F" });
      expect(body.items[0]?.args[3]?.kind).toBe("list");
      const coords = get(file, ref(body.items[0] ?? e, 0)).args[0];
      const points = coords?.kind === "list" ? coords.items.map((p) => (p.kind === "list" ? p.items.map((t) => (t.kind === "number" ? t.value : NaN)) : [])) : [];
      expect(points.length).toBeGreaterThan(8);
      // Sheet metal around its own point: no corner further off than the fitting's ports reach, plus its section.
      const reach = Math.max(...fitting.ports.map((p) => Math.hypot(p.position.x - fitting.position.x, p.position.y - fitting.position.y, p.position.z - fitting.position.z)));
      const section = Math.max(...fitting.ports.map((p) => (p.size.shape === "rect" || p.size.shape === "oval" ? Math.hypot(p.size.width, p.size.height) : p.size.shape === "round" ? p.size.diameter : 0)));
      for (const p of points) expect(Math.hypot(p[0] ?? NaN, p[1] ?? NaN, p[2] ?? NaN)).toBeLessThanOrEqual(reach + section + 1);
    }
    expect(warnings.filter((w) => fittings.some((f) => w.includes(f.id)))).toEqual([]);

    // A reader no longer calls them shapeless; they are counted under the class that takes them ("Fittings").
    const line = importReport(ifc).classes.find((c) => c.classId === "mep.run_fitting");
    expect(line).toBeDefined();
    expect((line?.converted ?? 0) + (line?.linked ?? []).reduce((n, l) => n + l.count, 0)).toBe(fittings.length);
    expect((line?.linked ?? []).some((l) => NO_SHAPE.test(l.reason))).toBe(false);
  });

  it("sweeps one leg per port when the library has no body for the fitting", async () => {
    const model = await build(rooftopUnit);
    const fitting = ofKind(model, "run_fitting")[0];
    if (!fitting) throw new Error("rooftop-unit has no fitting");
    // An inline accessory has no library body; give it two 200 mm legs so the fallback has something to sweep.
    const p = fitting.position;
    const ports = fitting.ports.slice(0, 2).map((port, i) => ({ ...port, position: { x: p.x + (i === 0 ? -200 : 200), y: p.y, z: p.z }, direction: { x: i === 0 ? -1 : 1, y: 0, z: 0 } }));
    expect(ports).toHaveLength(2);
    const { file, entityOf } = exported(withElement(model, { ...fitting, fittingType: "accessory", ports }));

    const body = bodyOf(file, entityOf(fitting.id));
    expect(body.type).toBe("SweptSolid");
    expect(body.items.map((i) => i.type)).toEqual(["IFCEXTRUDEDAREASOLID", "IFCEXTRUDEDAREASOLID"]);
    expect(body.items.map((i) => num(i, 3))).toEqual([200, 200]);
  });

  it("says so when a fitting has nothing to draw", async () => {
    const model = await build(rooftopUnit);
    const fitting = ofKind(model, "run_fitting")[0];
    if (!fitting) throw new Error("rooftop-unit has no fitting");
    const { entityOf, warnings } = exported(withElement(model, { ...fitting, fittingType: "accessory", ports: [] }));
    expect(entityOf(fitting.id).args[6]?.kind).toBe("null");
    expect(warnings.filter((w) => w.includes(fitting.id))).toEqual([`${fitting.id}: its fitting has no library body and no ports with length, so it has no body in the file`]);
  });
});
