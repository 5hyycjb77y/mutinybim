/**
 * @jest-environment node
 *
 * Round 11 lane K11: the files this lane changed name fewer of the five
 * round-1 kinds and fewer trade words. `commands.ts` no longer runs a duct
 * case (no `Propagator`, no `collectRun`, no tap / duct / unit kind);
 * `derived.ts` and `validate.ts` place and check hosted records through
 * their kind rows and name no tap kind; `model.ts`'s `anchorOf` has no kind
 * case. Each count is below round 10's.
 *
 * Fails on round 10's code: `commands.ts` held the three duct halves (12
 * duct words, `requireKind(…, "tap")`), and `derived.ts` / `validate.ts`
 * read `el.kind === "tap"` in every placement and spacing path.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "src");
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");
const FIVE = /"(duct_segment|tap|equipment|elbow|terminal)"/g;

/** Words split as trade-terms.test.ts splits them (identifiers into words, case-insensitive, plurals). */
function countWord(source: string, word: string): number {
  const words = source.split(/[^A-Za-z0-9]+/).flatMap((tok) => tok.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s_]+/));
  return words.filter((w) => [word, `${word}s`, `${word}es`].includes(w.toLowerCase())).length;
}

describe("k11-trade-terms-drop", () => {
  it("commands.ts runs no duct case: the three halves are the Mechanical add-on's claims", () => {
    const source = read("commands.ts");
    expect(source.match(FIVE) ?? []).toEqual([]);
    expect(source).not.toMatch(/\bPropagator\b/);
    expect(source).not.toMatch(/\bcollectRun\b/);
    expect(source).not.toMatch(/\btapPosition\b/);
    // Round 10: 12. What is left is the insulation command type the kernel still names (another lane's move).
    expect(countWord(source, "duct")).toBeLessThanOrEqual(5);
  });

  it("derived.ts and validate.ts place and check hosted records by their rows, naming no tap kind", () => {
    for (const file of ["derived.ts", "validate.ts"]) {
      const source = read(file);
      expect([file, source.match(/"tap"/g) ?? []]).toEqual([file, []]);
      expect([file, /\bTapFitting\b/.test(source)]).toEqual([file, false]);
    }
  });

  it("the new registry files name no kind of an add-on and no trade word", () => {
    for (const file of ["kinds/rows.ts", "kinds/hosted.ts", "kinds/records/rows.ts", "kinds/records/index.ts"]) {
      const source = read(file);
      expect([file, source.match(FIVE) ?? []]).toEqual([file, []]);
      for (const word of ["duct", "cfm", "airflow", "mechanical", "plumbing", "electrical", "panel", "circuit", "gas", "sprinkler"]) expect([file, word, countWord(source, word)]).toEqual([file, word, 0]);
    }
  });
});
