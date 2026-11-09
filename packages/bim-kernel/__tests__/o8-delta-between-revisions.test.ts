/**
 * @jest-environment node
 *
 * Round 8b lane O: the quantity change between two revisions, read the way
 * the model server reads it (ids changed in the range, then those elements
 * and what they name at both ends through `stateAt`), equals the delta over
 * the two full rebuilt models, on 120 random edits and 80 random ranges. It
 * never asks for more than the changed ids, their hosts, their types, what
 * those hosts hold now and what changed after the range.
 *
 * Fails on round 8's code: there is no `quantityDeltaFromReads`,
 * `readForQuantityDelta` or `deltaDigest`.
 */
import { changedBetween, deltaDigest, hostedIds, quantityDeltaFromReads, quantityDeltasBetween, readForQuantityDelta, stateAt, type QuantityDelta } from "../src";
import { historyOf, randomOfficeSteps, rng, TWO_HOUR_TYPE } from "./o8-fixtures";
import { FT, openingRecord, threeOffices, wallRecord } from "./q7-fixtures";
import { asElementId } from "../src";

const round = (ds: readonly QuantityDelta[]) => ds.map((d) => ({ measure: d.measure, group: d.group, unit: d.unit, label: d.label, delta: Math.round(d.delta * 1e6) / 1e6 }));

describe("o8-delta-between-revisions", () => {
  const base = threeOffices();
  const seeded = { ...base, elements: { ...base.elements, [TWO_HOUR_TYPE.id]: TWO_HOUR_TYPE } };
  const { head, snapshots, changesets } = historyOf(seeded, randomOfficeSteps(seeded, 120, 82));

  async function viaReads(from: number, to: number, all = false) {
    const ids = changedBetween(changesets, from, to);
    const asked: string[] = [];
    const reads = await readForQuantityDelta(
      ids,
      async (end, want) => {
        asked.push(...want);
        return stateAt(head, end === "from" ? from : to, changesets, want.map(asElementId));
      },
      { hostedNow: (host) => hostedIds(head.elements, host), laterChanged: changedBetween(changesets, to, head.revision) },
    );
    return { deltas: quantityDeltaFromReads(reads, ids, { all }), ids, asked };
  }

  it("equals the full-model delta on 80 random ranges (primary and all measures)", async () => {
    const next = rng(5);
    for (let i = 0; i < 80; i++) {
      const a = Math.floor(next() * (head.revision + 1));
      const b = Math.floor(next() * (head.revision + 1));
      const [from, to] = a <= b ? [a, b] : [b, a];
      const all = i % 2 === 1;
      const { deltas, ids } = await viaReads(from, to, all);
      const full = quantityDeltasBetween(snapshots[from]?.elements ?? {}, snapshots[to]?.elements ?? {}, ids, { all });
      expect(round(deltas)).toEqual(round(full));
      expect(deltaDigest(deltas)).toBe(deltaDigest(full));
    }
  });

  it("reads only changed ids, their hosts and types, and what those hosts hold now", async () => {
    const { ids, asked } = await viaReads(10, 40);
    const allowed = new Set<string>(ids);
    for (const id of ids) {
      for (const snap of [snapshots[10], snapshots[40]]) {
        const el = snap?.elements[id];
        if (el && "hostId" in el && typeof el.hostId === "string") {
          allowed.add(el.hostId);
          for (const h of hostedIds(head.elements, el.hostId)) allowed.add(h);
        }
        for (const h of hostedIds(head.elements, id)) allowed.add(h);
        if (el && "typeId" in el && typeof el.typeId === "string") allowed.add(el.typeId);
      }
    }
    for (const id of changedBetween(changesets, 40, head.revision)) allowed.add(id);
    for (const id of [...allowed]) {
      const el = snapshots[40]?.elements[id] ?? snapshots[10]?.elements[id];
      if (el && "typeId" in el && typeof el.typeId === "string") allowed.add(el.typeId);
    }
    for (const id of asked) expect(allowed.has(id)).toBe(true);
  });

  it("names the change in quantities: a new wall with a door between two versions", async () => {
    const h = historyOf(base, [{ written: [wallRecord("W-20", { x: 0, y: 30 * FT }, { x: 20 * FT, y: 30 * FT }, { typeId: asElementId("t-1hr") }), openingRecord("D-20", "W-20", "door", 3 * FT, 7 * FT)] }, { removedIds: ["D-12"] }]);
    const ids = changedBetween(h.changesets, 0, 2);
    const reads = await readForQuantityDelta(ids, async (end, want) => stateAt(h.head, end === "from" ? 0 : 2, h.changesets, want.map(asElementId)));
    const labels = quantityDeltaFromReads(reads, ids).map((d) => d.label);
    expect(labels).toContain("+20 ft of 1-hour wall");
    // One door added (D-20), one removed (D-12): no net door change, so no door row.
    expect(labels.some((l) => l.includes("door"))).toBe(false);
  });

  it("an empty range has no delta and a stable digest", async () => {
    const { deltas } = await viaReads(7, 7);
    expect(deltas).toEqual([]);
    expect(deltaDigest([])).toBe(deltaDigest([]));
    expect(deltaDigest([])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
