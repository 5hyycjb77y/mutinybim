/**
 * @jest-environment node
 *
 * Round 10 lane C10 (FOUNDATION-REVIEW §6.2): the jurisdiction in a pin is an
 * open id, any country, written before anything is signed with it. A Swedish
 * and a Canadian adoption pin and read back exactly; a stored US state (every
 * record before round 10) reads as US + subdivision; a stored "CA" stays
 * California. Fails on round 9: there was no jurisdiction id, and a citation's
 * jurisdiction was a free US state string.
 */
import {
  buildCheckingContext,
  checkedAgainstWords,
  jurisdictionKey,
  jurisdictionWithin,
  jurisdictionWords,
  parseJurisdiction,
  readCheckingContext,
  readRuleRecord,
  ruleVersionRef,
  usStateOf,
  writeCheckingContext,
  type JurisdictionId,
} from "@permitzip/bim-kernel";
import { rule } from "./fixtures/c10-rules";

const SWEDEN: JurisdictionId = { country: "SE" };
const TORONTO: JurisdictionId = { country: "CA", subdivision: "CA-ON", locality: "Toronto" };

describe("c10-jurisdiction-open-id", () => {
  it("a stored US state reads back as US + subdivision; its name reads too", () => {
    expect(parseJurisdiction("VA")).toEqual({ country: "US", subdivision: "US-VA" });
    expect(parseJurisdiction("va ")).toEqual({ country: "US", subdivision: "US-VA" });
    expect(parseJurisdiction("Virginia")).toEqual({ country: "US", subdivision: "US-VA" });
    expect(parseJurisdiction("US-VA")).toEqual({ country: "US", subdivision: "US-VA" });
    expect(usStateOf(parseJurisdiction("VA"))).toBe("VA");
  });

  it("a stored \"CA\" stays California; Canada is written as an id or its key", () => {
    expect(parseJurisdiction("CA")).toEqual({ country: "US", subdivision: "US-CA" });
    expect(parseJurisdiction({ country: "CA" })).toEqual({ country: "CA" });
    expect(parseJurisdiction("CA-ON")).toEqual({ country: "CA", subdivision: "CA-ON" });
    expect(parseJurisdiction(jurisdictionKey(TORONTO))).toEqual(TORONTO);
  });

  it("any country, with a locality and an authority, round-trips through its key", () => {
    const marshal: JurisdictionId = { country: "US", subdivision: "US-VA", locality: "Fairfax County", authority: "Fire Marshal" };
    expect(jurisdictionKey(marshal)).toBe("US/US-VA/Fairfax County#Fire Marshal");
    expect(parseJurisdiction(jurisdictionKey(marshal))).toEqual(marshal);
    expect(parseJurisdiction("SE")).toEqual(SWEDEN);
    expect(jurisdictionWords(marshal)).toBe("Fairfax County, Virginia (Fire Marshal)");
    expect(jurisdictionWords(SWEDEN)).toBe("Sweden");
    expect(jurisdictionWithin(marshal, { country: "US", subdivision: "US-VA" })).toBe(true);
    expect(jurisdictionWithin(TORONTO, { country: "US" })).toBe(false);
  });

  it("refuses what isn't a place: a subdivision of another country, a bad code", () => {
    expect(parseJurisdiction({ country: "SE", subdivision: "US-VA" })).toBeNull();
    expect(parseJurisdiction({ country: "Sweden" })).toBeNull();
    expect(parseJurisdiction(42)).toBeNull();
    expect(parseJurisdiction("")).toBeNull();
  });

  it("a Swedish and a Canadian adoption pin into a checking context and read back exactly", () => {
    const boverket = rule({ ruleId: "bbr-5-1", instrument: "BBR", edition: "29", section: "5:1", jurisdictionId: SWEDEN, ruleVersion: "2" });
    const obc = rule({ ruleId: "obc-3-2", instrument: "OBC", edition: "2024", section: "3.2.4", jurisdictionId: TORONTO });
    const ctx = buildCheckingContext({ jurisdiction: TORONTO, codesOfRecord: [{ discipline: "building", instrument: "OBC", edition: "2024", jurisdiction: TORONTO }], rules: [obc, boverket] });
    const back = readCheckingContext({ checking_context: writeCheckingContext(ctx) });
    expect(back).toEqual(ctx);
    expect(back?.rules.map((r) => r.jurisdiction)).toEqual([SWEDEN, TORONTO]);
    expect(checkedAgainstWords(ctx)).toBe("Checked against BBR 29 §5:1 (Sweden adoption), rule v2, and 1 more rule");
  });

  it("a rule citing only a stored state pins the open id; a citation with a malformed id is refused", () => {
    expect(ruleVersionRef(rule({ ruleId: "r", section: "903.2", jurisdiction: "VA" })).jurisdiction).toEqual({ country: "US", subdivision: "US-VA" });
    const bad = { ...rule({ ruleId: "r", section: "903.2" }), citation: { instrument: "IBC", edition: "2021", section: "903.2", jurisdictionId: { country: "Virginia" } } };
    expect(readRuleRecord(bad)).toMatchObject({ ok: false });
  });
});
