/**
 * @jest-environment node
 *
 * Round 10 lane C10 (the product owner's answer 4, CANDIDATES §3 edge cases): the
 * project's code of record moves from IBC 2021 to IBC 2024. Each person whose
 * approval relied on a changed rule hears it once (one notice per signer per
 * change, listing every rule), the record reads "Checked against an older
 * rule", and only reliant records are re-checked. Covers: carried forward,
 * a state adoption alone, partial adoption, undo, several signers, many rules
 * at once, a removed rule, different authorities, no rule relied on.
 * Fails on round 9: no code of record, no pin, nothing to compare.
 */
import {
  CheckingContextIndex,
  codeChangeCarry,
  codeChangeKey,
  codeChangeNotices,
  codeChangeWords,
  codeOfRecordChanges,
  contextStanding,
  type CodeOfRecord,
  type RuleRecord,
} from "@permitzip/bim-kernel";
import { IBC_2021, IBC_2024, IECC_2021, pinned, rule } from "./fixtures/c10-rules";

const r903 = rule({ ruleId: "ibc21-903-2", section: "903.2" });
const r1004 = rule({ ruleId: "ibc21-1004-5", section: "1004.5" });
const energy = rule({ ruleId: "iecc21-c402", instrument: "IECC", section: "C402.1" });
const rules2024: RuleRecord[] = [rule({ ruleId: "ibc24-903-2", edition: "2024", section: "903.2" }), rule({ ruleId: "ibc24-1004-5", edition: "2024", section: "1004.5" })];

describe("c10-edition-change", () => {
  it("2021 → 2024: the approval reads \"Checked against an older rule\"; one notice per signer, every rule listed", () => {
    const records = [pinned("a1", "rao", [r903, r1004], undefined, "J. Rao"), pinned("a2", "rao", [r903]), pinned("a3", "lee", [r1004])];
    const change = codeOfRecordChanges([IBC_2021, IECC_2021], [IBC_2024, IECC_2021]);
    expect(change).toHaveLength(1);
    const carry = codeChangeCarry(new CheckingContextIndex(records), { instruments: change.map((c) => c.instrument) }, { codesOfRecord: [IBC_2024, IECC_2021], rules: rules2024 });
    expect(carry.older.map((o) => o.record.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(carry.older[0]?.standing.words).toBe("Checked against an older rule");
    expect(carry.older.find((o) => o.record.id === "a1")?.standing.items.map((i) => i.words)).toEqual([
      "Checked against IBC 2021 §1004.5; the project now uses Virginia USBC 2024 (IBC 2024)",
      "Checked against IBC 2021 §903.2; the project now uses Virginia USBC 2024 (IBC 2024)",
    ]);
    expect(codeChangeNotices(carry)).toEqual([
      { signer: "lee", recordIds: ["a3"], rules: ["IBC 2021 §1004.5"] },
      { signer: "rao", signerName: "J. Rao", recordIds: ["a1", "a2"], rules: ["IBC 2021 §1004.5", "IBC 2021 §903.2"] },
    ]);
    const first = change[0];
    if (!first) throw new Error("no change");
    expect(codeChangeKey("site-9001", first)).toBe("site-9001:building:Virginia USBC 2021 (IBC 2021)->Virginia USBC 2024 (IBC 2024)");
    expect(codeChangeWords(first, 3)).toBe("The project now uses Virginia USBC 2024 (IBC 2024). 3 of your approvals were checked against Virginia USBC 2021 (IBC 2021).");
  });

  it("many changes at once: 40 changed rules on one approval give one notice, not 40", () => {
    const many = Array.from({ length: 40 }, (_, i) => rule({ ruleId: `r${i}`, section: `${1000 + i}.1` }));
    const carry = codeChangeCarry(new CheckingContextIndex([pinned("big", "rao", many)]), { instruments: ["IBC"] }, { codesOfRecord: [IBC_2024], rules: rules2024 });
    const notices = codeChangeNotices(carry);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.rules).toHaveLength(40);
  });

  it("carried forward: a pack declaring §903.2 unchanged into 2024 leaves that approval current, and says so", () => {
    const carried = rule({ ruleId: "ibc24-903-2", edition: "2024", section: "903.2", carriedForward: [{ fromEdition: "2021" }] });
    const s = contextStanding(pinned("a1", "rao", [r903]).context, { codesOfRecord: [IBC_2024], rules: [carried, ...rules2024.slice(1)] });
    expect(s).toEqual({ state: "current", words: "Checked against IBC 2021 §903.2, rule v1", carried: ["IBC 2021 §903.2 is carried forward unchanged into Virginia USBC 2024 (IBC 2024) (as §903.2)"] });
    const moved = rule({ ruleId: "ibc24-903-3", edition: "2024", section: "903.3", carriedForward: [{ fromEdition: "2021", fromSection: "903.2" }] });
    expect(contextStanding(pinned("a1", "rao", [r903]).context, { codesOfRecord: [IBC_2024], rules: [moved] }).state).toBe("current");
  });

  it("never inferred: the same section in 2024 without the pack's declaration still flags", () => {
    expect(contextStanding(pinned("a1", "rao", [r903]).context, { codesOfRecord: [IBC_2024], rules: rules2024 }).state).toBe("older");
  });

  it("a rule removed from the new edition says \"not in IBC 2024\"", () => {
    const gone = rule({ ruleId: "ibc21-3109", section: "3109.1" });
    const s = contextStanding(pinned("a1", "rao", [gone]).context, { codesOfRecord: [IBC_2024], rules: rules2024 });
    expect(s.state === "older" && s.items[0]?.words).toBe("The rule this was checked against is not in Virginia USBC 2024 (IBC 2024) (IBC 2021 §3109.1)");
  });

  it("c10-state-adoption-alone-no-bell: the state adopting 2024 while the project stays on 2021 (vesting) changes nothing", () => {
    const records = [pinned("a1", "rao", [r903])];
    // The project's code of record is unchanged; only the world's adoption moved (new rules exist for 2024).
    expect(codeOfRecordChanges([IBC_2021], [IBC_2021])).toEqual([]);
    const carry = codeChangeCarry(new CheckingContextIndex(records), { instruments: [] }, { codesOfRecord: [IBC_2021], rules: [r903, ...rules2024] });
    expect(carry).toEqual({ older: [], rechecked: 0 });
    expect(contextStanding(records[0]?.context ?? null, { codesOfRecord: [IBC_2021], rules: [r903, ...rules2024] }).state).toBe("current");
  });

  it("c10-partial-adoption-per-section: building moves to 2024, energy stays 2021: only building approvals flag", () => {
    const records = [pinned("bldg", "rao", [r903]), pinned("nrg", "lee", [energy])];
    const change = codeOfRecordChanges([IBC_2021, IECC_2021], [IBC_2024, IECC_2021]);
    const carry = codeChangeCarry(new CheckingContextIndex(records), { instruments: change.map((c) => c.instrument) }, { codesOfRecord: [IBC_2024, IECC_2021], rules: [...rules2024, energy] });
    expect(carry.older.map((o) => o.record.id)).toEqual(["bldg"]);
    expect(carry.rechecked).toBe(1);
  });

  it("c10-undo-clears: the code changed back clears the flag with no new notice (the undo touches no approval pinned to 2021)", () => {
    const records = [pinned("a1", "rao", [r903])];
    const idx = new CheckingContextIndex(records);
    const forward = codeChangeCarry(idx, { instruments: ["IBC"] }, { codesOfRecord: [IBC_2024], rules: rules2024 });
    expect(codeChangeNotices(forward)).toHaveLength(1);
    const back = codeChangeCarry(idx, { instruments: ["IBC"] }, { codesOfRecord: [IBC_2021], rules: [r903] });
    expect(back.older).toEqual([]);
    expect(codeChangeNotices(back)).toEqual([]);
    const [undo] = codeOfRecordChanges([IBC_2024], [IBC_2021]);
    const [redo] = codeOfRecordChanges([IBC_2021], [IBC_2024]);
    if (!undo || !redo) throw new Error("no change");
    // The same forward change twice is the same key (one bell per signer per change).
    expect(codeChangeKey("m", redo)).toBe(codeChangeKey("m", codeOfRecordChanges([IBC_2021], [IBC_2024])[0] ?? redo));
    expect(codeChangeKey("m", undo)).not.toBe(codeChangeKey("m", redo));
  });

  it("c10-several-signers: mechanical and electrical both relied on the sheet's rules: each gets their own notice", () => {
    const carry = codeChangeCarry(new CheckingContextIndex([pinned("m", "mech", [r903]), pinned("e", "elec", [r903])]), { instruments: ["IBC"] }, { codesOfRecord: [IBC_2024], rules: rules2024 });
    expect(codeChangeNotices(carry).map((n) => n.signer)).toEqual(["elec", "mech"]);
  });

  it("different authorities: the fire marshal's code is its own instrument and moves on its own", () => {
    const ifc2021: CodeOfRecord = { discipline: "fire", instrument: "IFC", edition: "2021", jurisdiction: { country: "US", subdivision: "US-VA", locality: "Fairfax County", authority: "Fire Marshal" } };
    const fireRule = rule({ ruleId: "ifc21-907", instrument: "IFC", section: "907.2" });
    const records = [pinned("fire", "rao", [fireRule], [IBC_2021, ifc2021]), pinned("bldg", "lee", [r903], [IBC_2021, ifc2021])];
    const change = codeOfRecordChanges([IBC_2021, ifc2021], [IBC_2021, { ...ifc2021, edition: "2024" }]);
    expect(change.map((c) => c.discipline)).toEqual(["fire"]);
    const carry = codeChangeCarry(new CheckingContextIndex(records), { instruments: change.map((c) => c.instrument) }, { codesOfRecord: [IBC_2021, { ...ifc2021, edition: "2024" }], rules: [r903, rule({ ruleId: "ifc24-907", instrument: "IFC", edition: "2024", section: "907.2" })] });
    expect(carry.older.map((o) => o.record.id)).toEqual(["fire"]);
  });

  it("no rule relied on (a cover sheet): unaffected; a record with no pin is never re-checked", () => {
    const cover = pinned("cover", "rao", []);
    const carry = codeChangeCarry(new CheckingContextIndex([cover, { id: "old", signer: "lee", context: null }]), { instruments: ["IBC"] }, { codesOfRecord: [IBC_2024], rules: rules2024 });
    expect(carry).toEqual({ older: [], rechecked: 0 });
    expect(contextStanding(cover.context, { codesOfRecord: [IBC_2024], rules: rules2024 })).toMatchObject({ state: "current", words: "Checked under Virginia USBC 2021 (IBC 2021); no rule relied on" });
  });
});
