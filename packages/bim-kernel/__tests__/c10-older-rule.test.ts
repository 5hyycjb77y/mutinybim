/**
 * @jest-environment node
 *
 * Round 10 lane C10: a code pack corrects a rule (same edition, new
 * `ruleVersion`). The approval still verifies (its pin is unchanged) and reads
 * "Checked against an earlier version of this rule (corrected Nov 4)". A
 * changed local amendment flags and names the amendment; a changed adopting
 * instrument flags; a rule the pack no longer supplies says so. Fails on
 * round 9: rules had no version and nothing compared a pin.
 */
import { contextStanding, readRuleRecord } from "@permitzip/bim-kernel";
import { IBC_2021, IECC_2021, VA, pinned, rule } from "./fixtures/c10-rules";

const v3 = rule({ ruleId: "ibc-903-2", section: "903.2", ruleVersion: "3", jurisdictionId: VA });

describe("c10-older-rule", () => {
  it("same rule, same version: current, and the line names code, edition, section, adoption and version", () => {
    const s = contextStanding(pinned("r1", "rao", [v3]).context, { codesOfRecord: [IBC_2021, IECC_2021], rules: [v3] });
    expect(s).toEqual({ state: "current", words: "Checked against IBC 2021 §903.2 (Virginia adoption), rule v3", carried: [] });
  });

  it("a corrected rule (v3 → v4, corrected Nov 4) reads \"checked against an earlier version of this rule\"", () => {
    const v4 = rule({ ruleId: "ibc-903-2", section: "903.2", ruleVersion: "4", correctedAt: "2026-11-04", jurisdictionId: VA });
    const s = contextStanding(pinned("r1", "rao", [v3]).context, { codesOfRecord: [IBC_2021], rules: [v4] });
    expect(s.state).toBe("older");
    if (s.state !== "older") return;
    expect(s.words).toBe("Checked against an earlier version of this rule (corrected Nov 4)");
    expect(s.items).toEqual([expect.objectContaining({ why: "rule_version", words: "Checked against an earlier version of this rule (corrected Nov 4): IBC 2021 §903.2, v3 → v4" })]);
    expect(s.sourceVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("an unversioned rule reads as v1; versioning it later flags only when the number moves", () => {
    const unversioned = rule({ ruleId: "ibc-1004", section: "1004.5" });
    const ctx = pinned("r1", "rao", [unversioned]).context;
    expect(ctx?.rules[0]?.ruleVersion).toBe("1");
    expect(contextStanding(ctx, { codesOfRecord: [IBC_2021], rules: [rule({ ruleId: "ibc-1004", section: "1004.5", ruleVersion: "1" })] }).state).toBe("current");
    expect(contextStanding(ctx, { codesOfRecord: [IBC_2021], rules: [rule({ ruleId: "ibc-1004", section: "1004.5", ruleVersion: "2" })] }).state).toBe("older");
  });

  it("a changed local amendment flags with no edition change, and names the amendment", () => {
    const amended = rule({ ruleId: "ibc-903-2", section: "903.2", ruleVersion: "3", amendment: { id: "VA-903.2", version: "1" } });
    const ctx = pinned("r1", "rao", [amended]).context;
    const s = contextStanding(ctx, { codesOfRecord: [IBC_2021], rules: [{ ...amended, citation: { ...amended.citation, amendment: { id: "VA-903.2", version: "2" } } }] });
    expect(s.state === "older" && s.items[0]).toEqual(expect.objectContaining({ why: "amendment", words: "Checked against IBC 2021 §903.2 before amendment VA-903.2 changed (now v2)" }));
  });

  it("a changed adopting instrument (Virginia USBC 2021 → a revised adoption, same model edition) flags", () => {
    const adopted = rule({ ruleId: "ibc-903-2", section: "903.2", adoptedAs: "Virginia USBC 2021" });
    const ctx = pinned("r1", "rao", [adopted]).context;
    const s = contextStanding(ctx, { codesOfRecord: [{ ...IBC_2021, adoptedAs: "Virginia USBC 2021 (2025 revision)" }], rules: [adopted] });
    expect(s.state === "older" && s.items[0]?.why).toBe("adoption");
  });

  it("a rule its pack no longer supplies says so; a pack that isn't loaded never flags", () => {
    const ctx = pinned("r1", "rao", [v3]).context;
    const other = rule({ ruleId: "ibc-1004", section: "1004.5" });
    const s = contextStanding(ctx, { codesOfRecord: [IBC_2021], rules: [other] });
    expect(s.state === "older" && s.items[0]?.words).toBe("The rule this was checked against (IBC 2021 §903.2) is no longer in its code pack");
    expect(contextStanding(ctx, { codesOfRecord: [IBC_2021], rules: [rule({ ruleId: "x", section: "1", provider: "another.pack" })] }).state).toBe("current");
  });

  it("a code pack supplies rule versions through the existing rule row; a malformed version is refused", () => {
    expect(readRuleRecord(v3)).toMatchObject({ ok: true });
    expect(readRuleRecord({ ...v3, ruleVersion: 3 })).toMatchObject({ ok: false });
    expect(readRuleRecord({ ...v3, carriedForward: [{ fromSection: "903.2" }] })).toMatchObject({ ok: false });
  });
});
