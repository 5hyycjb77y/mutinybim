/**
 * @jest-environment node
 *
 * Round 10 lane C10 (product decision, answer 4): a new issue of a sheet carrying an
 * approval that was checked against an older rule needs that approval's
 * signer to re-check and sign, or to record an override with a reason.
 * Only the signer may override; several signers each act for themselves; an
 * approval with no checking context recorded never blocks; a signer who has
 * left can't act, so someone signs a new approval. Fails on round 9: there
 * was no issue-time check, no disposition and no standing.
 */
import {
  buildCheckingContext,
  contextStanding,
  overrideRefusal,
  readFindingDisposition,
  relianceFindingId,
  writeFindingDisposition,
  type AuthorRef,
  type CodeOfRecord,
  type ContextStanding,
  type FindingDisposition,
  type RuleRecord,
} from "@permitzip/bim-kernel";
import { reissueCheck, type SheetApproval } from "../src/set-issue";

const VA = { country: "US", subdivision: "US-VA" } as const;
const IBC_2021: CodeOfRecord = { discipline: "building", instrument: "IBC", edition: "2021", jurisdiction: VA };
const IBC_2024: CodeOfRecord = { discipline: "building", instrument: "IBC", edition: "2024", jurisdiction: VA };

function rule(ruleId: string, edition: string, section: string): RuleRecord {
  return { ruleId, provider: "test.codes", citation: { instrument: "IBC", edition, section }, title: section, summary: "A test requirement.", discipline: "architecture", applies: {}, reads: [], produces: [], verification: { status: "verified" } };
}

const RAO: AuthorRef = { provider: "host", subject: "user-rao", kind: "person", displayName: "J. Rao" };
const LEE: AuthorRef = { provider: "host", subject: "user-lee", kind: "person", displayName: "P. Lee" };
const SHEETS = [
  { id: "sheet-a101", number: "A-101" },
  { id: "sheet-g001", number: "G-001" },
] as never;

const ctx = buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021], rules: [rule("ibc21-903-2", "2021", "903.2")] });
const now = { codesOfRecord: [IBC_2024], rules: [rule("ibc24-903-2", "2024", "903.2")] };
const older = contextStanding(ctx, now);

function approval(recordId: string, who: AuthorRef, standing: ContextStanding, extra: Partial<SheetApproval> = {}): SheetApproval {
  return { sheetId: "sheet-a101", recordId, signer: who.subject, signerName: who.displayName ?? who.subject, standing, ...extra };
}

function override(recordId: string, by: AuthorRef, sourceVersion: string): FindingDisposition {
  const back = readFindingDisposition(writeFindingDisposition({ findingId: relianceFindingId(recordId), sourceVersion, action: "override", reason: "Same sprinkler threshold in both editions; checked by hand.", by, at: "2026-11-04T15:00:00Z", scope: { lineageId: "main" } }));
  if (!back.ok) throw new Error(back.reason);
  return back.value;
}

describe("c10 reissue check", () => {
  it("c10-reissue-blocked-then-reconciled: blocked while older; a re-check (a new current approval) clears it", () => {
    const blocked = reissueCheck(SHEETS, [approval("apr-1", RAO, older)]);
    expect(blocked.ok).toBe(false);
    expect(blocked.words).toBe("Issue blocked: 1 approval was checked against an older rule");
    expect(blocked.blocked[0]).toMatchObject({ sheetNumber: "A-101", signerName: "J. Rao", choices: ["recheck", "override"], findingId: "reliance:apr-1" });
    const recheckCtx = buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2024], rules: now.rules });
    expect(reissueCheck(SHEETS, [approval("apr-2", RAO, contextStanding(recheckCtx, now))]).ok).toBe(true);
  });

  it("an override by the signer, at this source version, clears it; at another version (a later change) it doesn't", () => {
    if (older.state !== "older") throw new Error("expected older");
    expect(reissueCheck(SHEETS, [approval("apr-1", RAO, older, { dispositions: [override("apr-1", RAO, older.sourceVersion)] })]).ok).toBe(true);
    expect(reissueCheck(SHEETS, [approval("apr-1", RAO, older, { dispositions: [override("apr-1", RAO, "sha256:an-earlier-change")] })]).ok).toBe(false);
  });

  it("c10-override-only-by-signer: someone else's override never clears it, and is refused before it is written", () => {
    if (older.state !== "older") throw new Error("expected older");
    expect(reissueCheck(SHEETS, [approval("apr-1", RAO, older, { dispositions: [override("apr-1", LEE, older.sourceVersion)] })]).ok).toBe(false);
    expect(overrideRefusal({ signer: RAO, by: LEE, reason: "I reviewed it myself today.", signerName: "J. Rao" })).toBe("Only J. Rao can override it. To take it on yourself, re-check it and sign your own approval.");
    expect(overrideRefusal({ signer: RAO, by: RAO, reason: "ok" })).toBe("Say why in a sentence; reviewers will read it.");
    expect(overrideRefusal({ signer: RAO, by: RAO, reason: "Same threshold in both editions." })).toBeNull();
    expect(overrideRefusal({ signer: RAO, by: { provider: "host", subject: "run-1", kind: "agent", onBehalfOf: RAO }, reason: "Same threshold in both editions." })).toBe("Only a person can override this, not an agent.");
  });

  it("c10-several-signers: each affected signer blocks on their own and must act for themselves", () => {
    if (older.state !== "older") throw new Error("expected older");
    const both = [approval("apr-m", RAO, older), approval("apr-e", LEE, older)];
    expect(reissueCheck(SHEETS, both).blocked.map((b) => b.signerName)).toEqual(["J. Rao", "P. Lee"]);
    const oneDone = [approval("apr-m", RAO, older, { dispositions: [override("apr-m", RAO, older.sourceVersion)] }), approval("apr-e", LEE, older)];
    const after = reissueCheck(SHEETS, oneDone);
    expect(after.blocked.map((b) => b.signerName)).toEqual(["P. Lee"]);
    expect(after.words).toBe("Issue blocked: 1 approval was checked against an older rule");
  });

  it("c10-no-context-does-not-block: approvals from before C10 read \"not recorded\" and never block", () => {
    const out = reissueCheck(SHEETS, [approval("apr-old", RAO, contextStanding(null, now)), approval("apr-old-2", LEE, contextStanding(null, now))]);
    expect(out).toEqual({ ok: true, blocked: [], words: null, notRecorded: 2 });
  });

  it("a signer who left or whose licence lapsed can't act: the only choice is a new approval by someone else", () => {
    expect(reissueCheck(SHEETS, [approval("apr-1", RAO, older, { signerCanAct: false })]).blocked[0]?.choices).toEqual(["new_approval"]);
  });

  it("sheets relying on no rule, and approvals for sheets not in the set, don't block", () => {
    const cover = contextStanding(buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021], rules: [] }), now);
    expect(reissueCheck(SHEETS, [approval("apr-c", RAO, cover, { sheetId: "sheet-g001" }), approval("apr-x", RAO, older, { sheetId: "sheet-elsewhere" })]).ok).toBe(true);
  });
});
