/**
 * @jest-environment node
 *
 * Round 12 lane E, the move handshake for load sections: Electrical's row
 * (`ELECTRICAL_LOAD_SECTION`) equals the kernel's round 13 stand-in row field
 * for field and answer for answer (frozen when K14 deleted it in round 14),
 * and the rows in force keep round 11's tables (`LOAD_SECTIONS`, labels,
 * quantities, trades).
 *
 * On round 11's code there is no Electrical row and no rows at all: the
 * sections were constants in the kernel.
 */
import { connectionTypeSchema, loadSectionRows, totalsOf } from "@permitzip/bim-kernel";
import { ROUND13_ELECTRICAL_READS, ROUND13_LOAD_SECTION_TABLES, round13LoadSection } from "../../bim-kernel/__tests__/fixtures/k14-round13-stand-ins";
import { ELECTRICAL_LOAD_SECTION } from "@permitzip/bim-pack-electrical";

describe("e12: Electrical's load section row equals round 13's", () => {
  it("has the same data", () => {
    const keys = Object.keys(ELECTRICAL_LOAD_SECTION).sort();
    expect(JSON.stringify(ELECTRICAL_LOAD_SECTION)).toBe(round13LoadSection("electrical").json);
    expect(keys).toEqual(round13LoadSection("electrical").keys);
  });

  it("reads every connection type the same way", () => {
    for (const read of ROUND13_ELECTRICAL_READS) {
      const entry = connectionTypeSchema.parse(read.input);
      const ours = ELECTRICAL_LOAD_SECTION.connectionTotals?.(entry, totalsOf(entry.quantities));
      expect(ours).toEqual(read.totals);
      if (!ours) throw new Error("expected totals");
      expect(ELECTRICAL_LOAD_SECTION.connectionView?.(entry, ours) ?? null).toEqual(read.view);
    }
  });

  it("is the row the set in force reads for electrical, and the rows keep round 11's tables", () => {
    const t = ROUND13_LOAD_SECTION_TABLES;
    expect(loadSectionRows().find((r) => r.id === "electrical")).toBe(ELECTRICAL_LOAD_SECTION);
    expect(loadSectionRows().map((r) => r.id)).toEqual(t.LOAD_SECTIONS);
    for (const r of loadSectionRows()) expect([r.id, r.label, r.quantities, r.trade]).toEqual([r.id, t.LOAD_SECTION_LABELS[r.id], t.SECTION_QUANTITIES[r.id], t.SECTION_TRADE[r.id]]);
  });
});
