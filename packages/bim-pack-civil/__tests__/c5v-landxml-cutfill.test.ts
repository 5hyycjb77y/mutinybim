/**
 * @jest-environment node
 *
 * LandXML 1.2 TIN import and prismoidal cut/fill on the composite TIN.
 *
 * Hand check, international feet. Existing and proposed are the same 60 ft by
 * 40 ft rectangle. Proposed sits 2.00 ft above existing.
 *
 *   area = 60 × 40 = 2,400 ft²
 *   fill = 2,400 × 2 = 4,800 ft³ = 4,800/27 yd³
 *   cut  = 0
 *   net  = fill − cut = 4,800 ft³
 *
 * A sloping proposed plane, z = (easting / 30) × 3 ft over a 30 ft by 10 ft
 * rectangle, has a mean height of 1.5 ft:
 *
 *   fill = 300 × 1.5 = 450 ft³
 *
 * One triangle with corner differences −3, +3, +3 ft (plan (0,0), (6,0), (0,6)):
 *
 *   whole-triangle net = 18 × (−3+3+3)/3 = 18 ft³
 *   zero contour splits off the cut: area 4.5 ft² × 3/3 = 4.5 ft³ cut
 *   the rest is 22.5 ft³ fill
 *   22.5 − 4.5 = 18, the same net
 *
 * Partial overlap of two flat squares (existing x 0–10, proposed x 5–15,
 * both y 0–10, proposed 1 ft higher) is the 5 ft by 10 ft overlap only:
 *
 *   fill = 50 ft³, not the 100 ft³ of either square.
 *
 * demo-site (the fixture) is 80 ft by 50 ft, existing 100.00 ft, proposed
 * 101.25 ft: fill = 80 × 50 × 1.25 = 5,000 ft³.
 */
import { readFileSync } from "node:fs";
import { qty, to, type UnitFor } from "@permitzip/bim-units";
import { commandSchema, DEFAULT_SETTINGS, planCommit, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, PackSet, runPackCalc, withPackSet } from "@permitzip/bim-pack";
import { IMPORT_LANDXML_SURFACES } from "../src/grading-command";
import { importLandXml, MAX_TIN_POINTS, MAX_XML_DEPTH } from "../src/landxml";
import { CIVIL_PACK } from "../src/pack";
import { readGradingSurfaces, type GradingSurface, type SurfaceRole, type TinFace, type TinVertex } from "../src/surfaces";
import { cutFillBetween } from "../src/tin-volume";

const DEMO_SITE = readFileSync(new URL("./fixtures/demo-site.landxml", import.meta.url), "utf8");
const SET = PackSet.create([CIVIL_PACK]);

function length(unit: UnitFor<"length">, value: number) {
  return qty("length", value, unit);
}

function tin(name: string, role: SurfaceRole, unit: UnitFor<"length">, raw: readonly (readonly [string, number, number, number])[], faces: readonly TinFace[]): GradingSurface {
  const points: TinVertex[] = raw.map(([id, easting, northing, elevation]) => ({
    id,
    easting: length(unit, easting),
    northing: length(unit, northing),
    elevation: length(unit, elevation),
  }));
  return { id: `gs-${name.toLowerCase()}`, name, role, linearUnit: unit, sourceLinearUnit: unit, points, faces };
}

/** Rectangle x0..x1 east, y0..y1 north. `diagonal` chooses which way the two triangles split. */
function rect(name: string, role: SurfaceRole, unit: UnitFor<"length">, x0: number, y0: number, x1: number, y1: number, z: number | ((x: number, y: number) => number), diagonal: "main" | "anti" = "main"): GradingSurface {
  const zz = (x: number, y: number): number => (typeof z === "number" ? z : z(x, y));
  const corners: (readonly [string, number, number, number])[] = [
    ["1", x0, y0, zz(x0, y0)],
    ["2", x1, y0, zz(x1, y0)],
    ["3", x1, y1, zz(x1, y1)],
    ["4", x0, y1, zz(x0, y1)],
  ];
  const faces: readonly TinFace[] = diagonal === "main" ? [{ a: 0, b: 1, c: 2 }, { a: 0, b: 2, c: 3 }] : [{ a: 0, b: 1, c: 3 }, { a: 1, b: 2, c: 3 }];
  return tin(name, role, unit, corners, faces);
}

function yd3(surface: GradingSurface, other: GradingSurface, part: "cut" | "fill" | "net"): number {
  return to(cutFillBetween(surface, other)[part], "yd3");
}

describe("prismoidal cut and fill", () => {
  it("matches the hand check for a flat pad 2 ft above a 60 by 40 ft rectangle", () => {
    const existing = rect("Existing", "existing", "ft", 0, 0, 60, 40, 100);
    const proposed = rect("Proposed", "proposed", "ft", 0, 0, 60, 40, 102);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.overlapArea, "ft2")).toBeCloseTo(2400, 6);
    expect(to(result.fill, "ft3")).toBeCloseTo(4800, 4);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 6);
    expect(to(result.net, "ft3")).toBeCloseTo(4800, 4);
    expect(to(result.fill, "yd3")).toBeCloseTo(4800 / 27, 6);
    expect(to(result.fill, "m3")).toBeCloseTo(to(qty("volume", 4800, "ft3"), "m3"), 6);
    expect(result.issues).toEqual([]);
  });

  it("is the same volume when the two surfaces split the rectangle on opposite diagonals", () => {
    const existing = rect("Existing", "existing", "ft", 0, 0, 60, 40, 0, "main");
    const proposed = rect("Proposed", "proposed", "ft", 0, 0, 60, 40, 2, "anti");
    const result = cutFillBetween(existing, proposed);
    expect(result.facetCount).toBeGreaterThan(2);
    expect(to(result.fill, "ft3")).toBeCloseTo(4800, 4);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 4);
  });

  it("uses the mean corner height on a sloping plane", () => {
    const existing = rect("Existing", "existing", "ft", 0, 0, 30, 10, 0);
    const proposed = rect("Proposed", "proposed", "ft", 0, 0, 30, 10, (x) => (x / 30) * 3);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.fill, "ft3")).toBeCloseTo(450, 4);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 6);
    expect(to(result.net, "yd3")).toBeCloseTo(450 / 27, 6);
  });

  it("splits a triangle on the zero contour instead of netting cut and fill", () => {
    const existing = tin("Existing", "existing", "ft", [["1", 0, 0, 0], ["2", 6, 0, 0], ["3", 0, 6, 0]], [{ a: 0, b: 1, c: 2 }]);
    const proposed = tin("Proposed", "proposed", "ft", [["1", 0, 0, -3], ["2", 6, 0, 3], ["3", 0, 6, 3]], [{ a: 0, b: 1, c: 2 }]);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.cut, "ft3")).toBeCloseTo(4.5, 4);
    expect(to(result.fill, "ft3")).toBeCloseTo(22.5, 4);
    expect(to(result.net, "ft3")).toBeCloseTo(18, 4);
  });

  it("counts only the overlap, not either surface's full area", () => {
    const existing = rect("Existing", "existing", "ft", 0, 0, 10, 10, 0);
    const proposed = rect("Proposed", "proposed", "ft", 5, 0, 15, 10, 1);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.overlapArea, "ft2")).toBeCloseTo(50, 4);
    expect(to(result.fill, "ft3")).toBeCloseTo(50, 4);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 6);
    expect(to(result.existingArea, "ft2")).toBeCloseTo(100, 4);
    expect(to(result.proposedArea, "ft2")).toBeCloseTo(100, 4);
  });

  it("reports zero when the surfaces don't overlap", () => {
    const existing = rect("Existing", "existing", "ft", 0, 0, 10, 10, 0);
    const proposed = rect("Proposed", "proposed", "ft", 20, 0, 30, 10, 1);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.cut, "yd3")).toBeCloseTo(0, 8);
    expect(to(result.fill, "yd3")).toBeCloseTo(0, 8);
    expect(to(result.net, "m3")).toBeCloseTo(0, 8);
    expect(to(result.overlapArea, "ft2")).toBeCloseTo(0, 6);
    expect(result.issues.join(" ")).toMatch(/don't overlap/);
    expect(yd3(existing, proposed, "fill")).toBeCloseTo(0, 8);
  });
});

describe("LandXML 1.2", () => {
  it("imports demo-site in feet and matches the 5,000 ft³ hand check", () => {
    const imported = importLandXml(DEMO_SITE);
    expect(imported.problems).toEqual([]);
    expect(imported.surfaces.map((s) => [s.name, s.role, s.linearUnit, s.id])).toEqual([
      ["Existing", "existing", "ft", "gs-existing"],
      ["Proposed", "proposed", "ft", "gs-proposed"],
    ]);
    const existing = imported.surfaces[0];
    const proposed = imported.surfaces[1];
    if (!existing || !proposed) throw new Error("demo-site has both surfaces");
    expect(to(existing.points[0]!.elevation, "ft")).toBeCloseTo(100, 8);
    expect(to(proposed.points[0]!.elevation, "ft")).toBeCloseTo(101.25, 8);
    // Northing is y, easting is x: point 2 is northing 0, easting 80.
    expect(to(existing.points[1]!.easting, "ft")).toBeCloseTo(80, 8);
    expect(to(existing.points[1]!.northing, "ft")).toBeCloseTo(0, 8);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.overlapArea, "ft2")).toBeCloseTo(4000, 4);
    expect(to(result.fill, "ft3")).toBeCloseTo(5000, 4);
    expect(to(result.cut, "yd3")).toBeCloseTo(0, 6);
    expect(to(result.fill, "yd3")).toBeCloseTo(5000 / 27, 5);
    expect(to(result.net, "m3")).toBeCloseTo(to(qty("volume", 5000, "ft3"), "m3"), 5);
  });

  it("reads metres from Units and keeps the volume in cubic metres", () => {
    const xml = `<?xml version="1.0"?>
      <LandXML version="1.2">
        <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter"/></Units>
        <Surfaces>
          <Surface name="Existing"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 10</P><P id="2">0 10 10</P><P id="3">10 10 10</P><P id="4">10 0 10</P></Pnts>
            <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
          </Definition></Surface>
          <Surface name="Proposed"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 11</P><P id="2">0 10 11</P><P id="3">10 10 11</P><P id="4">10 0 11</P></Pnts>
            <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
          </Definition></Surface>
        </Surfaces>
      </LandXML>`;
    const imported = importLandXml(xml);
    expect(imported.problems).toEqual([]);
    const [existing, proposed] = imported.surfaces;
    if (!existing || !proposed) throw new Error("both surfaces");
    expect(existing.linearUnit).toBe("m");
    expect(existing.sourceLinearUnit).toBe("meter");
    const result = cutFillBetween(existing, proposed);
    // 10 m × 10 m × 1 m = 100 m³.
    expect(to(result.fill, "m3")).toBeCloseTo(100, 6);
    expect(to(result.cut, "m3")).toBeCloseTo(0, 8);
    expect(to(result.fill, "yd3")).toBeCloseTo(to(qty("volume", 100, "m3"), "yd3"), 6);
  });

  it("converts US survey feet to metres at 1200/3937 and does not call them international feet", () => {
    const xml = `<?xml version="1.0"?>
      <LandXML version="1.2">
        <Units><Imperial linearUnit="USSurveyFoot"/></Units>
        <Surfaces>
          <Surface name="EG"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 10 0</P><P id="4">10 0 0</P></Pnts>
            <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
          </Definition></Surface>
          <Surface name="FG"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 1</P><P id="2">0 10 1</P><P id="3">10 10 1</P><P id="4">10 0 1</P></Pnts>
            <Faces><F>1 2 3</F><F>1 3 4</F></Faces>
          </Definition></Surface>
        </Surfaces>
      </LandXML>`;
    const imported = importLandXml(xml);
    expect(imported.problems).toEqual([]);
    expect(imported.notes.join(" ")).toMatch(/US survey foot/);
    const [existing, proposed] = imported.surfaces;
    if (!existing || !proposed) throw new Error("both surfaces");
    expect(existing.role).toBe("existing");
    expect(proposed.role).toBe("proposed");
    expect(existing.linearUnit).toBe("m");
    expect(existing.sourceLinearUnit).toBe("USSurveyFoot");
    const usft = 1200 / 3937;
    expect(to(existing.points[1]!.easting, "m")).toBeCloseTo(10 * usft, 9);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.fill, "m3")).toBeCloseTo(100 * usft * usft * usft, 8);
  });

  it("imports a non-overlapping pair from LandXML as zero volume", () => {
    const xml = `<?xml version="1.0"?>
      <LandXML version="1.2"><Units><Imperial linearUnit="foot"/></Units>
        <Surfaces>
          <Surface name="Existing"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 0 0</P></Pnts>
            <Faces><F>1 2 3</F></Faces>
          </Definition></Surface>
          <Surface name="Proposed"><Definition surfType="TIN">
            <Pnts><P id="1">0 20 1</P><P id="2">0 30 1</P><P id="3">10 20 1</P></Pnts>
            <Faces><F>1 2 3</F></Faces>
          </Definition></Surface>
        </Surfaces>
      </LandXML>`;
    const imported = importLandXml(xml);
    expect(imported.problems).toEqual([]);
    const [existing, proposed] = imported.surfaces;
    if (!existing || !proposed) throw new Error("both surfaces");
    const result = cutFillBetween(existing, proposed);
    expect(to(result.fill, "ft3")).toBeCloseTo(0, 6);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 6);
    expect(result.issues.join(" ")).toMatch(/don't overlap/);
  });

  it.each([
    ["plain text", "not landxml at all", /isn't a LandXML/],
    ["no units", `<LandXML version="1.2"><Surfaces><Surface name="Existing"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>`, /doesn't say its units/],
    ["bad face", `<LandXML version="1.2"><Units><Imperial linearUnit="foot"/></Units><Surfaces><Surface name="Existing"><Definition surfType="TIN"><Pnts><P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P></Pnts><Faces><F>1 2 9</F></Faces></Definition></Surface></Surfaces></LandXML>`, /point 9/],
    ["not a TIN", `<LandXML version="1.2"><Units><Metric linearUnit="meter"/></Units><Surfaces><Surface name="Grid"><Definition surfType="Grid"><Pnts><P id="1">0 0 0</P></Pnts></Definition></Surface></Surfaces></LandXML>`, /no TIN|TIN/],
    ["unclosed", `<LandXML version="1.2"><Units><Imperial linearUnit="foot"/></Units>`, /never closes/],
  ])("refuses a malformed file (%s)", (_label, xml, pattern) => {
    const imported = importLandXml(xml);
    expect(imported.surfaces).toEqual([]);
    expect(imported.problems.join(" ")).toMatch(pattern);
  });
});

describe("grading surfaces in the model", () => {
  const modelId = "c5v-landxml";

  function commit(head: ModelState, command: unknown): ModelState {
    const parsed = withPackSet(SET, () => commandSchema.safeParse(command));
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    const decided = withUpgradePolicy(() => true, () =>
      planCommit(head, [], { idempotencyKey: `c5v-xml-${head.revision}`, baseRevision: head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command: parsed.data }, () => "2026-01-15T00:00:00.000Z"),
    );
    if (!decided.ok) throw new Error(decided.error.message);
    return decided.model;
  }

  beforeAll(() => {
    bindModelPacks(modelId, SET);
  });

  function empty(): ModelState {
    return { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  }

  it("imports demo-site through the pack command and the calc reports the same yards", () => {
    const model = commit(empty(), { type: IMPORT_LANDXML_SURFACES, landXml: DEMO_SITE });
    const read = readGradingSurfaces(model.elements);
    expect(read.problems).toEqual([]);
    expect(read.surfaces.map((s) => s.id).sort()).toEqual(["gs-existing", "gs-proposed"]);
    const run = runPackCalc(SET, { calc: "civil.surface_cut_fill", inputs: { existingId: "gs-existing", proposedId: "gs-proposed" }, model });
    if (!run.ok) throw new Error(run.reason);
    const value = (key: string): number => {
      const found = run.run.values.find((v) => v.key === key);
      return typeof found?.value === "number" ? found.value : Number.NaN;
    };
    expect(run.run.values.find((v) => v.key === "fill_yd3")?.unit).toBe("yd3");
    expect(run.run.values.find((v) => v.key === "fill_m3")?.unit).toBe("m3");
    expect(value("fill_yd3")).toBeCloseTo(5000 / 27, 5);
    expect(value("cut_yd3")).toBeCloseTo(0, 6);
    expect(value("net_yd3")).toBeCloseTo(5000 / 27, 5);
    expect(value("overlap_area_ft2")).toBeCloseTo(4000, 3);
    expect(run.run.issues.some((issue) => /licensed civil engineer/.test(issue.message))).toBe(true);
    expect(run.run.citations.map((c) => c.text).join(" ")).toMatch(/Prismoidal volume/);
  });

  it("imports nothing from a malformed file", () => {
    const head = empty();
    expect(() => commit(head, { type: IMPORT_LANDXML_SURFACES, landXml: "hello" })).toThrow(/isn't a LandXML/);
    expect(Object.keys(head.elements)).toEqual([]);
  });

  it("skips LandXML 1.2 invisible faces (i=\"1\") and accepts trailing XML comments", () => {
    const xml = `<?xml version="1.0"?>
      <LandXML version="1.2">
        <Units><Imperial linearUnit="foot"/></Units>
        <Surfaces>
          <Surface name="Existing"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 0</P><P id="2">0 10 0</P><P id="3">10 10 0</P><P id="4">10 0 0</P><!-- trailing --></Pnts>
            <Faces><F>1 2 3</F><F i="1">1 3 4</F><!-- trailing --></Faces>
          </Definition></Surface>
          <Surface name="Proposed"><Definition surfType="TIN">
            <Pnts><P id="1">0 0 1</P><P id="2">0 10 1</P><P id="3">10 10 1</P><P id="4">10 0 1</P></Pnts>
            <Faces><F>1 2 3</F><F i="1">1 3 4</F></Faces>
          </Definition></Surface>
          <!-- trailing -->
        </Surfaces>
      </LandXML>`;
    const imported = importLandXml(xml);
    expect(imported.problems).toEqual([]);
    expect(imported.notes.some((n) => /skipped 1 invisible face/.test(n))).toBe(true);
    const [existing, proposed] = imported.surfaces;
    if (!existing || !proposed) throw new Error("expected both surfaces");
    expect(existing.faces).toHaveLength(1);
    const result = cutFillBetween(existing, proposed);
    expect(to(result.fill, "ft3")).toBeCloseTo(50, 4);
  });

  it("enforces XML nesting depth and vertex count caps", () => {
    const tooDeep = "<a>".repeat(MAX_XML_DEPTH + 2) + "</a>".repeat(MAX_XML_DEPTH + 2);
    const deepRes = importLandXml(tooDeep);
    expect(deepRes.surfaces).toEqual([]);
    expect(deepRes.problems.join(" ")).toMatch(/nested more than/);

    const pts = Array.from({ length: MAX_TIN_POINTS + 1 }, (_, i) => `<P id="${i + 1}">0 ${i} 0</P>`).join("");
    const tooManyPts = `<LandXML version="1.2"><Units><Imperial linearUnit="foot"/></Units><Surfaces><Surface name="Huge"><Definition surfType="TIN"><Pnts>${pts}</Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>`;
    const ptsRes = importLandXml(tooManyPts);
    expect(ptsRes.surfaces).toEqual([]);
    expect(ptsRes.problems.join(" ")).toMatch(new RegExp(`${MAX_TIN_POINTS} points`));
  });

  it("uses the 2D spatial grid to evaluate a 2,048 x 2,048 face site TIN accurately and quickly", () => {
    const grid = (name: string, role: SurfaceRole, n: number, z: number): GradingSurface => {
      const points: TinVertex[] = [];
      for (let y = 0; y <= n; y++) {
        for (let x = 0; x <= n; x++) {
          points.push({ id: `${x}_${y}`, easting: length("ft", x * 10), northing: length("ft", y * 10), elevation: length("ft", z) });
        }
      }
      const faces: TinFace[] = [];
      const stride = n + 1;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i0 = y * stride + x;
          const i1 = i0 + 1;
          const i2 = i0 + stride + 1;
          const i3 = i0 + stride;
          faces.push({ a: i0, b: i1, c: i2 }, { a: i0, b: i2, c: i3 });
        }
      }
      return { id: `gs-${name}`, name, role, linearUnit: "ft", sourceLinearUnit: "foot", points, faces };
    };
    const existing = grid("ex", "existing", 32, 100);
    const proposed = grid("pr", "proposed", 32, 101);
    const t0 = performance.now();
    const result = cutFillBetween(existing, proposed);
    const elapsedMs = performance.now() - t0;
    expect(to(result.fill, "ft3")).toBeCloseTo(320 * 320, 2);
    expect(to(result.cut, "ft3")).toBeCloseTo(0, 6);
    expect(elapsedMs).toBeLessThan(500);
  });
});
