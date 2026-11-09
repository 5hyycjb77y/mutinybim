/**
 * @jest-environment node
 *
 * Round 10 lane K10: the network index, topology and connector positions
 * name none of the five round-1 kinds and no trade word; what those kinds'
 * ends are, where they sit and where the element sits is the Mechanical
 * add-on's. Each changed file's duct count is below round 9's (the words
 * moved with their logic, none were renamed).
 *
 * Fails on round 9's code: network.ts held `DOWNSTREAM_ENDS` and a slot code
 * per duct kind, topology.ts `UPSTREAM_END`, model.ts a `pointOf` / `anchorOf`
 * case per duct kind.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");

/** Same word split as trade-terms.test.ts: identifiers into words, case-insensitive, plurals counted. */
function ductWords(text: string): number {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return split.split(/[^A-Za-z]+/).filter((w) => ["duct", "ducts"].includes(w.toLowerCase())).length;
}

const FIVE = /"(equipment|duct_segment|tap|elbow|terminal)"/;

describe("k10-trade-terms-drop", () => {
  it("network.ts and topology.ts name none of the five kinds and no duct word", () => {
    for (const file of ["network.ts", "topology.ts", "kinds/ends.ts", "kinds/anchor.ts"]) {
      const text = read(file);
      expect([file, FIVE.test(text)]).toEqual([file, false]);
      expect([file, ductWords(text)]).toEqual([file, 0]);
      expect([file, /DOWNSTREAM_ENDS|UPSTREAM_END/.test(text)]).toEqual([file, false]);
    }
  });

  it("model.ts places no end and anchors no element of the five kinds by name", () => {
    const text = read("model.ts");
    expect(/case "(equipment|duct_segment|tap|elbow|terminal)":/.test(text)).toBe(false);
  });

  it("each changed file's duct count is below round 9's", () => {
    const round9: Readonly<Record<string, number>> = { "network.ts": 4, "topology.ts": 1, "model.ts": 7 };
    for (const [file, was] of Object.entries(round9)) expect([file, ductWords(read(file)) < was]).toEqual([file, true]);
  });
});
