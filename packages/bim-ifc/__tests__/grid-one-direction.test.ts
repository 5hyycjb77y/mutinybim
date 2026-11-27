/**
 * @jest-environment node
 *
 * Grid lines that don't make a two-way grid (#167).
 *
 * IFC4X3_ADD2 declares IfcGrid.UAxes and VAxes as LIST [1:?]. Grid lines that
 * all ran one way were written as an IfcGrid with an empty VAxes list, which
 * no schema checker accepts. So were the lines of a grid turned 45° to the
 * model's axes, and two skewed directions on the same side of 45°: the
 * lines were sorted by which model axis they lean to, so both directions
 * landed in one list.
 *
 * Now: lines in two directions are always an IfcGrid with both lists filled,
 * sorted by their own direction when the model's axes can't tell them apart.
 * Lines that truly all run one way are kept as named reference lines
 * (IfcAnnotation), with the reason in the report.
 */
import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { danglingReferences, exportIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { PROJECT, ofType, ref, refs, text } from "./a13a-ifc-support";

interface Line {
  readonly label: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

/** A line of `length` mm through `at`, `deg` degrees from the model's x axis. */
function line(label: string, deg: number, at: { x: number; y: number } = { x: 0, y: 0 }, length = 10_000): Line {
  const a = (deg * Math.PI) / 180;
  const half = { x: (Math.cos(a) * length) / 2, y: (Math.sin(a) * length) / 2 };
  return { label, start: { x: Math.round(at.x - half.x), y: Math.round(at.y - half.y) }, end: { x: Math.round(at.x + half.x), y: Math.round(at.y + half.y) } };
}

function model(lines: readonly Line[]): ModelState {
  const m = twoLevels("grid-one-direction");
  for (const [i, l] of lines.entries()) m.ok({ type: "create_element", elementId: `g${i}`, kind: "grid", levelId: "L1", label: l.label, placement: { kind: "line", start: l.start, end: l.end } });
  return m.head;
}

function exported(m: ModelState) {
  const out = exportIfc({ model: m, project: PROJECT, timeStamp: "2026-11-25T00:00:00" });
  const file = readStep(out.text);
  expect(danglingReferences(file)).toEqual([]);
  return { file, report: out.report };
}

const tags = (file: StepFile, grid: ReadEntity, i: number): (string | null)[] => refs(grid, i).map((id) => text(file.entities.get(id), 0));
const U = 7;
const V = 8;
const PREDEFINED = 10;
const gridWarnings = (warnings: readonly string[]): string[] => warnings.filter((w) => /grid/i.test(w));

/** The one IfcGrid in the file. */
function gridOf(file: StepFile): ReadEntity {
  const grids = ofType(file, "IFCGRID");
  expect(grids).toHaveLength(1);
  const grid = grids[0];
  if (!grid) throw new Error("no IfcGrid");
  return grid;
}

describe("grid lines that all run one way", () => {
  const oneWay = [0, 6000, 12_000].map((x, i) => ({ label: String(i + 1), start: { x, y: -1000 }, end: { x, y: 9000 } }));

  it("are not written as an IfcGrid with an empty axis list", () => {
    const { file } = exported(model(oneWay));
    expect(ofType(file, "IFCGRID")).toHaveLength(0);
    expect(ofType(file, "IFCGRIDAXIS")).toHaveLength(0);
  });

  it("are kept as named reference lines with their labels and geometry, on the lowest storey", () => {
    const { file, report } = exported(model(oneWay));
    const lines = ofType(file, "IFCANNOTATION");
    expect(lines.map((l) => text(l, 2))).toEqual(["Grid 1", "Grid 2", "Grid 3"]);
    for (const l of lines) {
      // GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, PredefinedType
      expect(l.args).toHaveLength(8);
      expect(text(l, 4)).toBe("Grid line");
      expect(text(l, 7)).toBe("USERDEFINED");
      expect(file.entities.get(ref(l, 5))?.type).toBe("IFCLOCALPLACEMENT");
      const shape = file.entities.get(ref(l, 6));
      expect(shape?.type).toBe("IFCPRODUCTDEFINITIONSHAPE");
      const representation = shape ? file.entities.get(refs(shape, 2)[0] ?? -1) : undefined;
      const curve = representation ? file.entities.get(refs(representation, 3)[0] ?? -1) : undefined;
      expect(curve?.type).toBe("IFCPOLYLINE");
      expect(curve ? refs(curve, 0) : []).toHaveLength(2);
    }
    const storey = ofType(file, "IFCBUILDINGSTOREY").find((s) => text(s, 2) === "Level 1");
    const contained = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").filter((r) => ref(r, 5) === storey?.id).flatMap((r) => refs(r, 4));
    expect(lines.every((l) => contained.includes(l.id))).toBe(true);
    expect(report.byEntity.IfcAnnotation).toBe(3);
    expect(report.byEntity.IfcGrid).toBeUndefined();
    expect(Object.keys(report.globalIds)).toEqual(expect.arrayContaining(["g0", "g1", "g2"]));
  });

  it("say so in the report, in plain words, with what to do", () => {
    const { report } = exported(model(oneWay));
    expect(gridWarnings(report.warnings)).toEqual(["The 3 grid lines all run the same way, and an IFC grid needs lines in two directions, so they are written as named reference lines (IfcAnnotation) with their labels. Add a grid line across them to export a grid"]);
  });

  it("a single grid line is one reference line, with its own message", () => {
    const { file, report } = exported(model([oneWay[0] as Line]));
    expect(ofType(file, "IFCGRID")).toHaveLength(0);
    expect(ofType(file, "IFCANNOTATION").map((l) => text(l, 2))).toEqual(["Grid 1"]);
    expect(gridWarnings(report.warnings)).toEqual(["g0: it is the only grid line, and an IFC grid needs lines in two directions, so it is written as a named reference line (IfcAnnotation). Add a grid line across it to export a grid"]);
  });

  it("lines a hair off parallel (under one degree) still count as one way", () => {
    const { file } = exported(model([line("1", 90, { x: 0, y: 0 }), line("2", 90.4, { x: 6000, y: 0 })]));
    expect(ofType(file, "IFCGRID")).toHaveLength(0);
    expect(ofType(file, "IFCANNOTATION")).toHaveLength(2);
  });
});

describe("grid lines in two directions are always an IfcGrid with both lists filled", () => {
  it("a square grid: U up the plan, V across, RECTANGULAR, and nothing in the report", () => {
    const { file, report } = exported(model([line("1", 90, { x: 0, y: 0 }), line("2", 90, { x: 6000, y: 0 }), line("A", 0, { x: 0, y: 0 }), line("B", 0, { x: 0, y: 8000 })]));
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1", "2"]);
    expect(tags(file, grid, V)).toEqual(["A", "B"]);
    expect(text(grid, PREDEFINED)).toBe("RECTANGULAR");
    expect(ofType(file, "IFCANNOTATION")).toHaveLength(0);
    expect(gridWarnings(report.warnings)).toEqual([]);
  });

  it("a square grid turned 45°: one direction in each list, RECTANGULAR", () => {
    const { file, report } = exported(model([line("1", 45, { x: 0, y: 0 }), line("2", 45, { x: 6000, y: 0 }), line("A", 135, { x: 0, y: 0 }), line("B", 135, { x: 0, y: 8000 })]));
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1", "2"]);
    expect(tags(file, grid, V)).toEqual(["A", "B"]);
    expect(text(grid, PREDEFINED)).toBe("RECTANGULAR");
    expect(gridWarnings(report.warnings)).toEqual([]);
  });

  it("two skewed directions that both lean to the y axis: one in each list, IRREGULAR", () => {
    const { file } = exported(model([line("1", 80, { x: 0, y: 0 }), line("2", 80, { x: 6000, y: 0 }), line("A", 60, { x: 0, y: 0 }), line("B", 60, { x: 0, y: 8000 })]));
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1", "2"]);
    expect(tags(file, grid, V)).toEqual(["A", "B"]);
    expect(text(grid, PREDEFINED)).toBe("IRREGULAR");
  });

  it("two skewed directions that both lean to the x axis: one in each list, IRREGULAR", () => {
    const { file } = exported(model([line("1", 30, { x: 0, y: 0 }), line("2", 30, { x: 0, y: 6000 }), line("A", 10, { x: 0, y: 0 }), line("B", 10, { x: 0, y: 8000 })]));
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1", "2"]);
    expect(tags(file, grid, V)).toEqual(["A", "B"]);
    expect(text(grid, PREDEFINED)).toBe("IRREGULAR");
  });

  it("a square grid with a diagonal line is not called RECTANGULAR", () => {
    const { file } = exported(model([line("1", 90, { x: 0, y: 0 }), line("2", 90, { x: 6000, y: 0 }), line("A", 0, { x: 0, y: 0 }), line("X", 60, { x: 3000, y: 3000 })]));
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1", "2", "X"]);
    expect(tags(file, grid, V)).toEqual(["A"]);
    expect(text(grid, PREDEFINED)).toBe("IRREGULAR");
  });
});

describe("grid edge cases", () => {
  it("no grid lines: no IfcGrid, no reference lines, nothing in the report", () => {
    const { file, report } = exported(model([]));
    expect(ofType(file, "IFCGRID")).toHaveLength(0);
    expect(ofType(file, "IFCANNOTATION")).toHaveLength(0);
    expect(gridWarnings(report.warnings)).toEqual([]);
  });

  it("a stored grid line with no length is left out, with the reason, and the rest are still a grid", () => {
    const m = model([line("1", 90, { x: 0, y: 0 }), line("A", 0, { x: 0, y: 0 }), line("Z", 90, { x: 9000, y: 0 })]);
    const z = m.elements.g2;
    if (z?.kind !== "grid") throw new Error("no grid line g2");
    const broken = { ...m, elements: { ...m.elements, g2: { ...z, end: z.start } as BimElement } };
    const { file, report } = exported(broken);
    const grid = gridOf(file);
    expect(tags(file, grid, U)).toEqual(["1"]);
    expect(tags(file, grid, V)).toEqual(["A"]);
    expect(report.warnings).toContain("g2: this grid line starts and ends at the same point, so it is left out of the file");
  });
});
