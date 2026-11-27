/**
 * @jest-environment node
 *
 * CI gate: every built-in starter part (offered and superseded, across all
 * first-party add-ons) and every showcase part must pass `partTypeImportReport`
 * with zero connector problems (valid `endType`, known system, and connectors
 * sitting cleanly on an outer face of the part's body pointing out).
 */
import { builtinPartTypes, partTypeImportReport, supersededBuiltinPartTypes } from "@permitzip/bim-kernel";
import { SHOWCASE_PART_TYPES } from "../src/seed/showcase-parts";

function reportSummary(entries: ReadonlyArray<{ readonly id: string; readonly definition: Parameters<typeof partTypeImportReport>[0] }>) {
  const bad: Array<{ id: string; problems: string[] }> = [];
  for (const entry of entries) {
    const report = partTypeImportReport(entry.definition);
    if (report.problems.length > 0) {
      bad.push({
        id: entry.id,
        problems: report.problems.map((p) => `${p.connectorLabel} (${p.check}): ${p.message}`),
      });
    }
  }
  return bad;
}

describe("built-in and showcase part connector hygiene", () => {
  it("every offered built-in part type has zero partTypeImportReport problems", () => {
    const offered = builtinPartTypes();
    expect(offered.length).toBeGreaterThanOrEqual(90);
    expect(reportSummary(offered)).toEqual([]);
  });

  it("every superseded built-in part type has zero partTypeImportReport problems", () => {
    const superseded = supersededBuiltinPartTypes();
    expect(superseded.length).toBeGreaterThanOrEqual(3);
    expect(reportSummary(superseded)).toEqual([]);
  });

  it("every showcase part type has zero partTypeImportReport problems", () => {
    expect(SHOWCASE_PART_TYPES.length).toBeGreaterThanOrEqual(17);
    expect(reportSummary(SHOWCASE_PART_TYPES)).toEqual([]);
  });
});
