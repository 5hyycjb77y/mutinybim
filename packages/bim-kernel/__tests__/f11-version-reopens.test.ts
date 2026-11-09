/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): a source version bump re-opens a decision the way
 * C10 marks "checked against an older rule". The decision stays in the model
 * and reads "Accepted against an earlier version of this check"; the finding
 * needs someone again. A requirement override stored before versions were
 * recorded holds against whatever version is in force.
 *
 * Fails on round 10's code: no standing, no source version on a finding.
 */
import { MAIN_LINEAGE } from "../src/findings";
import { dispositionStanding, lintFindingRef, standingIsOpen, UNVERSIONED, type DispositionIndex } from "../src/findings/api";

const RAO = { provider: "test.identity", subject: "user-rao", kind: "person" as const, displayName: "J. Rao" };
const clash = { id: "clash-hard:ra-s1|sa-s1", rule: "clash-hard", severity: "error", elementIds: ["ra-s1", "sa-s1"], message: "Supply passes into return" } as const;

function index(sourceVersion: string, findingId = "lint_rule:clash-hard:ra-s1|sa-s1"): DispositionIndex {
  const d = { findingId, sourceVersion, action: "accepted_known", reason: "Known clash; the contractor reroutes in the field.", by: RAO, at: "2026-11-02T15:00:00.000Z", scope: { lineageId: MAIN_LINEAGE } };
  return { byFinding: new Map([[findingId, [{ disposition: d, recordId: "fd-1", recordedRevision: 3 }]]]), count: 1, unreadable: 0 };
}

describe("f11-version-reopens", () => {
  it("accepted at the rule's version: disposed; the rule moves to version 2: re-opened, the decision kept and named", () => {
    const v1 = lintFindingRef(clash, { revision: 5 }, "main");
    const v2 = lintFindingRef({ ...clash, ruleVersion: "2" }, { revision: 6 }, "main");
    expect(v1.id).toBe(v2.id);
    const at1 = dispositionStanding(v1, index("1"));
    expect(at1.state).toBe("disposed");
    expect(standingIsOpen(at1)).toBe(false);
    const at2 = dispositionStanding(v2, index("1"));
    expect(at2).toMatchObject({ state: "earlier_version", words: "Accepted against an earlier version of this check", disposition: { sourceVersion: "1", reason: expect.stringContaining("reroutes") } });
    expect(standingIsOpen(at2)).toBe(true);
    expect(dispositionStanding(v2, index("2")).state).toBe("disposed");
  });

  it("a decision stored with no version (a requirement override from before round 11) holds against the version in force", () => {
    const f = { id: "requirement:zt:head:fp.head_count:S104", source: { kind: "requirement", id: "zt:head", version: "7" } };
    expect(dispositionStanding(f, index(UNVERSIONED, f.id)).state).toBe("disposed");
  });
});
