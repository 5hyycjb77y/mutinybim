/**
 * @jest-environment node
 *
 * Measuring geometric placements (5c item c): arcs by bulge, stations,
 * profile elevations, area with holes and justification. Fails on the code
 * before 5c: `placement/geometric-math.ts` did not exist, so a pack placing a
 * beam by its top flange, an alignment by stations or a deck with a shaft
 * had nothing to measure them with.
 */
import { asElementId, areaOf, lineCentreline, pathLength, pathPieces, pointAtStation, polygonAreaAndCentroid, profileElevationAt, stationOfPoint, type LinePlacement, type PathPlacement } from "../src";

const L = asElementId("lvl-1");
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("arcs by bulge", () => {
  // A quarter circle of radius 10 m about the origin, counter-clockwise from east to north.
  const quarter: PathPlacement = { kind: "path", levelId: L, start: { x: 10_000, y: 0 }, segments: [{ kind: "arc", to: { x: 0, y: 10_000 }, bulge: Math.tan(Math.PI / 8) }], offsetMm: 0, lateral: "center" };

  it("finds the centre, radius and length of a quarter circle", () => {
    const [p] = pathPieces(quarter);
    if (p?.kind !== "arc") throw new Error("an arc");
    close(p.center.x, 0, 1e-6);
    close(p.center.y, 0, 1e-6);
    close(p.radiusMm, 10_000, 1e-6);
    close(pathLength(quarter), (Math.PI / 2) * 10_000, 1e-6);
  });

  it("a half circle (bulge 1) is centred on its chord; a clockwise one (bulge -1) runs the other way", () => {
    const ccw: PathPlacement = { ...quarter, start: { x: 1000, y: 0 }, segments: [{ kind: "arc", to: { x: -1000, y: 0 }, bulge: 1 }] };
    const mid = pointAtStation(ccw, (Math.PI * 1000) / 2);
    close(mid?.point.x ?? NaN, 0, 1e-6);
    close(mid?.point.y ?? NaN, 1000, 1e-6);
    const cw = pointAtStation({ ...ccw, segments: [{ kind: "arc", to: { x: -1000, y: 0 }, bulge: -1 }] }, (Math.PI * 1000) / 2);
    close(cw?.point.y ?? NaN, -1000, 1e-6);
  });

  it("the point and direction at a station, counting from the start station", () => {
    const p = pointAtStation({ ...quarter, startStationMm: 304_800 }, 304_800 + (Math.PI / 4) * 10_000);
    close(p?.point.x ?? NaN, 10_000 * Math.SQRT1_2, 1e-6);
    close(p?.point.y ?? NaN, 10_000 * Math.SQRT1_2, 1e-6);
    close(p?.directionDeg ?? NaN, 135, 1e-9); // tangent to a counter-clockwise circle at 45°
    expect(pointAtStation({ ...quarter, startStationMm: 304_800 }, 0)).toBeNull(); // before the path starts
  });
});

describe("stations along a line-and-arc alignment", () => {
  // 100 m east, then a 90° left curve of radius 50 m.
  const alignment: PathPlacement = {
    kind: "path",
    levelId: L,
    start: { x: 0, y: 0 },
    segments: [
      { kind: "line", to: { x: 100_000, y: 0 } },
      { kind: "arc", to: { x: 150_000, y: 50_000 }, bulge: Math.tan(Math.PI / 8) },
    ],
    startStationMm: 1_000_000,
    offsetMm: 0,
    lateral: "center",
  };

  it("station and signed offset of a point beside the line", () => {
    const s = stationOfPoint(alignment, { x: 40_000, y: 3_000 });
    close(s.stationMm, 1_040_000);
    close(s.offsetMm, 3_000); // left of travel
    close(stationOfPoint(alignment, { x: 40_000, y: -2_000 }).offsetMm, -2_000);
  });

  it("station of a point on the curve: round trip through pointAtStation", () => {
    const at = pointAtStation(alignment, 1_100_000 + 25_000 * Math.PI * 0.5);
    if (!at) throw new Error("on the path");
    const back = stationOfPoint(alignment, at.point);
    close(back.stationMm, 1_100_000 + 25_000 * Math.PI * 0.5, 1e-4);
    close(back.offsetMm, 0, 1e-6);
  });

  it("profile: linear between points, flat past the ends, offset with none", () => {
    const withProfile: PathPlacement = { ...alignment, profile: [{ stationMm: 1_000_000, elevationMm: 1000 }, { stationMm: 1_100_000, elevationMm: 3000 }] };
    close(profileElevationAt(withProfile, 1_050_000), 2000);
    close(profileElevationAt(withProfile, 900_000), 1000);
    close(profileElevationAt(withProfile, 1_200_000), 3000);
    close(profileElevationAt({ ...alignment, offsetMm: 450 }, 1_050_000), 450);
  });
});

describe("areas with holes", () => {
  const square = [{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 10_000, y: 10_000 }, { x: 0, y: 10_000 }];
  const shaft = [{ x: 1000, y: 1000 }, { x: 1000, y: 3000 }, { x: 3000, y: 3000 }, { x: 3000, y: 1000 }]; // clockwise

  it("net area and centroid, whichever way the rings wind", () => {
    const r = polygonAreaAndCentroid(square, [shaft]);
    close(r.areaMm2, 100e6 - 4e6);
    // Moments: 100e6 at (5000, 5000) less 4e6 at (2000, 2000).
    close(r.centroid?.x ?? NaN, (100e6 * 5000 - 4e6 * 2000) / 96e6, 1e-6);
    const reversed = polygonAreaAndCentroid([...square].reverse(), [[...shaft].reverse()]);
    close(reversed.areaMm2, 96e6);
    close(reversed.centroid?.y ?? NaN, r.centroid?.y ?? NaN, 1e-6);
  });

  it("a sloped roof's surface area is longer than its plan by the slope", () => {
    const a = areaOf({ outline: square, slope: { directionDeg: 0, rise: 0.25 } });
    close(a.planAreaMm2, 100e6);
    close(a.surfaceAreaMm2, 100e6 * Math.sqrt(1 + 0.0625), 1e-3);
  });

  it("no area, no centroid", () => {
    expect(polygonAreaAndCentroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]).centroid).toBeNull();
  });
});

describe("line justification", () => {
  const wallLine: LinePlacement = { kind: "line", levelId: L, start: { x: 0, y: 0 }, end: { x: 5000, y: 0 }, startOffsetMm: 0, endOffsetMm: 0, lateral: "left", vertical: "bottom" };

  it("a line on the left face puts the centreline half the width to the right", () => {
    const c = lineCentreline(wallLine, 200);
    expect([c.start.x, c.start.y, c.end.x, c.end.y]).toEqual([0, -100, 5000, -100]);
    expect(lineCentreline({ ...wallLine, lateral: "right" }, 200).start.y).toBe(100);
    expect(lineCentreline({ ...wallLine, lateral: "center" }, 200).start.y).toBe(0);
  });

  it("a beam by its top sits half its depth below, sloped ends kept", () => {
    const c = lineCentreline({ ...wallLine, lateral: "center", vertical: "top", startOffsetMm: 3000, endOffsetMm: 3500 }, 150, 300);
    expect([c.start.z, c.end.z]).toEqual([2850, 3350]);
    close(c.lengthMm, Math.hypot(5000, 500));
  });
});
