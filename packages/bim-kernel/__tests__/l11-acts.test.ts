/**
 * @jest-environment node
 *
 * Round 11 L11, the acts across copies:
 * - l11-act-to-any-ancestor: review, accept back and merge target the
 *   parent or any ancestor; anything else is refused in words;
 * - l11-review-leaves-parent: a review lands nothing (the parent's state
 *   digest is unchanged) and is refused for a delta the reviewer wasn't shown;
 * - l11-accept-back-cites-digest: an accept back names the child's delta
 *   digest over the chosen records and is a signed chain event.
 * Fails on round 10's code: none of these acts exists.
 */
import { asElementId, partDeltaDigest, signoffFields, signoffRecordHash, verifySignoffChain, SIGNOFF_GENESIS, type SignoffRecord } from "@permitzip/bim-kernel";
import { acceptBack, LINEAGE_SIGNOFF_KINDS, mergeAnchor, readLineageActPayload, reviewLineage, writeLineageActPayload } from "../src/lineages/acts";
import { ancestorAnchor } from "../src/lineages/chain";
import { lineageDelta } from "../src/lineages/compare";
import { lineageStateDigest } from "../src/lineages/checkpoint";
import { LineageError } from "../src/lineages/types";
import { Copies, AVERY, level } from "./l11-fixtures";

function family() {
  const c = new Copies("design", [level("L1", "Level 1"), level("L2", "Level 2", 3000)]);
  c.fork("coord", "design", "coordination");
  c.edit("coord", { set: [level("L2", "Level 2", 3020)] }); // r1
  c.fork("sub", "coord", "proposal"); // pinned at 1
  c.edit("sub", { set: [level("L7", "Plant deck", 4500)] }); // r2
  c.fork("opsrec", "design", "operations");
  c.edit("opsrec", { set: [level("L1", "Level 1 as run")] });
  return c;
}

describe("l11-act-to-any-ancestor", () => {
  it("anchors an act at the revision the chain pins its target", () => {
    const c = family();
    expect(ancestorAnchor(c.lookup, "sub")).toEqual({ lineageId: "coord", revision: 1 });
    expect(ancestorAnchor(c.lookup, "sub", "design")).toEqual({ lineageId: "design", revision: 0 });
    expect(mergeAnchor(c.lookup, "sub", "design")).toEqual({ lineageId: "design", revision: 0 });
  });

  it("refuses a target that isn't an ancestor, and a sibling, in words", () => {
    const c = family();
    expect(() => ancestorAnchor(c.lookup, "coord", "sub")).toThrow(new LineageError(`"sub" isn't a copy "coord" came from, so nothing can go back to it from there.`));
    expect(() => acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("opsrec", 0), recordIds: ["L7"] })).toThrow(LineageError);
    expect(() => ancestorAnchor(c.lookup, "design")).toThrow(LineageError);
  });

  it("follows the copy's return policy: an operations record sends nothing back", () => {
    const c = family();
    const delta = lineageDelta(c.lookup, c.side("opsrec", 0));
    expect(() => reviewLineage({ lookup: c.lookup, child: c.side("opsrec", 0), outcome: "approved", deltaDigest: delta.deltaDigest })).toThrow("opsrec is a copy whose changes never go back, so it can't be reviewed.");
    expect(() => acceptBack({ lookup: c.lookup, child: c.side("opsrec", 0), target: c.side("design", 0), recordIds: ["L1"] })).toThrow(LineageError);
    expect(() => mergeAnchor(c.lookup, "coord")).toThrow("coord is a copy whose changes only go back by review, so it can't be merged.");
  });

  it("lands a grandchild's record on the first lineage, and refuses one it didn't change", () => {
    const c = family();
    expect(() => acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L1"] })).toThrow("L1 wasn't changed on this copy since it started, so there is nothing to accept back for it.");
    const r = acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L2", "L7"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.landing.ok && [...r.landing.changedIds].sort()).toEqual(["L2", "L7"]);
  });

  it("reports a record both sides changed differently as a conflict and lands nothing", () => {
    const c = family();
    c.edit("design", { set: [level("L2", "Level 2", 2990)] });
    const r = acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L2"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflicts.map((x) => x.elementId)).toEqual(["L2"]);
  });
});

describe("l11-review-leaves-parent", () => {
  it("records an outcome without changing the parent", () => {
    const c = family();
    const before = lineageStateDigest(c.head("coord"));
    const headBefore = c.head("coord");
    const delta = lineageDelta(c.lookup, c.side("sub", 1));
    const { act, anchor } = reviewLineage({ lookup: c.lookup, child: c.side("sub", 1), outcome: "revise_and_resubmit", reason: "Deck clashes with the roof beam", deltaDigest: delta.deltaDigest });
    expect(act).toMatchObject({ kind: "review", lineageId: "sub", to: "coord", outcome: "revise_and_resubmit" });
    expect(anchor).toEqual({ lineageId: "coord", revision: 1 });
    expect(c.head("coord")).toBe(headBefore);
    expect(lineageStateDigest(c.head("coord"))).toBe(before);
  });

  it("refuses a review of a delta the reviewer wasn't shown", () => {
    const c = family();
    const shown = lineageDelta(c.lookup, c.side("sub", 1)).deltaDigest;
    c.edit("sub", { set: [level("L7", "Plant deck", 4600)] });
    expect(() => reviewLineage({ lookup: c.lookup, child: c.side("sub", 1), outcome: "approved", deltaDigest: shown })).toThrow("This copy changed after its changes were shown. Look at the differences again, then record the review.");
  });
});

describe("l11-accept-back-cites-digest", () => {
  it("names the child's delta digest over the chosen records at the anchor revision", () => {
    const c = family();
    const r = acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L7", "L2"] });
    if (!r.ok) throw new Error("expected a landing");
    const expected = partDeltaDigest({ elementIds: ["L2", "L7"].map(asElementId) }, 0, (id) => c.head("sub").elements[id] ?? null);
    expect(r.act).toEqual({ kind: "accept_back", from: "sub", to: "design", deltaDigest: expected, recordIds: ["L2", "L7"] });
    expect(() => acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L2"], deltaDigest: expected })).toThrow(LineageError);
  });

  it("is a sign-off chain event whose payload reads back and hashes", () => {
    const c = family();
    const r = acceptBack({ lookup: c.lookup, child: c.side("sub", 0), target: c.side("design", 0), recordIds: ["L7"] });
    if (!r.ok) throw new Error("expected a landing");
    const delta = lineageDelta(c.lookup, c.side("sub", 1));
    const review = reviewLineage({ lookup: c.lookup, child: c.side("sub", 1), outcome: "approved", deltaDigest: delta.deltaDigest });
    const events = [
      { kind: LINEAGE_SIGNOFF_KINDS.review, payload: writeLineageActPayload(review.act, { by: AVERY, at: "2026-11-02T03:00:00Z", anchor: review.anchor }), subject: "sub" },
      { kind: LINEAGE_SIGNOFF_KINDS.accept_back, payload: writeLineageActPayload(r.act, { by: AVERY, at: "2026-11-02T04:00:00Z", anchor: r.anchor }), subject: "sub" },
    ];
    const records: SignoffRecord[] = [];
    let prev = SIGNOFF_GENESIS;
    events.forEach((e, i) => {
      const base = { seq: i + 1, projectId: "p", baseModelId: "m", recordKind: e.kind, subjectId: e.subject, actorUserId: "u-avery", payload: e.payload };
      const recordHash = signoffRecordHash(prev, signoffFields(base));
      records.push({ ...base, prevHash: prev, recordHash });
      prev = recordHash;
    });
    expect(verifySignoffChain(records)).toMatchObject({ ok: true, count: 2 });
    const back = readLineageActPayload(LINEAGE_SIGNOFF_KINDS.accept_back, JSON.parse(JSON.stringify(records[1]?.payload)));
    expect(back.ok && back.act).toEqual(r.act);
    expect(back.ok && back.anchor).toEqual({ lineageId: "design", revision: 0 });
    const reviewed = readLineageActPayload(LINEAGE_SIGNOFF_KINDS.review, JSON.parse(JSON.stringify(records[0]?.payload)));
    expect(reviewed.ok && reviewed.act).toEqual(review.act);
    expect(readLineageActPayload("lineage_teleported", records[0]?.payload).ok).toBe(false);
  });
});
