import type { CodeOfRecord, PinnedRecord, RuleRecord } from "@permitzip/bim-kernel";
import { buildCheckingContext } from "@permitzip/bim-kernel";

/** A rule as a code pack supplies it, with only what C10 reads filled in. Generic words, no code text. */
export function rule(over: { ruleId: string; instrument?: string; edition?: string; section: string; ruleVersion?: string; correctedAt?: string; provider?: string; carriedForward?: RuleRecord["carriedForward"]; jurisdiction?: string; jurisdictionId?: RuleRecord["citation"]["jurisdictionId"]; adoptedAs?: string; amendment?: { id: string; version: string } }): RuleRecord {
  return {
    ruleId: over.ruleId,
    provider: over.provider ?? "test.codes",
    citation: {
      instrument: over.instrument ?? "IBC",
      edition: over.edition ?? "2021",
      section: over.section,
      ...(over.jurisdiction ? { jurisdiction: over.jurisdiction } : {}),
      ...(over.jurisdictionId ? { jurisdictionId: over.jurisdictionId } : {}),
      ...(over.adoptedAs ? { adoptedAs: over.adoptedAs } : {}),
      ...(over.amendment ? { amendment: over.amendment } : {}),
    },
    title: `Requirement at ${over.section}`,
    summary: "A test requirement in the author's words.",
    discipline: "architecture",
    applies: {},
    reads: [],
    produces: [],
    verification: { status: "verified" },
    ...(over.ruleVersion ? { ruleVersion: over.ruleVersion } : {}),
    ...(over.correctedAt ? { correctedAt: over.correctedAt } : {}),
    ...(over.carriedForward ? { carriedForward: over.carriedForward } : {}),
  };
}

export const VA = { country: "US", subdivision: "US-VA" } as const;

export const IBC_2021: CodeOfRecord = { discipline: "building", instrument: "IBC", edition: "2021", adoptedAs: "Virginia USBC 2021", jurisdiction: VA };
export const IBC_2024: CodeOfRecord = { discipline: "building", instrument: "IBC", edition: "2024", adoptedAs: "Virginia USBC 2024", jurisdiction: VA };
export const IECC_2021: CodeOfRecord = { discipline: "energy", instrument: "IECC", edition: "2021", jurisdiction: VA };

/** A signed approval pinning these rules under these codes of record. */
export function pinned(id: string, signer: string, rules: readonly RuleRecord[], codes: readonly CodeOfRecord[] = [IBC_2021, IECC_2021], signerName?: string): PinnedRecord {
  return { id, signer, ...(signerName ? { signerName } : {}), context: buildCheckingContext({ jurisdiction: VA, codesOfRecord: codes, rules, packs: [{ id: "test.codes", version: "1.0.0" }] }) };
}
