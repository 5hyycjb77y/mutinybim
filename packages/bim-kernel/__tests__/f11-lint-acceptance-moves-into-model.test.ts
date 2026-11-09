/**
 * @jest-environment node
 *
 * Round 11 lane F11 (product owner answer 4): old clash acceptances move into the
 * model. `dispositionFromLintAcceptance` maps one host acceptance row (per
 * model, as a host stores it) to an `accepted_known` disposition on Main with
 * the person's reason and time, naming the ledger id of that lint finding;
 * a retracted row is refused (the finding stays open); a malformed one is
 * refused in words. Pure: PL11's job reads, maps and writes.
 *
 * Fails on round 10's code: the function doesn't exist.
 */
import { dispositionFromLintAcceptance } from "../src/findings/lint-acceptance";
import { dispositionStanding, lintFindingRef, type DispositionIndex } from "../src/findings/api";

const ROW = { finding_id: "clash-hard:ra-s1|sa-s1", rule: "clash-hard", reason: "Known; the contractor reroutes it in the field.", accepted_by: "7c2d0e1a-0000-4000-8000-00000000a001", accepted_at: "2026-09-14 13:05:00+00", revoked_at: null };

describe("f11-lint-acceptance-moves-into-model", () => {
  it("one row is one accepted_known decision on Main against the lint finding's ledger id", () => {
    const read = dispositionFromLintAcceptance(ROW, { provider: "host", displayName: "J. Rao" });
    expect(read).toEqual({
      ok: true,
      value: { findingId: "lint_rule:clash-hard:ra-s1|sa-s1", sourceVersion: "1", action: "accepted_known", reason: ROW.reason, by: { provider: "host", subject: ROW.accepted_by, kind: "person", displayName: "J. Rao" }, at: "2026-09-14T13:05:00.000Z", scope: { lineageId: "main" } },
    });
    if (!read.ok) return;
    const finding = lintFindingRef({ id: ROW.finding_id, rule: "clash-hard", severity: "error", elementIds: ["ra-s1", "sa-s1"], message: "Supply passes into return" }, { revision: 9 }, "main");
    const index: DispositionIndex = { byFinding: new Map([[read.value.findingId, [{ disposition: read.value, recordId: "fd-1", recordedRevision: 9 }]]]), count: 1, unreadable: 0 };
    expect(dispositionStanding(finding, index).state).toBe("disposed");
  });

  it("the store's camelCase rows read the same", () => {
    const camel = dispositionFromLintAcceptance({ findingId: ROW.finding_id, rule: ROW.rule, reason: ROW.reason, acceptedBy: ROW.accepted_by, acceptedAt: "2026-09-14T13:05:00.000Z" });
    expect(camel).toMatchObject({ ok: true, value: { findingId: "lint_rule:clash-hard:ra-s1|sa-s1", by: { provider: "unsigned" } } });
  });

  it("a retracted row stays open; a row missing a part is refused in words", () => {
    expect(dispositionFromLintAcceptance({ ...ROW, revoked_at: "2026-10-01T00:00:00Z" })).toEqual({ ok: false, reason: "this acceptance was retracted; the finding is open" });
    expect(dispositionFromLintAcceptance({ ...ROW, reason: "" })).toEqual({ ok: false, reason: "an acceptance names its finding, reason, who accepted it and when" });
    expect(dispositionFromLintAcceptance({ ...ROW, accepted_at: "yesterday" })).toEqual({ ok: false, reason: 'the acceptance time "yesterday" isn\'t a date' });
    expect(dispositionFromLintAcceptance("row")).toEqual({ ok: false, reason: "not an acceptance row" });
  });
});
