/**
 * @jest-environment node
 *
 * Round 14 P14: cleanouts proposed on a selected drain, as ghosts on the
 * generic proposer point, at the usual spots: the drain's upper end, each
 * change of direction over 45°, every 100 ft and where it meets the sewer
 * connection. Approve puts every kept cleanout on its pipe in line (the
 * kernel's insertPartOnRun), as one undo step; a spot that already has one is
 * skipped. The proposal reads the drain's own pieces only: on a 250k model
 * it stays within 50 ms.
 *
 * Fails on round 13: there was no cleanout proposer and no way to put a part
 * on a pipe.
 */
import { PROPOSER_POINT, proposersFor, runNeighbours, partNode, type ElementId, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { acceptCleanoutsCommand, CLEANOUT_PROPOSER_ID, PLUMBING_GAS_PACK, proposeCleanouts, type CleanoutAnswer } from "../src";
import { IN, SewerSite } from "./p13-fixtures";

function answer(m: ModelState, ids: readonly string[], spacingFt?: number): CleanoutAnswer {
  const a = proposeCleanouts(m, { roomIds: ids, ...(spacingFt ? { options: { spacingFt } } : {}) });
  if ("refused" in a) throw new Error(a.refused);
  return a;
}

/**
 * The P13 basement drain: 20 ft east, a 90° bend, 20 ft north. With `toManhole` it is pitched 1/4" per ft and
 * ends at the manhole (the fixture rewrites heights and the link in the records, so it is for proposing only);
 * without, it is the level drain as routed, for Approve.
 */
function site(toManhole = true): SewerSite {
  const s = new SewerSite();
  s.drawDrain();
  s.manhole({ invertFt: -20, rimFt: 0 });
  if (!toManhole) return s;
  const drop = 20 * 0.25 * IN;
  s.slope([
    [600, 600 - drop],
    [600 - drop, 600 - 2 * drop],
  ]);
  s.linkToPart("mh-1");
  return s;
}

describe("p14-cleanout-proposer", () => {
  it("is a proposer on the generic point, from the Plumbing add-on", () => {
    expect(PLUMBING_GAS_PACK.contributions.some((c) => c.pointId === PROPOSER_POINT.id)).toBe(true);
    const s = site();
    expect(proposersFor(s.model()).map((p) => p.id)).toContain(CLEANOUT_PROPOSER_ID);
  });

  it("proposes the upper end, the 90° bend and the sewer connection, with reasons", () => {
    const s = site();
    const a = answer(s.model(), [s.segments[1] as string]);
    expect(a.ghosts.map((g) => g.spot)).toEqual(["upper_end", "direction_change", "sewer_connection"]);
    expect(a.ghosts[0]?.reason).toMatch(/^Cleanout 1 of 3: the upper end of the drain/);
    expect(a.ghosts[1]?.reason).toBe("Cleanout 2 of 3: a 90° change of direction");
    expect(a.ghosts[2]?.reason).toBe("Cleanout 3 of 3: where the drain meets the sewer connection");
    expect(a.summary).toBe("3 cleanouts proposed on this drain");
    // Upper end and the bend are on the first pipe, the sewer one on the last.
    expect(a.ghosts.map((g) => g.segmentId)).toEqual([s.segments[0], s.segments[0], s.segments[1]]);
  });

  it("adds one every 100 ft (here every 10 ft, as the firm set it)", () => {
    const s = site();
    const a = answer(s.model(), [s.segments[0] as string], 10);
    expect(a.ghosts.filter((g) => g.spot === "spacing").length).toBeGreaterThanOrEqual(2);
  });

  it("Approve all puts every cleanout in line on its pipe, as one undo step", () => {
    const s = site(false);
    const before = s.model();
    const a = answer(before, [s.segments[0] as string]);
    const cmd = acceptCleanoutsCommand(before, a.ghosts);
    if (typeof cmd === "string") throw new Error(cmd);
    expect(cmd.type).toBe("batch_edits");
    s.ok(cmd);
    const m = s.model();

    const parts = Object.values(m.elements).filter((e) => e.kind === "part" && e.id.startsWith("co-"));
    expect(parts).toHaveLength(a.ghosts.length);
    expect(a.ghosts.map((g) => g.spot)).toEqual(["upper_end", "direction_change"]);
    for (const p of parts) {
      // Both of the cleanout's connectors are joined to the drain.
      const n = [...runNeighbours(m.elements, partNode(p.id, "in")), ...runNeighbours(m.elements, partNode(p.id, "out"))];
      expect(n.filter((x) => m.elements[x]?.kind === "run_segment")).toHaveLength(2);
    }
    // A second proposal skips the spots that now have a cleanout.
    expect(answer(m, [s.segments[0] as string]).ghosts).toHaveLength(0);
    // One edit, one revision (one undo step: undo itself is proved in p14-insert-part-on-run).
    expect(m.revision).toBe(before.revision + 1);
  });

  it("Dismiss keeps nothing; a ghost the person drops is not placed", () => {
    const s = site(false);
    const a = answer(s.model(), [s.segments[0] as string]);
    expect(acceptCleanoutsCommand(s.model(), [])).toBe("Nothing to place: no proposed cleanout was kept.");
    const kept = a.ghosts.filter((g) => g.spot !== "direction_change");
    const cmd = acceptCleanoutsCommand(s.model(), kept);
    if (typeof cmd === "string") throw new Error(cmd);
    s.ok(cmd);
    expect(Object.values(s.model().elements).filter((e) => e.kind === "part" && e.id.startsWith("co-"))).toHaveLength(kept.length);
  });

  it("refuses a selection that isn't a level drain, in words", () => {
    const s = site();
    expect(proposeCleanouts(s.model(), { roomIds: ["mh-1"] })).toEqual({ refused: "Select a level drain pipe to propose cleanouts on" });
  });

  it("proposes on a selected drain within 50 ms in a 250k-element model", () => {
    const s = site();
    const m = s.model();
    const filler: Record<string, ModelState["elements"][string]> = { ...m.elements };
    const lvl = m.elements["lvl-b"];
    const seg = m.elements[s.segments[0] as string] as RunSegment;
    for (let i = 0; i < 250_000; i += 1) filler[`far-${i}`] = { ...seg, id: `far-${i}` as ElementId, links: {}, branches: [], systemId: `other-${i % 50}` as ElementId };
    const big: ModelState = { ...m, elements: filler };
    expect(lvl).toBeDefined();
    answer(big, [s.segments[0] as string]);
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) answer(big, [s.segments[0] as string]);
    const ms = (performance.now() - t0) / 5;
    expect(ms).toBeLessThan(50);
  });
});
