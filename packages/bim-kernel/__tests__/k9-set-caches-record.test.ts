/**
 * @jest-environment node
 *
 * Round 9 lane K9: validation learns which add-on contributions a check reads
 * by recording its reads of the pack set. A table cached outside the set
 * (`last.set === set`) answers without reading it, so while a recorder is
 * installed every such cache must step aside (`packSetReadsRecorded()`) and
 * let the read reach the set, whose `memo` replays what the table was built
 * from. Fails on round 8b: seven caches answered silently, and a tap check
 * under a set with another tree face was carried unchanged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { activePackSet, PackSet, withPackSet } from "../src/packs";
import { recordPackSetReads, type PackSetReadKind, type RecordedPoint } from "../src/packs/set";
import { treeNetwork } from "../src/tree-network";
import { ELEMENT_KIND_POINT, elementKindTable } from "../src/registry/element-kind-point";
import { connectorEndsTable } from "../src/kinds/ends";

const SRC = join(__dirname, "..", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(path));
    } else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("k9-set-caches-record", () => {
  it("every cache of a set's table kept outside the set steps aside while reads are recorded", () => {
    const unguarded: string[] = [];
    let caches = 0;
    for (const file of sources(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!/\.set === set\b/.test(line)) return;
          caches += 1;
          if (!line.includes("packSetReadsRecorded()")) unguarded.push(`${relative(SRC, file)}:${i + 1}`);
        });
    }
    expect(caches).toBeGreaterThanOrEqual(7);
    expect(unguarded).toEqual([]);
  });

  it("a check is told the same reads whichever check first filled the set's row lists", () => {
    // Round 10 merge: the ends table and the kind table both read the element-kind rows. Whichever filled the set's
    // row list first was also told of the first-party and firm rows inside it, so a check's recorded reads (and the
    // point index built after a save) depended on which table a pass happened to build first.
    const readsOf = (warmFirst: () => unknown, recorded: () => unknown): string[] => {
      const set = PackSet.create([]);
      return withPackSet(set, () => {
        warmFirst();
        const seen = new Set<string>();
        const note = (kind: PackSetReadKind, target: RecordedPoint | string): void => void seen.add(`${kind}:${typeof target === "string" ? target : target.id}`);
        recordPackSetReads({ note }, recorded);
        return [...seen].sort();
      });
    };
    const cold = readsOf(() => undefined, () => elementKindTable());
    expect(cold).toContain("0:kernel.element_kind");
    expect(readsOf(() => connectorEndsTable(), () => elementKindTable())).toEqual(cold);
    expect(readsOf(() => elementKindTable(), () => connectorEndsTable())).toEqual(readsOf(() => undefined, () => connectorEndsTable()));
    expect(readsOf(() => activePackSet().items(ELEMENT_KIND_POINT), () => activePackSet().items(ELEMENT_KIND_POINT))).toEqual(readsOf(() => undefined, () => activePackSet().items(ELEMENT_KIND_POINT)));
  });

  it("a cached tree still tells the recorder which rows it came from", () => {
    const set = PackSet.create([]);
    withPackSet(set, () => {
      treeNetwork();
      const seen: string[] = [];
      const note = (kind: PackSetReadKind, target: RecordedPoint | string): void => void seen.push(`${kind}:${typeof target === "string" ? target : target.id}`);
      recordPackSetReads({ note }, () => treeNetwork());
      expect(seen).toContain("0:kernel.network_adapter");
      expect(activePackSet()).toBe(set);
    });
  });
});
