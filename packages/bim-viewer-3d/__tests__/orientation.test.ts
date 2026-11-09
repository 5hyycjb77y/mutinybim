/**
 * @jest-environment node
 */
import { elevationCut, isElevationSide, nearestTurn, orientationFor, projectAxis, SIDES, sideVector, squareOnSide } from "../src/orientation";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Camera position (scene: X east, Y up, Z south) for camera-controls angles. */
function cameraAt(o: { azimuth: number; polar: number }) {
  return { x: Math.sin(o.polar) * Math.sin(o.azimuth), y: Math.cos(o.polar), z: Math.sin(o.polar) * Math.cos(o.azimuth) };
}

describe("orientation targets", () => {
  it("has six sides, one at each end of each model axis", () => {
    expect(SIDES).toHaveLength(6);
    for (const side of SIDES) {
      const v = sideVector(side);
      expect(Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)).toBe(1);
    }
  });

  it("Top looks straight down with north up the screen", () => {
    const o = orientationFor("top");
    close(o.polar, 0);
    close(o.azimuth, 0);
  });

  it("Bottom looks straight up", () => {
    close(orientationFor("bottom").polar, Math.PI);
  });

  it.each([
    ["south", { x: 0, z: 1 }],
    ["north", { x: 0, z: -1 }],
    ["east", { x: 1, z: 0 }],
    ["west", { x: -1, z: 0 }],
  ] as const)("%s puts the camera level on that side", (side, scene) => {
    const o = orientationFor(side);
    close(o.polar, Math.PI / 2);
    const at = cameraAt(o);
    close(at.x, scene.x);
    close(at.z, scene.z);
    close(at.y, 0);
  });

  it("any direction puts the camera on that side of the model", () => {
    for (const d of [...SIDES.map(sideVector), { x: 1, y: -1, z: 1 }, { x: -1, y: 1, z: 1 }, { x: 2, y: 3, z: -1 }]) {
      const at = cameraAt(orientationFor(d));
      const len = Math.hypot(d.x, d.y, d.z);
      // Scene: x = east, y = up, z = south.
      close(at.x, d.x / len, 1e-9);
      close(at.y, d.z / len, 1e-9);
      close(at.z, -d.y / len, 1e-9);
    }
  });

  it("a three-quarter view from above the south-east is the classic isometric angle", () => {
    const o = orientationFor({ x: 1, y: -1, z: 1 });
    close(o.polar, Math.acos(1 / Math.sqrt(3)));
    close(o.azimuth, Math.PI / 4);
  });

  it("refuses a zero direction", () => {
    expect(() => orientationFor({ x: 0, y: 0, z: 0 })).toThrow();
  });
});

describe("turning the short way", () => {
  it("never spins more than half a turn", () => {
    close(nearestTurn(0.1, Math.PI * 2 - 0.1), -0.1);
    close(nearestTurn(7, 0), Math.PI * 2);
    close(nearestTurn(-3, 3), 3 - Math.PI * 2);
  });
});

describe("square on a side", () => {
  it("reads Top whatever the spin, and a side within tolerance, from the camera angles", () => {
    expect(squareOnSide({ azimuth: 1.3, polar: 0.001 })).toBe("top");
    expect(squareOnSide({ azimuth: 0.4, polar: Math.PI - 0.001 })).toBe("bottom");
    expect(squareOnSide({ azimuth: Math.PI * 2 + 0.01, polar: Math.PI / 2 })).toBe("south");
    expect(squareOnSide(orientationFor("east"))).toBe("east");
    expect(squareOnSide({ azimuth: 0.3, polar: 1 })).toBeNull();
    expect(squareOnSide(orientationFor({ x: 1, y: -1, z: 0 }))).toBeNull();
  });

  it("knows which sides are elevations", () => {
    expect(isElevationSide("south")).toBe(true);
    expect(isElevationSide("east")).toBe(true);
    expect(isElevationSide("top")).toBe(false);
    expect(isElevationSide(null)).toBe(false);
  });
});

describe("axes follow the camera", () => {
  it("from the south: X points right, Z up the screen, Y away", () => {
    const o = orientationFor("south");
    const x = projectAxis(o, "x");
    const y = projectAxis(o, "y");
    const z = projectAxis(o, "z");
    close(x.x, 1);
    close(z.y, -1);
    close(y.z, -1);
  });

  it("from the top: X right, Y (north) up the screen, Z toward you", () => {
    const o = orientationFor("top");
    close(projectAxis(o, "x").x, 1);
    close(projectAxis(o, "y").y, -1);
    close(projectAxis(o, "z").z, 1);
  });

  it("from the east: north points right", () => {
    const o = orientationFor("east");
    close(projectAxis(o, "y").x, 1);
    close(projectAxis(o, "x").z, 1);
  });
});

describe("elevation from here", () => {
  const rect = { min: { x: 0, y: 0 }, max: { x: 10_000, y: 6_000 } };

  it("from the south: a line south of the model, looking north across all of it", () => {
    const cut = elevationCut("south", rect, 1000);
    expect(cut.start).toEqual({ x: -1000, y: -1000 });
    expect(cut.end).toEqual({ x: 11_000, y: -1000 });
    expect(cut.depthMm).toBe(8000);
    // The section viewer looks to the left of start→end: (-dy, dx) normalised.
    const dx = cut.end.x - cut.start.x;
    const dy = cut.end.y - cut.start.y;
    const look = { x: -dy / Math.hypot(dx, dy), y: dx / Math.hypot(dx, dy) };
    close(look.x, 0);
    close(look.y, 1);
  });

  it.each(["north", "east", "west"] as const)("from the %s it looks back toward the model", (side) => {
    const cut = elevationCut(side, rect, 500);
    const dx = cut.end.x - cut.start.x;
    const dy = cut.end.y - cut.start.y;
    const look = { x: -dy, y: dx };
    const centre = { x: 5000, y: 3000 };
    const toCentre = { x: centre.x - cut.start.x, y: centre.y - cut.start.y };
    expect(look.x * toCentre.x + look.y * toCentre.y).toBeGreaterThan(0);
    // Long enough to cover the model, deep enough to reach its far side.
    const width = side === "north" ? 10_000 : 6_000;
    const depth = side === "north" ? 6_000 : 10_000;
    expect(Math.hypot(dx, dy)).toBe(width + 1000);
    expect(cut.depthMm).toBe(depth + 1000);
  });
});
