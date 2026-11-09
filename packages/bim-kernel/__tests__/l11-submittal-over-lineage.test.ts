/**
 * @jest-environment node
 *
 * Round 11 L11: a submittal can transmit a `submittal` copy's delta
 * (`lineageId` + `deltaDigest`); a divergence is a reviewed difference that
 * was not accepted back; old submittals read unchanged. Fails on round 10's
 * code: `add_submittal` refuses the fields (strict schema) and there is no
 * copy to transmit.
 */
import { commandSchema, executeCommand, submittalsIn, withUpgradePolicy, type Actor, type Command, type ModelState } from "../src";
import { lineageDelta, compareLineages } from "../src/lineages/compare";
import { LINEAGES_REVIEW_FEATURE } from "../src/lineages/types";
import { lineageDivergences, submittalLineage, submittalsForLineage } from "../src/submittals/lineage";
import { readSubmittalBody } from "../src/submittals/records";
import { floor } from "./g7-fixtures";
import { Copies, level } from "./l11-fixtures";

const GC: Actor = { id: "user-gc", name: "Contractor PM", kind: "human" };

function run(m: ModelState, command: Command, policy: (f: string) => boolean = () => true) {
  return withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: GC.id, actor: GC, at: "2026-11-03T12:00:00.000Z" }));
}

function submittalCopy() {
  const c = new Copies("design", [level("L1", "Level 1"), level("L2", "Level 2", 3000)]);
  c.fork("sub-1", "design", "submittal");
  c.edit("sub-1", { set: [level("L2", "Level 2", 3050)] });
  c.edit("sub-1", { set: [level("L6", "Equipment deck", 4200)] });
  return c;
}

describe("l11-submittal-over-lineage", () => {
  it("stores the copy and delta a submittal transmits, and reads it back", () => {
    const c = submittalCopy();
    const delta = lineageDelta(c.lookup, c.side("sub-1", 0));
    const m0 = floor("l11-sub");
    const r = run(m0, { type: "add_submittal", submittalId: "SUB-7", title: "Deck shop drawings", offeredFor: { elementIds: ["W-13"] }, items: [{ id: "1", label: "Shop drawings" }], lineageId: "sub-1", deltaDigest: delta.deltaDigest } as Command);
    if (!r.ok) throw new Error(r.error.message);
    const s = submittalsIn(r.model.elements)[0];
    if (!s) throw new Error("no submittal");
    expect(submittalLineage(s)).toEqual({ lineageId: "sub-1", deltaDigest: delta.deltaDigest });
    expect(submittalsForLineage(r.model.elements, "sub-1").map((x) => x.id)).toEqual(["SUB-7"]);
  });

  it("refuses one half of the pair, and refuses the pair on a server that doesn't store copies", () => {
    const m0 = floor("l11-sub2");
    const base = { type: "add_submittal", submittalId: "SUB-8", title: "Deck", offeredFor: { elementIds: ["W-13"] }, items: [{ id: "1", label: "Shop drawings" }] };
    const half = run(m0, { ...base, lineageId: "sub-1" } as Command);
    expect(half.ok).toBe(false);
    const older = run(m0, { ...base, lineageId: "sub-1", deltaDigest: "a".repeat(64) } as Command, (f) => f !== LINEAGES_REVIEW_FEATURE);
    expect(!older.ok && older.error.message).toMatch(/older version that doesn't store copies/);
    expect(run(m0, base as Command, (f) => f !== LINEAGES_REVIEW_FEATURE).ok).toBe(true);
  });

  it("reads an old submittal exactly as before: no copy", () => {
    const old = { title: "Partition product data", revision: "0", offeredFor: { typeIds: ["WT-1"] }, review: { state: "pending" }, items: [{ id: "1", label: "Product data" }] };
    const read = readSubmittalBody(old);
    expect(read.ok && read.value).toBe(old);
    expect(readSubmittalBody({ ...old, lineageId: "sub-1" }).ok).toBe(false);
  });

  it("a divergence is an approved difference neither accepted back nor matched in the design", () => {
    const c = submittalCopy();
    const { differences } = compareLineages(c.lookup, c.side("design", 0), c.side("sub-1", 0));
    expect(lineageDivergences(differences, "approved_as_noted").map((d) => d.recordId)).toEqual(["L2", "L6"]);
    expect(lineageDivergences(differences, "revise_and_resubmit")).toEqual([]);
    const l2 = differences.find((d) => d.recordId === "L2");
    if (!l2) throw new Error("no L2");
    c.edit("design", { set: [level("L2", "Level 2", 3050)], cites: [l2.id] });
    const after = compareLineages(c.lookup, c.side("design", 0), c.side("sub-1", 0)).differences;
    expect(lineageDivergences(after, "approved").map((d) => d.recordId)).toEqual(["L6"]);
  });
});
