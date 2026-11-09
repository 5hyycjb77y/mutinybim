/**
 * @jest-environment node
 *
 * The civil engineering on its own, against hand checks: rational runoff,
 * composite C, Manning full flow, stationing on an alignment with an arc,
 * and the two calcs.
 */
import { qty, to } from "@permitzip/bim-units";
import { asElementId } from "@permitzip/bim-kernel";
import type { PathPlacement } from "@permitzip/bim-kernel/placement";
import { compositeCoefficient, rationalRunoff, runoffCoefficientRow } from "../src/runoff";
import { manningFullFlow } from "../src/manning";
import { alignmentLength, formatStation, parseStation, pointAt, profileElevation, stationOf } from "../src/stationing";
import { manningCapacityInput, rationalRunoffInput, runManningCapacity, runRationalRunoff } from "../src/calcs";

const FT = 304.8;

describe("rational method Q = C·i·A", () => {
  it("matches the hand check for a paved 30,000 ft² catchment at 4 in/h", () => {
    // Q = C·i·A = 0.95 × (4/12 ft/h ÷ 3600 s/h) × 30,000 ft²
    //   = 0.95 × 4 × 30,000 / 43,200 = 114,000 / 43,200 = 2.638889 cfs.
    // The US shortcut (acres × in/h read as cfs): 0.95 × 4 × 0.688705 ac = 2.617080, 0.83 % low.
    const q = rationalRunoff(0.95, qty("rainfall_intensity", 4, "in/h"), qty("area", 30000, "ft2"));
    expect(to(q, "cfs")).toBeCloseTo(2.638889, 5);
  });

  it("is exact in SI: 1 ha of C = 0.5 at 36 mm/h is 0.05 m³/s", () => {
    // 0.5 × (0.036 m / 3600 s) × 10,000 m² = 0.5 × 1e-5 × 1e4 = 0.05 m³/s.
    expect(to(rationalRunoff(0.5, qty("rainfall_intensity", 36, "mm/h"), qty("area", 1, "ha")), "m3/s")).toBeCloseTo(0.05, 10);
  });

  it("refuses a C outside 0–1", () => {
    expect(() => rationalRunoff(1.2, qty("rainfall_intensity", 4, "in/h"), qty("area", 1, "acre"))).toThrow(/between 0 and 1/);
  });

  it("weights C by area", () => {
    // (0.95 × 42,000 + 0.20 × 43,560) / 85,560 = (39,900 + 8,712) / 85,560 = 0.568163
    const c = compositeCoefficient([
      { c: 0.95, area: qty("area", 42000, "ft2") },
      { c: 0.2, area: qty("area", 43560, "ft2") },
    ]);
    expect(c).toBeCloseTo(0.568163, 5);
    expect(runoffCoefficientRow("lawn_heavy_average")?.design).toBe(0.2);
  });
});

describe("Manning, round pipe flowing full", () => {
  it("matches the hand check: 12 in, n 0.013, S 0.5 %", () => {
    // A = π(1 ft)²/4 = 0.785398 ft², R = D/4 = 0.25 ft, R^(2/3) = 0.396850, S^(1/2) = 0.0707107
    // Q = 1.486/0.013 × 0.785398 × 0.396850 × 0.0707107 = 114.3077 × 0.0220406 = 2.5194 cfs
    // V = Q/A = 3.2078 ft/s
    const f = manningFullFlow(qty("length", 12, "in"), qty("slope", 0.5, "%"), 0.013);
    expect(to(f.capacity, "cfs")).toBeCloseTo(2.5194, 2);
    expect(Math.abs(to(f.capacity, "cfs") - 2.5194) / 2.5194).toBeLessThan(1e-3);
    expect(to(f.velocity, "ft/s")).toBeCloseTo(3.208, 2);
  });

  it("refuses a pipe running uphill", () => {
    expect(() => manningFullFlow(qty("length", 12, "in"), qty("slope", -0.1, "%"), 0.013)).toThrow(/uphill/);
  });
});

describe("stationing", () => {
  it("writes stations the way plans do, rounding before it splits", () => {
    expect(formatStation(qty("length", 1000, "ft"))).toBe("10+00.00");
    expect(formatStation(qty("length", 1234.567, "ft"))).toBe("12+34.57");
    expect(formatStation(qty("length", 99.996, "ft"))).toBe("1+00.00");
    expect(formatStation(qty("length", 5.5, "ft"))).toBe("0+05.50");
    expect(formatStation(qty("length", -12.5, "ft"))).toBe("-0+12.50");
    expect(formatStation(qty("length", 1250, "m"), "metric")).toBe("1+250.000");
  });

  it("reads them back", () => {
    const s = parseStation("12+34.57");
    expect(s === null ? null : to(s, "ft")).toBeCloseTo(1234.57, 6);
    expect(parseStation("12+134.57")).toBeNull();
    expect(parseStation("not a station")).toBeNull();
  });

  // A road centreline: from (0,0) east 500 ft, then a 90° left arc of radius 300 ft (bulge tan(90°/4) = 0.414214),
  // starting at station 10+00. Arc length = 300 × π/2 = 471.239 ft, total 971.239 ft.
  const road: PathPlacement = {
    kind: "path",
    levelId: asElementId("lvl-site"),
    start: { x: 0, y: 0 },
    segments: [
      { kind: "line", to: { x: 500 * FT, y: 0 } },
      { kind: "arc", to: { x: 800 * FT, y: 300 * FT }, bulge: Math.tan(Math.PI / 8) },
    ],
    startStationMm: 1000 * FT,
    profile: [
      { stationMm: 1000 * FT, elevationMm: 100 * FT },
      { stationMm: 1500 * FT, elevationMm: 105 * FT },
    ],
    offsetMm: 0,
    lateral: "center",
  };

  it("measures an alignment with an arc", () => {
    expect(to(alignmentLength(road), "ft")).toBeCloseTo(500 + 150 * Math.PI, 6);
  });

  it("finds the station and offset of a point, and the point at a station", () => {
    // (250, 20) is 250 ft along the tangent from 10+00 and 20 ft left: station 12+50.00, offset +20.
    const s = stationOf(road, { x: 250 * FT, y: 20 * FT });
    expect(formatStation(s.station)).toBe("12+50.00");
    expect(to(s.offset, "ft")).toBeCloseTo(20, 6);
    // Halfway round the arc (45°): centre (500, 300), point (500 + 300 sin 45°, 300 − 300 cos 45°) = (712.132, 87.868),
    // station 10+00 + 500 + 300 × π/4 = 1735.619 ft, heading 45°.
    const mid = pointAt(road, qty("length", 1000 + 500 + 75 * Math.PI, "ft"));
    expect(mid).not.toBeNull();
    expect((mid?.point.x ?? 0) / FT).toBeCloseTo(712.132, 2);
    expect((mid?.point.y ?? 0) / FT).toBeCloseTo(87.868, 2);
    expect(mid?.directionDeg).toBeCloseTo(45, 6);
    expect(pointAt(road, qty("length", 999, "ft"))).toBeNull();
  });

  it("reads the vertical profile", () => {
    // 1 % grade from 100.00 at 10+00: station 12+50 is 102.50.
    expect(to(profileElevation(road, qty("length", 1250, "ft")), "ft")).toBeCloseTo(102.5, 9);
  });
});

describe("calcs", () => {
  it("civil.rational_runoff gives cfs with its steps and citations", () => {
    const out = runRationalRunoff(rationalRunoffInput.parse({ area_ft2: 30000, surface: "paved", intensity_in_per_h: 4 }));
    expect(out.detail.peakCfs).toBeCloseTo(2.638889, 5);
    expect(out.detail.shortcutCfs).toBeCloseTo(2.61708, 5);
    expect(out.values[0]?.cite[0]?.text).toMatch(/Rational method/);
    expect(out.steps.map((s) => s.label)).toEqual(["Runoff coefficient", "Peak runoff"]);
  });

  it("refuses an area given twice", () => {
    expect(rationalRunoffInput.safeParse({ area_ft2: 1, area_acres: 1, surface: "paved", intensity_in_per_h: 4 }).success).toBe(false);
  });

  it("civil.manning_full_capacity flags a surcharged, flat pipe", () => {
    // 18 in PE (n 0.012) at 0.05 %: Q = 1.486/0.012 × 1.767146 × 0.375^(2/3) × 0.0223607
    //   = 123.8333 × 1.767146 × 0.520021 × 0.0223607 = 2.5446 cfs, against 4.50 cfs.
    const out = runManningCapacity(manningCapacityInput.parse({ diameter_in: 18, slope_pct: 0.05, material: "pe", flow_cfs: 4.501111 }));
    expect(out.detail.capacityCfs).toBeCloseTo(2.5446, 2);
    expect(out.issues.map((i) => i.message).join(" | ")).toMatch(/surcharges.*\| .*0\.5 % minimum/);
  });
});
