/**
 * @jest-environment node
 */
import { MeshCache } from "@permitzip/bim-geometry";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import {
  PartGeometryUnavailableError,
  asElementId,
  connectorPlacementWarnings,
  definitionTypes,
  evaluateFormula,
  executeCommand,
  exampleFloorDrain,
  exampleRooftopUnit,
  isPartModel2,
  localBounds,
  paramValue,
  parseFormula,
  parseTypesCsv,
  partFootprint,
  partConnectorWarnings,
  partMesh,
  partTypeIssues,
  resolveConnectors,
  resolveGeometry,
  resolvePartModel,
  resolveDim,
  setPartMeshProvider,
  solveSketch,
  typesCsv,
  withPartGroupName,
  type AnyPartModel,
  type Command,
  type ModelState,
  type PartTypeDefinition,
  type Sketch,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const IN = 25.4;

function run(model: ModelState, command: Command): ModelState {
  const result = executeCommand(model, command);
  if (!result.ok) throw new Error(`${command.type}: ${result.error.message}`);
  return result.model;
}

function refused(model: ModelState, command: Command): string {
  const result = executeCommand(model, command);
  if (result.ok) throw new Error(`${command.type} should have been refused`);
  return result.error.message;
}

describe("formulas", () => {
  const ev = (src: string, vars: Record<string, number> = {}) =>
    evaluateFormula(parseFormula(src), (n) => {
      const v = vars[n];
      if (v === undefined) throw new Error(`unknown ${n}`);
      return v;
    });

  it("does arithmetic with precedence, units and functions", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("2in")).toBeCloseTo(50.8);
    expect(ev("1 ft + 6 in")).toBeCloseTo(457.2);
    expect(ev("width / 2 + 2in", { width: 1000 })).toBeCloseTo(550.8);
    expect(ev("max(1, 7, 3) + min(4, 2)")).toBe(9);
    expect(ev("if(height > 36in, 4in, 2in)", { height: 1000 })).toBeCloseTo(101.6);
    expect(ev("cos(60)")).toBeCloseTo(0.5);
    expect(ev("not (1 > 2) and 3 >= 3")).toBe(1);
  });

  it("explains bad formulas in plain words", () => {
    expect(() => parseFormula("width /")).toThrow(/ends too soon/);
    expect(() => parseFormula("foo(2)")).toThrow(/not a formula function/);
    expect(() => parseFormula("width $ 2")).toThrow(/can't be used/);
    expect(() => ev("1 / 0")).toThrow(/Division by zero/);
  });
});

describe("sketch solver", () => {
  const planes = (w: number, d: number) =>
    new Map([
      ["front", { coordinate: "u" as const, value: w / 2 }],
      ["back", { coordinate: "u" as const, value: -w / 2 }],
      ["left", { coordinate: "v" as const, value: d / 2 }],
      ["right", { coordinate: "v" as const, value: -d / 2 }],
    ]);
  const rect: Sketch = {
    id: "s",
    name: "Footprint",
    plane: "base",
    points: [
      { id: "a", u: -90, v: -40 },
      { id: "b", u: 110, v: -60 },
      { id: "c", u: 95, v: 55 },
      { id: "d", u: -80, v: 45 },
    ],
    entities: [{ kind: "rectangle", id: "r", corners: ["a", "b", "c", "d"] }],
    constraints: [
      { kind: "on_plane", point: "a", plane: "back" },
      { kind: "on_plane", point: "a", plane: "right" },
      { kind: "on_plane", point: "c", plane: "front" },
      { kind: "on_plane", point: "c", plane: "left" },
    ],
  };

  it("snaps a roughly drawn rectangle onto its reference planes and flexes with them", () => {
    for (const [w, d] of [[200, 100], [2000, 1500], [50, 900]] as const) {
      const s = solveSketch(rect, { dims: new Map(), planes: planes(w, d), radii: new Map() });
      expect(s.status).toBe("solved");
      expect(s.freeDirections).toBe(0);
      expect(s.points.get("b")?.u).toBeCloseTo(w / 2, 6);
      expect(s.points.get("b")?.v).toBeCloseTo(-d / 2, 6);
      expect(s.points.get("d")?.u).toBeCloseTo(-w / 2, 6);
      expect(s.points.get("d")?.v).toBeCloseTo(d / 2, 6);
    }
  });

  it("solves lines, arcs and dimensions together", () => {
    const sketch: Sketch = {
      id: "s",
      name: "Slot",
      plane: "base",
      points: [
        { id: "p1", u: 0, v: 0 },
        { id: "p2", u: 90, v: 5 },
        { id: "c", u: 95, v: 25 },
        { id: "p3", u: 92, v: 48 },
        { id: "p4", u: 2, v: 52 },
      ],
      entities: [
        { kind: "line", id: "bottom", a: "p1", b: "p2" },
        { kind: "arc", id: "end", center: "c", start: "p2", end: "p3" },
        { kind: "line", id: "top", a: "p3", b: "p4" },
        { kind: "line", id: "back", a: "p4", b: "p1" },
      ],
      constraints: [
        { kind: "fix", point: "p1", u: 0, v: 0 },
        { kind: "horizontal", line: "bottom" },
        { kind: "horizontal", line: "top" },
        { kind: "vertical", line: "back" },
        { kind: "length", line: "bottom", value: 100 },
        { kind: "radius", arc: "end", value: 25 },
        { kind: "distance", a: "p2", b: "c", value: 25, direction: "vertical" },
        { kind: "distance", a: "p2", b: "c", value: 0, direction: "horizontal" },
        { kind: "distance", a: "c", b: "p3", value: 0, direction: "horizontal" },
      ],
    };
    const s = solveSketch(sketch, { dims: new Map([[0, { u: 0, v: 0 }], [4, { value: 100 }], [5, { value: 25 }], [6, { value: 25 }], [7, { value: 0 }], [8, { value: 0 }]]), planes: new Map(), radii: new Map() });
    expect(s.status).toBe("solved");
    expect(s.points.get("p2")?.u).toBeCloseTo(100, 5);
    expect(s.points.get("p3")?.v).toBeCloseTo(50, 5);
    expect(s.points.get("p4")?.u).toBeCloseTo(0, 5);
  });

  it("names constraints that disagree", () => {
    const sketch: Sketch = {
      id: "s",
      name: "Bad",
      plane: "base",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 100, v: 0 },
      ],
      entities: [{ kind: "line", id: "l", a: "a", b: "b" }],
      constraints: [
        { kind: "fix", point: "a", u: 0, v: 0 },
        { kind: "length", line: "l", value: 100 },
        { kind: "fix", point: "b", u: 300, v: 0 },
      ],
    };
    const s = solveSketch(sketch, { dims: new Map([[0, { u: 0, v: 0 }], [1, { value: 100 }], [2, { u: 300, v: 0 }]]), planes: new Map(), radii: new Map() });
    expect(s.status).toBe("failed");
    expect(s.problems[0]).toMatch(/can't satisfy all its constraints/);
  });

  it("reports free directions without failing", () => {
    const loose: Sketch = { ...rect, constraints: [{ kind: "on_plane", point: "a", plane: "back" }] };
    const s = solveSketch(loose, { dims: new Map(), planes: planes(200, 100), radii: new Map() });
    expect(s.status).toBe("underdefined");
    expect(s.freeDirections).toBeGreaterThan(0);
  });

  it("solves angles, parallels, equal lengths and aligned distances together", () => {
    const sketch: Sketch = {
      id: "p",
      name: "Parallelogram",
      plane: "base",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 95, v: 3 },
        { id: "c", u: 140, v: 70 },
        { id: "d", u: 40, v: 65 },
      ],
      entities: [
        { kind: "line", id: "ab", a: "a", b: "b" },
        { kind: "line", id: "bc", a: "b", b: "c" },
        { kind: "line", id: "cd", a: "c", b: "d" },
        { kind: "line", id: "da", a: "d", b: "a" },
      ],
      constraints: [
        { kind: "fix", point: "a", u: 0, v: 0 },
        { kind: "horizontal", line: "ab" },
        { kind: "length", line: "ab", value: 100 },
        { kind: "angle", line1: "ab", line2: "bc", value: 60 },
        { kind: "equal_length", line1: "bc", line2: "da" },
        { kind: "parallel", line1: "ab", line2: "cd" },
        { kind: "parallel", line1: "bc", line2: "da" },
        { kind: "distance", a: "a", b: "d", value: 80 },
      ],
    };
    const s = solveSketch(sketch, { dims: new Map([[0, { u: 0, v: 0 }], [2, { value: 100 }], [3, { value: 60 }], [7, { value: 80 }]]), planes: new Map(), radii: new Map() });
    expect(s.status).toBe("solved");
    expect(s.freeDirections).toBe(0);
    expect(s.points.get("b")?.u).toBeCloseTo(100, 6);
    expect(s.points.get("c")?.u).toBeCloseTo(140, 6);
    expect(s.points.get("c")?.v).toBeCloseTo(40 * Math.sqrt(3), 6);
    expect(s.points.get("d")?.u).toBeCloseTo(40, 6);
  });

  it("solves perpendiculars, equal radii and coincident points", () => {
    const sketch: Sketch = {
      id: "q",
      name: "Arcs",
      plane: "base",
      points: [
        { id: "c1", u: 0, v: 0 },
        { id: "s1", u: 20, v: 1 },
        { id: "e1", u: 1, v: 21 },
        { id: "c2", u: 100, v: 0 },
        { id: "s2", u: 130, v: 1 },
        { id: "e2", u: 99, v: 28 },
        { id: "q", u: 118, v: 3 },
      ],
      entities: [
        { kind: "arc", id: "k1", center: "c1", start: "s1", end: "e1" },
        { kind: "arc", id: "k2", center: "c2", start: "s2", end: "e2" },
        { kind: "line", id: "r1", a: "c1", b: "s1", construction: true },
        { kind: "line", id: "t1", a: "c1", b: "e1", construction: true },
        { kind: "line", id: "r2", a: "c2", b: "s2", construction: true },
        { kind: "line", id: "t2", a: "c2", b: "e2", construction: true },
      ],
      constraints: [
        { kind: "fix", point: "c1", u: 0, v: 0 },
        { kind: "fix", point: "c2", u: 100, v: 0 },
        { kind: "radius", arc: "k1", value: 20 },
        { kind: "equal_radius", arc1: "k1", arc2: "k2" },
        { kind: "horizontal", line: "r1" },
        { kind: "perpendicular", line1: "r1", line2: "t1" },
        { kind: "horizontal", line: "r2" },
        { kind: "perpendicular", line1: "r2", line2: "t2" },
        { kind: "coincident", a: "q", b: "s2" },
      ],
    };
    const s = solveSketch(sketch, { dims: new Map([[0, { u: 0, v: 0 }], [1, { u: 100, v: 0 }], [2, { value: 20 }]]), planes: new Map(), radii: new Map() });
    expect(s.status).toBe("solved");
    expect(s.freeDirections).toBe(0);
    expect(s.points.get("e1")?.v).toBeCloseTo(20, 6);
    expect(s.points.get("s2")?.u).toBeCloseTo(120, 6);
    expect(s.points.get("e2")?.u).toBeCloseTo(100, 6);
    expect(s.points.get("e2")?.v).toBeCloseTo(20, 6);
    expect(s.points.get("q")?.u).toBeCloseTo(s.points.get("s2")?.u ?? NaN, 6);
    expect(s.points.get("q")?.v).toBeCloseTo(s.points.get("s2")?.v ?? NaN, 6);
  });

  // Timing lives in the BIM perf gate (part.sketch.solve.40x60, scripts/perf/mutinybim/parts.ts).
  describe("40 points and 60 constraints", () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, u: i * 10 + (i % 3), v: (i % 2) * 20 + (i % 5) }));
    const entities = Array.from({ length: 39 }, (_, i) => ({ kind: "line" as const, id: `l${i}`, a: `p${i}`, b: `p${i + 1}` }));
    const constraints: Sketch["constraints"] = [{ kind: "fix", point: "p0", u: 0, v: 0 }];
    const dims = new Map<number, { value?: number; u?: number; v?: number }>([[0, { u: 0, v: 0 }]]);
    for (let i = 0; i < 39 && constraints.length < 60; i++) {
      constraints.push({ kind: i % 2 ? "vertical" : "horizontal", line: `l${i}` });
      if (constraints.length < 60) {
        dims.set(constraints.length, { value: 10 + (i % 4) });
        constraints.push({ kind: "length", line: `l${i}`, value: 10 + (i % 4) });
      }
    }
    const sketch: Sketch = { id: "big", name: "Big", plane: "base", points, entities, constraints };
    const inputs = () => ({ dims: new Map(dims), planes: new Map(), radii: new Map() });

    it("meets every constraint and counts the directions left free", () => {
      const s = solveSketch(sketch, inputs());
      expect(constraints).toHaveLength(60);
      expect(s.status).toBe("underdefined");
      // 80 coordinates; the fix pins 2, 30 horizontal/vertical and 29 lengths pin one each.
      expect(s.freeDirections).toBe(80 - 2 - 30 - 29);
      const at = (id: string) => s.points.get(id) ?? { u: NaN, v: NaN };
      expect(at("p0").u).toBeCloseTo(0, 6);
      expect(at("p0").v).toBeCloseTo(0, 6);
      for (let i = 0; i < 39; i++) {
        const a = at(`p${i}`);
        const b = at(`p${i + 1}`);
        if (i < 30) expect(i % 2 ? b.u - a.u : b.v - a.v).toBeCloseTo(0, 6);
        if (i < 29) expect(Math.hypot(b.u - a.u, b.v - a.v)).toBeCloseTo(10 + (i % 4), 6);
      }
      // Lines no constraint touches stay where they were drawn.
      expect(at("p39")).toEqual({ u: points[39]?.u, v: points[39]?.v });
    });

    it("is deterministic: the same sketch, rebuilt from scratch, solves to bit-identical points", () => {
      const key = (s: ReturnType<typeof solveSketch>) => [s.status, s.freeDirections, s.iterations, [...s.points.entries()]];
      const first = key(solveSketch(sketch, inputs()));
      const clone: Sketch = JSON.parse(JSON.stringify(sketch)) as Sketch;
      for (let k = 0; k < 5; k++) expect(key(solveSketch(k % 2 ? clone : sketch, inputs()))).toStrictEqual(first);
    });
  });
});

describe("modeled part definitions", () => {
  it("validates the worked examples for every size", () => {
    expect(partTypeIssues(exampleRooftopUnit())).toEqual([]);
    expect(partTypeIssues(exampleFloorDrain())).toEqual([]);
  });

  it("computes formula parameters and formula dimensions", () => {
    const rtu = exampleRooftopUnit();
    expect(paramValue(rtu, {}, "duct_offset")).toBeCloseTo((90 * IN) / 4);
    const supply = resolveConnectors(rtu).find((c) => c.id === "supply");
    expect(supply?.position[0]).toBeCloseTo((90 * IN) / 4);
    expect(supply?.position[2]).toBeCloseTo(14 * IN);
    const power = resolveConnectors(rtu).find((c) => c.id === "power");
    expect(power?.position[2]).toBeCloseTo(14 * IN + 20 * IN);
    expect(resolveDim(rtu, {}, { formula: "curb_height + height" })).toBeCloseTo(54 * IN);
  });

  it("refuses formula cycles, unknown names and setting a formula parameter", () => {
    const rtu = exampleRooftopUnit();
    const cyclic: PartTypeDefinition = { ...rtu, typeParams: [...rtu.typeParams, { name: "a", label: "A", kind: "length", formula: "b + 1" }, { name: "b", label: "B", kind: "length", formula: "a + 1" }] };
    expect(partTypeIssues(cyclic).map((i) => i.message).join("\n")).toMatch(/depends on itself/);
    const unknown: PartTypeDefinition = { ...rtu, connectors: [{ ...(rtu.connectors[0] ?? rtu.connectors[1]!), position: [{ formula: "lenght / 4" }, 0, 0] }] };
    expect(partTypeIssues(unknown).map((i) => i.message).join("\n")).toMatch(/lenght, which is not a parameter/);
    const set: PartTypeDefinition = { ...rtu, typeValues: { ...rtu.typeValues, duct_offset: 3 } };
    expect(partTypeIssues(set).map((i) => i.message).join("\n")).toMatch(/comes from its formula/);
  });

  it("refuses a size whose sketch can't be built, naming the size", () => {
    const rtu = exampleRooftopUnit();
    const model = rtu.model;
    if (!model) throw new Error("example has a model");
    const bad: PartTypeDefinition = { ...rtu, model: { ...model, types: [...model.types, { name: "Tiny", values: { height: 100 } }] } };
    const issues = partTypeIssues(bad).map((i) => i.message);
    expect(issues).toContain("Type Tiny: Height must be at least 200");
  });

  it("estimates bounds without the geometry engine (footprints, snapping, picking)", () => {
    const rtu = exampleRooftopUnit();
    const b = localBounds(resolveGeometry(rtu));
    expect(b.min[0]).toBeCloseTo(-45 * IN);
    expect(b.max[0]).toBeCloseTo(45 * IN);
    expect(b.max[1]).toBeCloseTo(25 * IN);
    expect(b.min[2]).toBeCloseTo(0);
    expect(b.max[2]).toBeCloseTo(54 * IN);
    const drain = localBounds(resolveGeometry(exampleFloorDrain()));
    expect(drain.max[0]).toBeCloseTo(3.5 * IN, 0);
    expect(drain.min[2]).toBeCloseTo(-7 * IN, 0);
  });

  it("expands the types table into one library type per size", () => {
    const types = definitionTypes(exampleRooftopUnit());
    expect(types.map((t) => t.typeId)).toEqual(["rtu.rtu-5", "rtu.rtu-10", "rtu.rtu-15"]);
    expect(types[2]?.definition.typeValues.length).toBeCloseTo(110 * IN);
    expect(types[2]?.definition.typeName).toBe("RTU-15");
  });

  it("round-trips the types table through CSV in inches", () => {
    const rtu = exampleRooftopUnit();
    const csv = typesCsv(rtu, "in");
    expect(csv.split("\n")[0]).toMatch(/^name,length,width,height/);
    const lengths = new Set(rtu.typeParams.filter((p) => p.kind === "length").map((p) => p.name));
    const rows = parseTypesCsv(csv, lengths, "in");
    expect(rows.map((r) => r.name)).toEqual(["RTU-5", "RTU-10", "RTU-15"]);
    expect(rows[0]?.values.length).toBeCloseTo(74 * IN, 6);
    expect(rows[0]?.values.model).toBe("RTU-5");
  });
});

describe("project library and placement", () => {
  const level = (m: ModelState) => run(m, { type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 6000 });
  const save = (m: ModelState, def: PartTypeDefinition = exampleRooftopUnit()) => run(m, { type: "save_part_types", label: "Rooftop unit", types: definitionTypes(def) });

  it("saves every size, places them, and updates placed parts when the definition changes", () => {
    let m = save(level(createDemoModel()));
    expect(m.elements["rtu.rtu-10"]?.kind).toBe("part_type");
    m = run(m, { type: "place_part", partId: "rtu-1", typeId: "rtu.rtu-5", levelId: "lvl-roof", position: { x: 0, y: 0 } });
    m = run(m, { type: "place_part", partId: "rtu-2", typeId: "rtu.rtu-10", levelId: "lvl-roof", position: { x: 5000, y: 0 } });
    m = run(m, { type: "place_part", partId: "rtu-3", typeId: "rtu.rtu-15", levelId: "lvl-roof", position: { x: 10000, y: 0 }, rotationDeg: 90 });
    const part = m.elements["rtu-3"];
    const type = m.elements["rtu.rtu-15"];
    if (part?.kind !== "part" || type?.kind !== "part_type") throw new Error("placed");
    const fp = partFootprint(type, part);
    expect(Math.max(...fp.map((p) => p.y)) - Math.min(...fp.map((p) => p.y))).toBeCloseTo(110 * IN, 3);

    const taller = exampleRooftopUnit();
    const model = taller.model;
    if (!model) throw new Error("model");
    const changed: PartTypeDefinition = { ...taller, model: { ...model, types: model.types.map((t) => ({ ...t, values: { ...t.values, height: (t.values.height as number) + 100 } })) } };
    const result = executeCommand(m, { type: "save_part_types", types: definitionTypes(changed) });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.summary?.join(" ")).toMatch(/Updated 3 types; 3 placed parts redraw/);
  });

  it("is idempotent: saving the same definition again changes nothing and says so", () => {
    const m = save(level(createDemoModel()));
    expect(refused(m, { type: "save_part_types", types: definitionTypes(exampleRooftopUnit()) })).toMatch(/Nothing to change/);
  });

  it("refuses a definition that doesn't validate, naming the size", () => {
    const rtu = exampleRooftopUnit();
    const model = rtu.model;
    if (!model) throw new Error("model");
    const cutFirst = (m: AnyPartModel): AnyPartModel => {
      if (isPartModel2(m)) {
        const third = m.features[2];
        if (!third || !("operation" in third)) throw new Error("the example's third feature must be a body");
        return { ...m, features: [{ ...third, operation: "cut" }, ...m.features.slice(0, 2)] };
      }
      const third = m.features[2];
      if (!third) throw new Error("the example needs three features");
      return { ...m, features: [{ ...third, operation: "cut" }, ...m.features.slice(0, 2)] };
    };
    const broken: PartTypeDefinition = { ...rtu, model: cutFirst(model) };
    expect(refused(createDemoModel(), { type: "save_part_types", types: definitionTypes(broken) })).toMatch(/first solid feature must add material/);
  });

  it("refuses to remove a connector a run is connected to", () => {
    let m = save(level(createDemoModel()));
    m = run(m, { type: "place_part", partId: "rtu-1", typeId: "rtu.rtu-10", levelId: "lvl-roof", position: { x: 0, y: 0 } });
    const part = m.elements["rtu-1"];
    if (part?.kind !== "part") throw new Error("placed");
    const linked: ModelState = { ...m, elements: { ...m.elements, "rtu-1": { ...part, links: { supply: { elementId: asElementId("seg-x"), port: "start" } } } } };
    const rtu = exampleRooftopUnit();
    const noSupply: PartTypeDefinition = withPartGroupName({ ...rtu, connectors: rtu.connectors.filter((c) => c.id !== "supply") }, "Rooftop unit on curb");
    expect(refused(linked, { type: "save_part_types", types: definitionTypes(noSupply) })).toMatch(/has a run connected to Supply air, which the new definition removes/);
  });
});

describe("meshes through the geometry engine", () => {
  afterEach(() => setPartMeshProvider(null));

  it("throws plainly when the engine isn't loaded", () => {
    setPartMeshProvider(null);
    expect(() => partMesh(exampleRooftopUnit())).toThrow(PartGeometryUnavailableError);
  });

  it("builds the rooftop unit: body on a hollow curb with a recessed panel", async () => {
    const cache = new MeshCache(await nodeManifoldEngine());
    setPartMeshProvider(cache);
    const rtu = exampleRooftopUnit();
    const mesh = partMesh(rtu);
    expect(mesh.bounds.min[0]).toBeCloseTo(-45 * IN, 1);
    expect(mesh.bounds.max[2]).toBeCloseTo(54 * IN, 1);
    // The recess and the hollow curb add faces a plain box doesn't have.
    expect(mesh.triangleCount).toBeGreaterThan(24);
    // Coarse leaves the recess out (visibility medium, fine).
    expect(partMesh(rtu, {}, "coarse").triangleCount).toBeLessThan(mesh.triangleCount);
  });

  it("builds the floor drain from a revolve and an extrude", async () => {
    setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
    const mesh = partMesh(exampleFloorDrain());
    expect(mesh.bounds.max[2]).toBeCloseTo(0, 3);
    expect(mesh.bounds.min[2]).toBeCloseTo(-7 * IN, 0);
    expect(mesh.bounds.max[0]).toBeCloseTo(3.5 * IN, 0);
  });

  it("1,000 placed parts of one size evaluate one mesh; a different size is a second mesh", async () => {
    const cache = new MeshCache(await nodeManifoldEngine());
    setPartMeshProvider(cache);
    const [small, mid] = definitionTypes(exampleRooftopUnit());
    if (!small || !mid) throw new Error("sizes");
    const first = partMesh(small.definition, { room: "Roof A" });
    for (let i = 0; i < 999; i++) expect(partMesh(small.definition, { room: `Roof ${i}` })).toBe(first);
    expect(cache.evaluations).toBe(1);
    expect(partMesh(mid.definition)).not.toBe(first);
    expect(cache.evaluations).toBe(2);
  });

  it("resolves the same model to the same program every time (determinism)", () => {
    const rtu = exampleRooftopUnit();
    const model = rtu.model;
    if (!model) throw new Error("model");
    const a = resolvePartModel(model, (d) => resolveDim(rtu, {}, d));
    const b = resolvePartModel(model, (d) => resolveDim(rtu, {}, d));
    expect(JSON.stringify(a.program)).toBe(JSON.stringify(b.program));
  });
});

describe("connectors that can't take a run (bug log #23)", () => {
  // A downflow rooftop unit: a hollow curb ring 0–355.6 mm (14"), the cabinet from the curb's top to 1371.6 mm (54").
  const curb = { min: [-1000, -600, 0], max: [1000, 600, 355.6] };
  const cabinet = { min: [-1000, -600, 355.6], max: [1000, 600, 1371.6] };
  const box = { min: curb.min, max: cabinet.max };

  it("does not flag supply and return at the bottom of a hollow curb facing down, or the example rooftop unit", () => {
    const downflow = [
      { label: "Supply", position: [400, 0, 0], direction: [0, 0, -1] },
      { label: "Return", position: [-400, 0, 0], direction: [0, 0, -1] },
    ];
    expect(connectorPlacementWarnings("5 ton", box, downflow, [curb, cabinet])).toEqual([]);
    // The example's openings sit at the curb's top (the cabinet's bottom face), facing down into the open curb.
    expect(partConnectorWarnings(exampleRooftopUnit())).toEqual([]);
  });

  it("flags a connector inside the cabinet, facing out or in, with how deep it is", () => {
    const warnings = connectorPlacementWarnings(
      "5 ton",
      box,
      [
        // 150 mm (5.91") in from the cabinet's front face (x = 1000), pointing out through it: the overall-box reach check alone misses this.
        { label: "Supply", position: [850, 0, 800], direction: [1, 0, 0] },
        { label: "Return", position: [850, 0, 800], direction: [-1, 0, 0] },
      ],
      [curb, cabinet],
    );
    expect(warnings).toEqual([
      expect.stringMatching(/^5 ton: Supply is inside the part's body \(5\.91 in from the nearest face\)/),
      expect.stringMatching(/^5 ton: Return is inside the part's body \(5\.91 in from the nearest face\)/),
    ]);
  });

  it("flags a connector below the base facing up into the part", () => {
    const warnings = connectorPlacementWarnings("5 ton", box, [{ label: "Drain", position: [0, 0, -50], direction: [0, 0, 1] }], [curb, cabinet]);
    expect(warnings).toEqual([expect.stringMatching(/^5 ton: Drain is 1\.97 in below the part's base/)]);
  });
});
