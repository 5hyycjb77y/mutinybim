/**
 * @jest-environment node
 *
 * Round 11 L11: the lineage bundle v1 reader and the checkpoint shape (no
 * writer this round). The fixture is a shop copy of a design: base anchor,
 * ancestry, two changesets and a signed review. Fails on round 10's code:
 * there is no bundle format.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readLineageBundle } from "../src/lineages/bundle";
import { lineageCheckpoint, lineageStateDigest, readLineageCheckpoint } from "../src/lineages/checkpoint";
import { readLineageActPayload } from "../src/lineages/acts";
import { Copies, level } from "./l11-fixtures";

const FIXTURE: unknown = JSON.parse(readFileSync(path.join(__dirname, "fixtures/l11-lineage-bundle-v1.json"), "utf8"));

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>;
}

describe("l11-bundle-reader", () => {
  it("reads the v1 fixture: anchor, ancestry, line and signed review", () => {
    const read = readLineageBundle(FIXTURE);
    if (!read.ok) throw new Error(read.problems.join("; "));
    expect(read.value.base).toMatchObject({ modelId: "model-fixture", lineageId: "design", revision: 0 });
    expect(read.value.lineage).toMatchObject({ id: "shop", role: "shop", returnPolicy: "accept_back", parent: { lineageId: "design", revision: 0 } });
    expect(read.value.ancestry.map((l) => l.id)).toEqual(["design"]);
    expect(read.value.changesets.map((cs) => cs.revision)).toEqual([1, 2]);
    const review = read.value.signoffs[0];
    expect(review && readLineageActPayload(review.recordKind, review.payload)).toMatchObject({ ok: true, act: { kind: "review", lineageId: "shop", outcome: "approved_as_noted" } });
  });

  it("the base anchor's digest is the design's state at the fork", () => {
    const c = new Copies("design", [level("L1", "Level 1"), level("L2", "Level 2", 3000)]);
    const read = readLineageBundle(FIXTURE);
    expect(read.ok && read.value.base.stateDigest).toBe(lineageStateDigest(c.head("design")));
  });

  it("refuses a newer format in words, a gap in the line, a broken ancestry and a changed sign-off", () => {
    expect(readLineageBundle({ ...clone(), version: 2 })).toEqual({ ok: false, problems: ["this copy bundle is format 2, made by a newer release; update to import it"] });
    const gap = clone();
    (gap.changesets as Record<string, unknown>[]).splice(0, 1);
    expect(readLineageBundle(gap)).toMatchObject({ ok: false, problems: [expect.stringContaining("no gap")] });
    expect(readLineageBundle({ ...clone(), ancestry: [] })).toMatchObject({ ok: false, problems: [`the copy's ancestry doesn't reach the base copy "design"`] });
    const tampered = clone();
    const record = (tampered.signoffs as Record<string, Record<string, unknown>>[])[0];
    if (record?.payload) record.payload.outcome = "approved";
    expect(readLineageBundle(tampered)).toMatchObject({ ok: false, problems: [expect.stringContaining("was changed after it was recorded")] });
    expect(readLineageBundle({ format: "something.else" }).ok).toBe(false);
  });

  it("checkpoints name a state by digest and read tolerantly", () => {
    const c = new Copies("design", [level("L1", "Level 1")]);
    const cp = lineageCheckpoint("design", c.head("design"));
    expect(readLineageCheckpoint({ lineage_id: "design", revision: 0, state_digest: cp.stateDigest })).toEqual({ ok: true, value: cp });
    c.edit("design", { set: [level("L1", "Level 1 (G)")] });
    expect(lineageStateDigest(c.head("design"))).not.toBe(cp.stateDigest);
    expect(readLineageCheckpoint({ lineageId: "design", revision: 0, stateDigest: "nope" }).ok).toBe(false);
  });
});
