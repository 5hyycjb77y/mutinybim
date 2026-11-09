/**
 * @jest-environment node
 *
 * S-16 (5c, found by the structural pack): a node with parents at different
 * depths. A beam bears on a column stacked on another column at one end and on
 * a single column at the other. Totalled breadth-first, the upper column was
 * folded before the beam and dropped its share, so the footing under the stack
 * read 0. Parents now come before children when a node is shared; a tree keeps
 * its breadth-first order.
 */
import { networkTotals, sumMonoid, type NetworkAdapter } from "@permitzip/bim-kernel";

const CHILDREN: Readonly<Record<string, readonly string[]>> = {
  "footing-stack": ["column-low"],
  "column-low": ["column-high"],
  "column-high": ["beam"],
  "footing-single": ["column-single"],
  "column-single": ["beam"],
  beam: [],
};
const OWN: Readonly<Record<string, number>> = { beam: 1000, "column-low": 10, "column-high": 10, "column-single": 10 };

const frame: NetworkAdapter<string, number> = {
  roots: () => ["footing-stack", "footing-single"],
  children: (n) => CHILDREN[n] ?? [],
  ownQuantities: (n) => OWN[n],
  across: (child, _parent, total) => (child === "beam" ? total / 2 : total),
};

describe("networkTotals with a node shared at two depths", () => {
  it("hands the beam's share to both supports, however deep each is", () => {
    const totals = networkTotals(frame, sumMonoid, (v, k) => v * k);
    expect(totals.get("column-high")).toBe(510);
    expect(totals.get("footing-stack")).toBe(520);
    expect(totals.get("footing-single")).toBe(510);
  });

  it("keeps a plain tree's totals", () => {
    const tree: NetworkAdapter<string, number> = { roots: () => ["a"], children: (n) => (n === "a" ? ["b", "c"] : []), ownQuantities: (n) => (n === "a" ? 1 : 2) };
    expect(Object.fromEntries(networkTotals(tree, sumMonoid))).toEqual({ a: 5, b: 2, c: 2 });
  });
});
