/**
 * @jest-environment node
 *
 * Round 11 L11 (product owner answer 2): design → shop → a proposal on the shop
 * copy, three deep. Fork, compare, review and accept back work identically
 * at each depth, with one code path. Fails on round 10's code: no lineages,
 * and "Branches start from Main".
 */
import { asElementId, partDeltaDigest } from "@permitzip/bim-kernel";
import { acceptBack, reviewLineage } from "../src/lineages/acts";
import { lineageChain } from "../src/lineages/chain";
import { compareLineages, lineageDelta } from "../src/lineages/compare";
import { lineageStateDigest } from "../src/lineages/checkpoint";
import { Copies, level } from "./l11-fixtures";

function threeDeep(rootId = "design") {
  const c = new Copies(rootId, [level("L1", "Level 1"), level("L2", "Level 2", 3000), level("L3", "Level 3", 6000)]);
  c.edit(rootId, { set: [level("L1", "Level 1 (ground)")] }); // r1
  c.fork("shop", rootId, "shop"); // pinned at 1
  c.edit("shop", { set: [level("L2", "Level 2 (shop)", 3050)] }); // r2 on shop's line
  c.edit(rootId, { set: [level("L3", "Level 3 (roof)", 6000)] }); // r2 on design's line
  c.fork("prop", "shop", "proposal"); // pinned at 2 of shop's line
  c.edit("prop", { set: [level("L4", "Mezzanine", 1500)] }); // r3 on prop's line
  return c;
}

describe("l11-copy-of-copy", () => {
  it("forks a copy of a copy as a pin of its parent's line", () => {
    const c = threeDeep();
    expect(lineageChain(c.lookup, "prop").map((l) => [l.lineage.id, l.pinnedAt])).toEqual([
      ["prop", null],
      ["shop", 2],
      ["design", 1],
    ]);
    // The proposal starts with the shop's level 2 and the design's level 1 as of the shop's fork, not the design's later roof.
    const prop = c.head("prop");
    expect(prop.elements["L2"]).toMatchObject({ name: "Level 2 (shop)" });
    expect(prop.elements["L1"]).toMatchObject({ name: "Level 1 (ground)" });
    expect(prop.elements["L3"]).toMatchObject({ name: "Level 3" });
    // Its line reads the shop's own changeset and its own, nothing of the design's after the shop's fork.
    expect(c.line("prop", 1).map((cs) => cs.revision)).toEqual([2, 3]);
  });

  it("compares at every depth against the nearest common ancestor", () => {
    const c = threeDeep();
    const shopVsProp = compareLineages(c.lookup, c.side("shop", 2), c.side("prop", 2));
    expect(shopVsProp.ancestor).toEqual({ lineageId: "shop", revision: 2 });
    expect(shopVsProp.differences.map((d) => [d.recordId, d.change, d.changedOn])).toEqual([["L4", "added", "b"]]);

    const designVsProp = compareLineages(c.lookup, c.side("design", 1), c.side("prop", 1));
    expect(designVsProp.ancestor).toEqual({ lineageId: "design", revision: 1 });
    expect(designVsProp.differences.map((d) => [d.recordId, d.change, d.changedOn])).toEqual([
      ["L2", "changed", "b"],
      ["L3", "changed", "a"],
      ["L4", "added", "b"],
    ]);
  });

  it("reviews against the parent or the grandparent; the delta is the line since that ancestor", () => {
    const c = threeDeep();
    const toShop = lineageDelta(c.lookup, c.side("prop", 2));
    expect(toShop.anchor).toEqual({ lineageId: "shop", revision: 2 });
    expect(toShop.changedIds).toEqual(["L4"]);
    const toDesign = lineageDelta(c.lookup, c.side("prop", 1), "design");
    expect(toDesign.anchor).toEqual({ lineageId: "design", revision: 1 });
    expect(toDesign.changedIds).toEqual(["L2", "L4"]);
    expect(toDesign.deltaDigest).toBe(partDeltaDigest({ elementIds: ["L2", "L4"].map(asElementId) }, 1, (id) => c.head("prop").elements[id] ?? null));

    for (const [to, since, delta] of [[undefined, 2, toShop], ["design", 1, toDesign]] as const) {
      const { act } = reviewLineage({ lookup: c.lookup, child: c.side("prop", since), to, outcome: "approved_as_noted", reason: "Mezzanine height to be confirmed", deltaDigest: delta.deltaDigest });
      expect(act).toMatchObject({ kind: "review", lineageId: "prop", to: delta.anchor.lineageId, deltaDigest: delta.deltaDigest, outcome: "approved_as_noted" });
    }
  });

  it("accepts back to the parent and to the grandparent with the same code", () => {
    const c = threeDeep();
    const shopBefore = lineageStateDigest(c.head("shop"));
    const toShop = acceptBack({ lookup: c.lookup, child: c.side("prop", 2), target: c.side("shop", 2), recordIds: ["L4"] });
    expect(toShop.ok).toBe(true);
    if (!toShop.ok) return;
    c.commit("shop", toShop.landing);
    expect(c.head("shop").elements["L4"]).toMatchObject({ name: "Mezzanine" });
    expect(lineageStateDigest(c.head("shop"))).not.toBe(shopBefore);

    const toDesign = acceptBack({ lookup: c.lookup, child: c.side("prop", 1), target: c.side("design", 1), recordIds: ["L2", "L4"] });
    expect(toDesign.ok && toDesign.act).toMatchObject({ kind: "accept_back", from: "prop", to: "design", recordIds: ["L2", "L4"] });
    if (!toDesign.ok) return;
    c.commit("design", toDesign.landing);
    expect(c.head("design").elements["L2"]).toMatchObject({ name: "Level 2 (shop)", elevationMm: 3050 });
    expect(c.head("design").elements["L3"]).toMatchObject({ name: "Level 3 (roof)" });
  });

  it("gives the same answers when the first lineage is called main", () => {
    const a = threeDeep("design");
    const b = threeDeep("main");
    const strip = (r: ReturnType<typeof compareLineages>) => r.differences.map((d) => [d.recordId, d.change, d.changedOn, d.fields]);
    expect(strip(compareLineages(b.lookup, b.side("main", 1), b.side("prop", 1)))).toEqual(strip(compareLineages(a.lookup, a.side("design", 1), a.side("prop", 1))));
  });
});
