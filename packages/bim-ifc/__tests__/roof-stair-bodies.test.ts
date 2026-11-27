/**
 * @jest-environment node
 *
 * Roofs and stairs leave exportIfc with a placement and a body (#167). An
 * `IfcRoof`, its `ROOF` slab part, an `IfcStair` and its flight were written
 * with no placement and no body, so a viewer showed nothing and the report
 * said nothing. A roof and a stair are now placed in their storey with the
 * blocks the 3D view and sections draw (the kind row's `solid`), each block
 * an extrusion: a level one pushed up, a pitched one its sloped face pushed
 * straight up. Their parts are placed with them and carry no second copy of
 * the body. A roof or stair the model has no shape for is written without a
 * body, and the report names it.
 */
import { kindRowOf, tiltedZ, type ModelState } from "@permitzip/bim-kernel";
import { asRoof, asStair } from "@permitzip/bim-pack-architecture";
import { danglingReferences, exportIfc, importIfc, readIfcSource, readStep, type ReadEntity, type StepFile } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { ofType, ref, refs, text } from "./a13a-ifc-support";
import { hostModel } from "./i9-fixtures";

const PROJECT = { id: "5d0c1a7e-93b4-4c68-8f21-6e4b7a9d2c35", name: "Synthetic roof and stair" };
const RECT = [{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 10_000, y: 8000 }, { x: 0, y: 8000 }];
const LEVELS = [
  { id: "L1", name: "Level 1", elevationMm: 0 },
  { id: "L2", name: "Level 2", elevationMm: 4000 },
];

type Corner = readonly [number, number, number];
const tidy = (corners: readonly Corner[]): string[] => [...new Set(corners.map((c) => c.map((n) => (Math.round(n * 100) / 100 || 0).toFixed(2)).join(" ")))].sort();

/** Level 1 at 0 and Level 2 at 4 m, with a roof on Level 2 (of `values`) and a stair from Level 1. */
function building(values?: Readonly<Record<string, string | number>>): ModelState {
  const m = twoLevels("roof-stair-bodies");
  m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: RECT }, ...(values ? { values } : {}) });
  m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", placement: { kind: "line", start: { x: 1000, y: 2000 }, end: { x: 7160, y: 2000 } } });
  return m.head;
}

function exported(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: "2026-11-25T00:00:00" });
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

/** Every corner of the body the 3D view and sections draw for `id`, in world millimetres. */
function drawnCorners(model: ModelState, id: string): { readonly corners: string[]; readonly blocks: number } {
  const el = model.elements[id];
  const shape = el ? kindRowOf(el.kind)?.solid?.(el, { elements: model.elements, floorMm: 0 }) : null;
  if (shape?.form !== "prisms") throw new Error(`${id} has no blocks`);
  const corners = shape.blocks.flatMap((b) => b.outline.flatMap((q): Corner[] => [[q.x, q.y, tiltedZ(b.z0, b.tilt0, q)], [q.x, q.y, tiltedZ(b.z1, b.tilt1, q)]]));
  return { corners: tidy(corners), blocks: shape.blocks.length };
}

/** Every corner of the body the file gives `entity`, in world millimetres, as the package's own reader reads it. */
function writtenCorners(ifc: string, entity: string): { readonly corners: string[]; readonly blocks: number } {
  const product = readIfcSource(ifc, { sourceId: "v", label: "Read back", disciplines: ["architecture"] }).products.find((p) => p.entity === entity);
  if (!product) throw new Error(`no ${entity} with a shape in the file`);
  expect(product.geometry.unread).toBeNull();
  const corners = product.geometry.extrusions.flatMap((x) => x.base.flatMap((q): Corner[] => [[q.x, q.y, q.z], [q.x + x.along.x, q.y + x.along.y, q.z + x.along.z]]));
  return { corners: tidy(corners), blocks: product.geometry.extrusions.length };
}

describe("roofs and stairs in the exported file", () => {
  it("a flat roof and a straight stair are placed in their storeys with the body the 3D view draws", () => {
    const model = building();
    const { text: ifc, file, entityOf, warnings } = exported(model);
    expect(warnings).toEqual([]);
    for (const [id, storeyName] of [["r", "Level 2"], ["s", "Level 1"]] as const) {
      const product = entityOf(id);
      const storey = ofType(file, "IFCBUILDINGSTOREY").find((x) => text(x, 2) === storeyName);
      if (!storey) throw new Error(`no storey ${storeyName}`);
      const placement = get(file, ref(product, 5));
      expect(placement.type).toBe("IFCLOCALPLACEMENT");
      expect(ref(placement, 0)).toBe(ref(storey, 5));
      const rep = get(file, refs(get(file, ref(product, 6)), 2)[0] ?? -1);
      expect([text(rep, 1), text(rep, 2)]).toEqual(["Body", "SweptSolid"]);
      expect(refs(rep, 3).map((item) => get(file, item).type).every((t) => t === "IFCEXTRUDEDAREASOLID")).toBe(true);
    }
    expect(writtenCorners(ifc, "IfcRoof")).toEqual(drawnCorners(model, "r"));
    expect(writtenCorners(ifc, "IfcStair")).toEqual(drawnCorners(model, "s"));
    // One slab 250 thick on Level 2; 22 steps from Level 1 to one riser short of Level 2.
    expect(writtenCorners(ifc, "IfcRoof")).toMatchObject({ blocks: 1 });
    expect(writtenCorners(ifc, "IfcStair")).toMatchObject({ blocks: 22 });
    expect(writtenCorners(ifc, "IfcRoof").corners).toContain("10000.00 8000.00 4250.00");
  });

  it.each([
    ["shed", { "architecture.slope_rise": 0.25 }],
    ["gable", { "architecture.roof_form": "gable" }],
    ["hip", { "architecture.roof_form": "hip" }],
  ] as const)("a %s roof keeps its slope: each piece is its sloped face pushed straight up", (_form, values) => {
    const model = building(values);
    const { text: ifc, warnings } = exported(model);
    expect(warnings).toEqual([]);
    const written = writtenCorners(ifc, "IfcRoof");
    expect(written).toEqual(drawnCorners(model, "r"));
    // It is pitched: its corners are at more than the two heights a flat roof has.
    expect(new Set(written.corners.map((c) => c.split(" ")[2])).size).toBeGreaterThan(2);
  });

  it("a roof's slab part and a stair's flight are placed with them, still aggregated, and the roof and stair stay in their storeys", () => {
    const { file, entityOf } = exported(building());
    const roof = entityOf("r");
    const stair = entityOf("s");
    const slab = ofType(file, "IFCSLAB").find((x) => text(x, 8) === "ROOF");
    const flight = ofType(file, "IFCSTAIRFLIGHT")[0];
    if (!slab || !flight) throw new Error("no parts");
    for (const [part, owner] of [[slab, roof], [flight, stair]] as const) {
      const placement = get(file, ref(part, 5));
      expect(placement.type).toBe("IFCLOCALPLACEMENT");
      expect(ref(placement, 0)).toBe(ref(owner, 5));
      // The body is written once, on the roof or stair: a second copy on its part would draw twice and read back as a second record.
      expect(part.args[6]?.kind).toBe("null");
      expect(ofType(file, "IFCRELAGGREGATES").filter((a) => ref(a, 4) === owner.id && refs(a, 5).includes(part.id))).toHaveLength(1);
    }
    const containerOf = (e: ReadEntity) => ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").filter((c) => refs(c, 4).includes(e.id)).map((c) => text(get(file, ref(c, 5)), 2));
    expect(containerOf(roof)).toEqual(["Level 2"]);
    expect(containerOf(stair)).toEqual(["Level 1"]);
    // A part is in the building through what it is part of, never also contained.
    expect([...containerOf(slab), ...containerOf(flight)]).toEqual([]);
  });

  it("an exported roof and stair come back as the same roof and stair", () => {
    const { text: ifc } = exported(building());
    const plan = importIfc(ifc, { model: hostModel(LEVELS), referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label: "Round trip", disciplines: ["architecture"] });
    expect(plan.records.map((r) => r.kind).sort()).toEqual(["architecture.roof", "architecture.stair"]);
    const roof = plan.records.flatMap((r) => asRoof(r) ?? [])[0];
    const stair = plan.records.flatMap((r) => asStair(r) ?? [])[0];
    expect(roof).toMatchObject({ levelId: "L2", thicknessMm: 250, baseOffsetMm: 0 });
    expect([Math.min(...(roof?.outline ?? []).map((p) => p.x)), Math.max(...(roof?.outline ?? []).map((p) => p.x)), Math.min(...(roof?.outline ?? []).map((p) => p.y)), Math.max(...(roof?.outline ?? []).map((p) => p.y))]).toEqual([0, 10_000, 0, 8000]);
    expect(stair).toMatchObject({ levelId: "L1", start: { x: 1000, y: 2000 }, end: { x: 7160, y: 2000 }, widthMm: 1100, risers: 23 });
  });

  it("a stair with no level above to rise to is written without a body, and the report names it", () => {
    const m = twoLevels("roof-stair-no-shape");
    m.ok({ type: "create_element", elementId: "top-stair", kind: "architecture.stair", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6160, y: 0 } } });
    // The level it rose to is gone (an older or hand-edited model): the stair has no height, so no steps.
    const { L2: _gone, ...elements } = m.head.elements;
    const { file, entityOf, warnings } = exported({ ...m.head, elements });
    const stair = entityOf("top-stair");
    expect(stair.type).toBe("IFCSTAIR");
    expect(get(file, ref(stair, 5)).type).toBe("IFCLOCALPLACEMENT");
    expect(stair.args[6]?.kind).toBe("null");
    expect(warnings).toEqual(["top-stair: the model has no shape for this stair, so it has no body in the file. Open it in a 3D view: if it is missing there too, fix it in the model and export again"]);
  });
});
