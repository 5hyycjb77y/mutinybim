/**
 * @jest-environment node
 *
 * Round 13 lane P13: a basement drain walked along the drawn pipe to the
 * street manhole. Plumbing's sewer connection is a `kernel.gravity_outfall`
 * row, so the kernel's walk ends there; the findings read the inverts and
 * slope on the way. A drain that reaches the manhole below its invert says by
 * how much and selects the low point, with "Add an ejector here"; floors below
 * the rim ask for a backwater valve; a missing invert or rim says what to add.
 *
 * Fails on round 12's code: `walkToOutfall` refused ("isn't built yet") and
 * no add-on contributed an outfall row, so the walk stopped at the building
 * drain and none of these findings existed.
 */
import { pipeDims, walkToOutfall, type ElementId } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, outfallWalk } from "../src";
import { FT, SewerSite } from "./p13-fixtures";

const FLOOR_B = -10 * FT;

function site(manhole: { invertFt?: number; rimFt?: number }): SewerSite {
  const s = new SewerSite();
  s.manhole(manhole);
  s.drawDrain();
  s.slope([
    [-300, -400],
    [-400, -500],
  ]);
  s.linkToPart("mh-1");
  return s;
}

function firstOf(s: SewerSite): ElementId {
  const id = s.segments[0];
  if (!id) throw new Error("no drain");
  return id;
}

function lastInvertMm(s: SewerSite): number {
  const id = s.segments[s.segments.length - 1];
  const seg = id ? s.head.elements[id] : undefined;
  if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") throw new Error("no drain");
  return FLOOR_B + seg.end.z - pipeDims(seg.size).idMm / 2;
}

describe("p13-walk-to-manhole", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("walks from the upstream pipe through the fitting to the manhole, with each pipe's inverts and fall", () => {
    const s = site({ invertFt: -12, rimFt: -14 });
    const first = firstOf(s);
    const walk = walkToOutfall(s.model(), first);
    if ("refused" in walk) throw new Error(walk.refused);
    expect(walk.outfall).toMatchObject({ elementId: "mh-1", label: "MH-1", backwater: true });
    expect(walk.path[0]).toBe(first);
    expect(walk.path[walk.path.length - 1]).toBe("mh-1");
    expect(walk.path).toEqual(expect.arrayContaining(s.segments));
    const r = outfallWalk(s.model(), first);
    expect(r.profile.map((p) => p.segmentId)).toEqual(s.segments);
    expect(r.profile.every((p) => p.slopeInPerFt > 0)).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("a drain reaching the manhole 0.4 ft below its invert can't drain by gravity: the low point is selected, with Add an ejector here", () => {
    const probe = site({ invertFt: -20, rimFt: -20 });
    const invertFt = (lastInvertMm(probe) + 0.4 * FT) / FT;
    const s = site({ invertFt, rimFt: -20 });
    const first = firstOf(s);
    const r = outfallWalk(s.model(), first);
    const low = s.segments[s.segments.length - 1];
    expect(r.findings).toEqual([
      { code: "below_invert", message: "Building sewer reaches MH-1 0.4 ft below its invert: it can't drain by gravity", selectIds: [low], fix: { label: "Add an ejector here", places: "ejector", at: low } },
    ]);
  });

  it("the Basement below the manhole's rim asks for a backwater valve on its branch", () => {
    const s = site({ invertFt: -12, rimFt: -2 });
    const first = firstOf(s);
    const r = outfallWalk(s.model(), first);
    expect(r.findings).toEqual([
      { code: "backwater_required", message: "Fixtures on Basement sit below MH-1's rim: a backwater valve is required on their branch", selectIds: [first], fix: { label: "Place a backwater valve", places: "backwater_valve", at: first } },
    ]);
  });

  it("never guesses: a manhole with no invert or rim says what to add", () => {
    const s = site({});
    const r = outfallWalk(s.model(), firstOf(s));
    expect(r.findings.map((f) => f.message)).toEqual(["Can't check the fall to MH-1 yet: add its invert", "Can't check for backwater yet: add MH-1's rim"]);
  });

  it("a pipe that rises toward the manhole is named", () => {
    const s = site({ invertFt: -12, rimFt: -14 });
    s.slope([
      [-300, -400],
      [-400, -200],
    ]);
    const r = outfallWalk(s.model(), firstOf(s));
    const second = s.segments[1];
    expect(r.findings.filter((f) => f.code === "runs_uphill").map((f) => f.selectIds)).toEqual([[second]]);
  });

  it("a drain connected to nothing that reaches an outfall says what to draw", () => {
    const s = new SewerSite();
    s.manhole({ invertFt: -12, rimFt: -14 });
    s.drawDrain();
    const r = outfallWalk(s.model(), firstOf(s));
    expect(r.outfall).toBeNull();
    expect(r.findings[0]?.code).toBe("no_outfall");
    expect(r.findings[0]?.message).toMatch(/^Nothing drawn connects .+ to where it leaves the building: draw the line on to an outfall/);
  });
});
