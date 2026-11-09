/**
 * @jest-environment node
 *
 * Round 7 lane C: a ceiling plan draws the ceilings on its level: outline,
 * openings, the height at the middle, a cloud dashed with its role, and a
 * sloped plane's arrow with its rise. A floor plan of the same level draws
 * none of it (its cut is below the ceiling).
 *
 * Fails on the old code: the plan drawing had no `ceiling` case, so a
 * ceiling plan showed nothing of a typed ceiling.
 */
import { buildViewScene, type ModelState, type Primitive } from "../src";
import { commit, FT, officeModel, OFFICE, rect } from "./c7c-fixtures";

function texts(prims: readonly Primitive[]): string[] {
  return prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
}

function withViews(m: ModelState): ModelState {
  const crop = { min: { x: -5 * FT, y: -5 * FT }, max: { x: 45 * FT, y: 25 * FT } };
  m = commit(m, { type: "create_view", viewId: "rcp-1", name: "Level 1 RCP", viewType: "ceiling_plan", props: { level: "Level 1" }, crop });
  return commit(m, { type: "create_view", viewId: "fp-1", name: "Level 1", viewType: "floor_plan", props: { level: "Level 1" }, crop });
}

describe("c7c ceiling plans draw ceilings", () => {
  const m = withViews(
    commit(officeModel(), {
      type: "create_ceiling",
      ceilings: [
        { ceilingId: "c1", levelId: "lvl-1", spaceId: "s101", outline: OFFICE, heightMm: 9 * FT, holes: [rect(1 * FT, 1 * FT, 3 * FT, 3 * FT)] },
        { ceilingId: "cl", levelId: "lvl-1", outline: rect(25 * FT, 0, 35 * FT, 10 * FT), form: "cloud", heightMm: 10 * FT },
        { ceilingId: "sl", levelId: "lvl-1", outline: rect(25 * FT, 12 * FT, 41 * FT, 20 * FT), heightMm: 8 * FT, reference: { x: 25 * FT, y: 12 * FT }, slope: { directionDeg: 0, pitch: 0.25 } },
      ],
    }),
  );

  it("draws each ceiling's height, role and slope in the ceiling plan", () => {
    const { scene } = buildViewScene(m, "rcp-1");
    const words = texts(scene.primitives);
    expect(words).toContain("9'-0\"");
    expect(words).toContain("CLOUD 10'-0\"");
    expect(words).toContain("UP 3 IN 12");
    // The sloped plane's middle is 8 ft up its 16 ft run at 3 in 12: 8 ft + 2 ft.
    expect(words).toContain("10'-0\"");
    const dashed = scene.primitives.filter((p) => p.kind === "line" && p.dash !== undefined);
    expect(dashed.length).toBeGreaterThanOrEqual(4);
  });

  it("a floor plan of the same level draws none of it", () => {
    const { scene } = buildViewScene(m, "fp-1");
    const words = texts(scene.primitives);
    expect(words).not.toContain("9'-0\"");
    expect(words).not.toContain("CLOUD 10'-0\"");
  });
});
