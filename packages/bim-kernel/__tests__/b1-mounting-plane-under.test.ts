/**
 * @jest-environment node
 *
 * Review video (Nov 6, 48:39): a diffuser placed over the 9 ft mounting
 * plane he had just made landed on "B.O. STRUCTURE's floor plane" instead,
 * because placement only knew a plane when the 3D surface pick happened to hit
 * its mesh. `mountingPlaneUnder` answers from the pointer's ray at each
 * plane's height, so every view (3D, live plan, printed plan) offers the
 * plane under the pointer as the host.
 */
import { DEFAULT_SETTINGS, mountingPlaneUnder, planCommit, type Changeset, type Command, type ModelState, type Vec2 } from "../src";

const FT = 304.8;

function build(commands: readonly Command[]): ModelState {
  let model: ModelState = { modelId: "b1-planes", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const log: Changeset[] = [];
  commands.forEach((command, i) => {
    const d = planCommit(model, [], { idempotencyKey: `k-${i}`, baseRevision: model.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command, clientSessionId: "tab" }, () => "2026-11-06T00:00:00.000Z", log);
    if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
    model = d.model;
    log.push(d.changeset);
  });
  return model;
}

const MODEL = build([
  { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
  { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 14 * FT },
  { type: "create_mounting_plane", planeId: "mp-9", levelId: "lvl-1", name: "Open office 9'", heightMm: 9 * FT, corner1: { x: 0, y: 0 }, corner2: { x: 20 * FT, y: 20 * FT } },
  { type: "create_mounting_plane", planeId: "mp-10", levelId: "lvl-1", name: "Lobby 10'", heightMm: 10 * FT, corner1: { x: 10 * FT, y: 0 }, corner2: { x: 30 * FT, y: 20 * FT } },
  { type: "create_mounting_plane", planeId: "mp-up", levelId: "lvl-2", name: "Level 2 open", heightMm: 9 * FT, corner1: { x: 50 * FT, y: 0 }, corner2: { x: 60 * FT, y: 10 * FT } },
]);

/** A straight-down pointer: the same plan point at every height (a plan, or the top-down camera). */
const straightDown = (p: Vec2) => () => p;

describe("mountingPlaneUnder: the plane a part goes on is the one under the pointer", () => {
  it("offers the plane under the pointer, with its absolute height", () => {
    const hit = mountingPlaneUnder(MODEL, straightDown({ x: 5 * FT, y: 5 * FT }));
    expect(hit?.plane.id).toBe("mp-9");
    expect(hit?.elevationMm).toBeCloseTo(9 * FT, 3);
  });

  it("takes the higher plane where two overlap (the one seen first from above)", () => {
    expect(mountingPlaneUnder(MODEL, straightDown({ x: 15 * FT, y: 5 * FT }))?.plane.id).toBe("mp-10");
  });

  it("offers nothing off every plane, so the part falls back to the level", () => {
    expect(mountingPlaneUnder(MODEL, straightDown({ x: 40 * FT, y: 5 * FT }))).toBeNull();
  });

  it("keeps to the levels asked for (a plan offers its own level's planes)", () => {
    expect(mountingPlaneUnder(MODEL, straightDown({ x: 55 * FT, y: 5 * FT }), new Set(["lvl-1"]))).toBeNull();
    expect(mountingPlaneUnder(MODEL, straightDown({ x: 55 * FT, y: 5 * FT }), new Set(["lvl-2"]))?.plane.id).toBe("mp-up");
    // Level 2's plane sits at its floor plus 9 ft.
    expect(mountingPlaneUnder(MODEL, straightDown({ x: 55 * FT, y: 5 * FT }))?.elevationMm).toBeCloseTo(23 * FT, 3);
  });

  it("asks the ray at each plane's own height (a tilted 3D pointer meets each height at a different plan point)", () => {
    // A ray leaning +x: at 10 ft it is over the lobby plane's far edge; at 9 ft it is past the open office.
    const leaning = (elevationMm: number): Vec2 => ({ x: 35 * FT - elevationMm, y: 5 * FT });
    const hit = mountingPlaneUnder(MODEL, leaning);
    expect(hit?.plane.id).toBe("mp-10");
    expect(hit?.point.x).toBeCloseTo(25 * FT, 3);
  });
});
