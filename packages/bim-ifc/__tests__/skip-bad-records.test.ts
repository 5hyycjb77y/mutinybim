/**
 * @jest-environment node
 *
 * One stored record that can't be written must not stop exportIfc (#166).
 * A store can hold a record no command would write (an older file, a script,
 * a peer on another release): a ceiling whose holes are null or whose height
 * is not a number, a fitting port with no size. The export used to throw on
 * the first one. Now each record is written all or nothing: one that fails is
 * left out and named in the report, and every other record is in the file.
 */
import { type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { danglingReferences, entityCounts, exportIfc, readStep, type IfcExportResult } from "../src";
import { $, StepGraph, StepValueError, en, int, list, real, serializeStep, str } from "../src/step";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { PROJECT_ID, TIME_STAMP, syntheticModel } from "./c5i-model";

const PROJECT = { id: PROJECT_ID, name: "Synthetic building" };
const square = (x: number, y: number, side: number) => [{ x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }];

/** The synthetic building with two ceilings (one with a hole), a grid and a duct run with an elbow. */
function building(): ModelState {
  const base = { version: 1, authoredRev: {} };
  const grids = [
    { ...base, id: "grid-a", kind: "grid", label: "A", start: { x: 0, y: -1000 }, end: { x: 0, y: 9000 } },
    { ...base, id: "grid-b", kind: "grid", label: "B", start: { x: 6000, y: -1000 }, end: { x: 6000, y: 9000 } },
    { ...base, id: "grid-1", kind: "grid", label: "1", start: { x: -1000, y: 0 }, end: { x: 9000, y: 0 } },
  ] as unknown as BimElement[];
  const m = new Log(syntheticModel(grids));
  m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "clg-holed", levelId: "lvl-1", outline: square(0, 30000, 4000), holes: [square(1000, 31000, 500)], heightMm: 2700 }] });
  m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "clg-plain", levelId: "lvl-1", outline: square(10000, 30000, 4000), heightMm: 2700 }] });
  m.ok({ type: "route_run", idPrefix: "el", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 500, height: 300 }, elevationMm: 3000, system: { id: "sys-sa2", kind: "supply_air", name: "Supply Air 2" }, points: [{ x: 0, y: 40000 }, { x: 4000, y: 40000 }, { x: 4000, y: 44000 }] });
  return m.head;
}

/** The same model with stored fields of some records replaced, as a store would hold them. */
function stored(model: ModelState, changes: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ModelState {
  const elements: Record<string, BimElement> = { ...model.elements };
  for (const [id, change] of Object.entries(changes)) {
    const el = elements[id];
    if (!el) throw new Error(`no element ${id}`);
    elements[id] = { ...el, ...change } as unknown as BimElement;
  }
  return { ...model, elements };
}

const without = (model: ModelState, ids: readonly string[]): ModelState => ({ ...model, elements: Object.fromEntries(Object.entries(model.elements).filter(([id]) => !ids.includes(id))) });
const run = (model: ModelState): IfcExportResult => exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
const leftOut = (out: IfcExportResult, id: string) => out.report.warnings.filter((w) => w.startsWith(`${id}: `) && w.includes("left out of the file"));
/** Every record of the model that is in the file, by its GlobalId. */
const inFile = (out: IfcExportResult, id: string) => {
  const guid = out.report.globalIds[id];
  return guid !== undefined && out.text.includes(`'${guid}'`);
};

describe("exportIfc: a stored record that can't be written", () => {
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  it("writes a ceiling whose holes are null as a ceiling with no holes", () => {
    const out = run(stored(building(), { "clg-holed": { holes: null } }));
    expect(inFile(out, "clg-holed")).toBe(true);
    expect(leftOut(out, "clg-holed")).toEqual([]);
    expect(out.text).not.toContain("IFCARBITRARYPROFILEDEFWITHVOIDS");
    expect(danglingReferences(readStep(out.text))).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([
    ["not a number", Number.NaN],
    ["missing", undefined],
    ["a text", "2700"],
  ])("leaves out a ceiling whose height is %s, names it, and writes everything else", (_label, heightMm) => {
    const model = building();
    const clean = run(model);
    const out = run(stored(model, { "clg-plain": { heightMm } }));

    expect(inFile(out, "clg-plain")).toBe(false);
    expect(leftOut(out, "clg-plain")).toHaveLength(1);
    expect(leftOut(out, "clg-plain")[0]).toMatch(/^clg-plain: this ceiling is left out of the file because a number it needs is missing or is not a number/);
    expect(leftOut(out, "clg-plain")[0]).toMatch(/export again\.$/);
    expect(logged).toHaveBeenCalledTimes(1);
    // Every other record is in the file, under the GlobalId it has in a clean export.
    for (const [id, guid] of Object.entries(clean.report.globalIds)) {
      if (id === "clg-plain") continue;
      expect(out.report.globalIds[id]).toBe(guid);
      expect(inFile(out, id)).toBe(true);
    }
    expect(out.report.counts.elements).toBe(clean.report.counts.elements - 1);
    expect(out.report.byEntity.IfcCovering).toBe((clean.report.byEntity.IfcCovering ?? 0) - 1);
  });

  it("writes a fitting whose ports have no size, without the legs it can't draw, and says so", () => {
    const model = building();
    const fitting = Object.values(model.elements).find((e): e is Extract<BimElement, { kind: "run_fitting" }> => e.kind === "run_fitting");
    if (!fitting) throw new Error("the run has no fitting");
    // No family, so the body is a leg to each port; the ports as a store might hold them, with no size.
    const ports = fitting.ports.map((p) => ({ id: p.id, position: p.position, direction: p.direction }));
    const out = run(stored(model, { [fitting.id]: { family: undefined, params: undefined, ports } }));

    expect(inFile(out, fitting.id)).toBe(true);
    expect(leftOut(out, fitting.id)).toEqual([]);
    expect(out.report.warnings.filter((w) => w.startsWith(`${fitting.id}: `) && w.includes("no size"))).toHaveLength(1);
    expect(out.report.counts.ports).toBe(run(model).report.counts.ports);
    expect(danglingReferences(readStep(out.text))).toEqual([]);
  });

  it("leaves nothing of a left-out record in the file: it is the file of the model without that record", () => {
    const model = building();
    const bad = ["clg-plain", "wall-1", "duct-1", "panel-p1", "sp-201", "zone-fire", "lp-sink", "ckt-1", "sys-gw", "grid-a"];
    const out = run(
      stored(model, {
        "clg-plain": { heightMm: Number.NaN },
        "wall-1": { start: null },
        "duct-1": { size: undefined },
        "panel-p1": { position: { x: Number.POSITIVE_INFINITY, y: 0 } },
        "sp-201": { number: null },
        "zone-fire": { name: 7 },
        "lp-sink": { values: null },
        "ckt-1": { members: null },
        "sys-gw": { name: undefined },
        "grid-a": { end: null },
      }),
    );
    const expected = run(without(model, bad));

    for (const id of bad) {
      expect(leftOut(out, id)).toHaveLength(1);
      expect(out.report.globalIds[id]).toBeUndefined();
    }
    expect(danglingReferences(readStep(out.text))).toEqual([]);
    expect(entityCounts(readStep(out.text))).toEqual(entityCounts(readStep(expected.text)));
    expect(out.report.counts).toEqual(expected.report.counts);
    expect(out.report.byEntity).toEqual(expected.report.byEntity);
    expect(out.report.globalIds).toEqual(expected.report.globalIds);
    // The reason names the stored field to look at, and what the record is called.
    expect(leftOut(out, "wall-1")[0]).toContain('look first at "start"');
    expect(leftOut(out, "panel-p1")[0]).toContain('this part "P1" is left out');
    expect(logged).toHaveBeenCalledTimes(bad.length);
  });

  it("writes what stood on a level that is left out in the building instead", () => {
    const model = building();
    const out = run(stored(model, { "lvl-1": { elevationMm: Number.NaN } }));

    expect(leftOut(out, "lvl-1")).toHaveLength(1);
    expect(out.report.counts.storeys).toBe(1);
    expect(inFile(out, "wall-1")).toBe(true);
    expect(inFile(out, "clg-plain")).toBe(true);
    expect(out.report.counts.elements).toBe(run(model).report.counts.elements);
    expect(danglingReferences(readStep(out.text))).toEqual([]);
  });

  it("keeps the floor elevation for elements on a skipped upper level whose elevationMm is still finite", () => {
    const m = new Log(building());
    m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "clg-l2", levelId: "lvl-2", outline: square(20000, 30000, 4000), heightMm: 2700 }] });
    const out = run(stored(m.head, { "lvl-2": { name: null } }));

    expect(leftOut(out, "lvl-2")).toHaveLength(1);
    expect(out.report.counts.storeys).toBe(1);
    expect(inFile(out, "clg-l2")).toBe(true);
    expect(inFile(out, "sp-201")).toBe(true);
    expect(danglingReferences(readStep(out.text))).toEqual([]);

    const step = readStep(out.text);
    const byId = step.entities;
    const worldZ = (placementRef: number): number => {
      const lp = byId.get(placementRef);
      if (!lp || lp.type !== "IFCLOCALPLACEMENT") return 0;
      const parent = lp.args[0]?.kind === "ref" ? worldZ(lp.args[0].id) : 0;
      const axis = lp.args[1]?.kind === "ref" ? byId.get(lp.args[1].id) : undefined;
      const pt = axis?.args[0]?.kind === "ref" ? byId.get(axis.args[0].id) : undefined;
      const coords = pt?.args[0]?.kind === "list" ? pt.args[0].items : [];
      const z = coords[2]?.kind === "number" ? coords[2].value : 0;
      return parent + z;
    };
    const allEntities = [...byId.values()];
    const ceilingEntity = allEntities.find((e) => e.type === "IFCCOVERING" && e.args[0]?.kind === "string" && e.args[0].value === out.report.globalIds["clg-l2"]);
    const spaceEntity = allEntities.find((e) => e.type === "IFCSPACE" && e.args[0]?.kind === "string" && e.args[0].value === out.report.globalIds["sp-201"]);
    expect(ceilingEntity?.args[5]?.kind).toBe("ref");
    expect(spaceEntity?.args[5]?.kind).toBe("ref");
    if (ceilingEntity?.args[5]?.kind === "ref") expect(worldZ(ceilingEntity.args[5].id)).toBeCloseTo(4000, 3);
    if (spaceEntity?.args[5]?.kind === "ref") expect(worldZ(spaceEntity.args[5].id)).toBeCloseTo(4000, 3);
  });

  it("keeps the surviving one-way grid line as an IfcAnnotation when the only lines the other way can't be written, with no invalid IfcGrid", () => {
    const model = building();
    const out = run(stored(model, { "grid-a": { end: null }, "grid-b": { start: { x: Number.NaN, y: 0 } } }));

    expect(leftOut(out, "grid-a")).toHaveLength(1);
    expect(leftOut(out, "grid-b")).toHaveLength(1);
    expect(out.report.warnings.filter((w) => w.includes("IfcAnnotation"))).toHaveLength(1);
    const counts = entityCounts(readStep(out.text));
    expect(counts.IFCGRID).toBeUndefined();
    expect(counts.IFCGRIDAXIS).toBeUndefined();
    expect(counts.IFCANNOTATION).toBe(1);
    expect(out.report.byEntity.IfcGrid).toBeUndefined();
    expect(out.report.byEntity.IfcAnnotation).toBe(1);
    expect(inFile(out, "wall-1")).toBe(true);
    expect(danglingReferences(readStep(out.text))).toEqual([]);
  });

  it("keeps a part's element and leaves out only its ports when its links can't be read", () => {
    const model = building();
    const out = run(stored(model, { "ahu-1": { links: { supply: null } } }));

    expect(inFile(out, "ahu-1")).toBe(true);
    expect(out.report.warnings.filter((w) => w.startsWith("ahu-1: ") && w.includes("has its ports left out of the file"))).toHaveLength(1);
    expect(out.report.counts.ports).toBe(run(model).report.counts.ports - 1);
    expect(danglingReferences(readStep(out.text))).toEqual([]);
  });

  it("writes a model whose part type has no definition, without that type's parts", () => {
    const model = building();
    const out = run(stored(model, { "pt-ahu": { definition: null } }));

    expect(out.report.warnings.filter((w) => w.startsWith("pt-ahu: ") && w.includes("no definition stored"))).toHaveLength(1);
    expect(leftOut(out, "ahu-1")).toHaveLength(1);
    expect(inFile(out, "panel-p1")).toBe(true);
    expect(inFile(out, "wall-1")).toBe(true);
    expect(danglingReferences(readStep(out.text))).toEqual([]);
  });

  it("writes the same bytes as before for a model with nothing wrong, and warns of nothing left out", () => {
    const model = building();
    const out = run(model);
    expect(out.report.warnings.filter((w) => w.includes("left out of the file"))).toEqual([]);
    expect(run(model).text).toBe(out.text);
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("StepGraph: taking back a record's entities", () => {
  it("refuses a value that can't be written where it is made, not when the file is serialized", () => {
    expect(() => real(Number.NaN)).toThrow(StepValueError);
    expect(() => real(undefined as unknown as number)).toThrow("STEP real must be finite, got undefined");
    expect(() => int(1.5)).toThrow(StepValueError);
    expect(() => en("free text")).toThrow(StepValueError);
    expect(() => str(null as unknown as string)).toThrow(StepValueError);
  });

  it("drops the entities added since a mark and never gives their handles out again", () => {
    const g = new StepGraph();
    const kept = g.add("IFCCARTESIANPOINT", [list([real(0), real(0)])]);
    const mark = g.size;
    const gone = g.add("IFCCARTESIANPOINT", [list([real(1), real(1)])]);
    g.add("IFCPOLYLINE", [list([kept, gone])]);
    g.dropFrom(mark);
    const later = g.add("IFCDIRECTION", [list([real(1), real(0)])]);

    expect(later.ref).toBe(4);
    expect(g.all().map((e) => e.type)).toEqual(["IFCCARTESIANPOINT", "IFCDIRECTION"]);
    expect(g.missingReferences()).toEqual([]);
    const text = serializeStep({ description: [""], implementationLevel: "2;1", fileName: "t.ifc", timeStamp: "2026-11-25T00:00:00", author: [""], organization: [""], preprocessor: "t", originatingSystem: "t", authorization: "", schemas: ["IFC4X3_ADD2"] }, g);
    expect(text).toContain("#1=IFCCARTESIANPOINT((0.,0.));\n#4=IFCDIRECTION((1.,0.));");
  });

  it("reports anything left pointing at a dropped entity", () => {
    const g = new StepGraph();
    const mark = g.size;
    const gone = g.add("IFCCARTESIANPOINT", [list([real(1), real(1)])]);
    g.dropFrom(mark);
    g.add("IFCPOLYLINE", [list([gone]), $]);
    expect(g.missingReferences()).toEqual([1]);
  });
});
