/**
 * @jest-environment node
 *
 * Round 5c f-scale (audit §4): a level edit re-reads only the bodies and
 * surfaces that take their height from that level, and the index then
 * equals one built fresh on the same revision: every body's box, kind,
 * layer and plumb flag, and every surface's height and level, over random
 * sequences of level moves and renames mixed with placements, routes and
 * moves (runs and parts on a level id; slabs, rooms and walls on a level
 * name).
 *
 * Fails on the old code by the count: it re-put every element of the model
 * on any level edit (`reput` equals the model's element count there).
 */
import { asElementId, type BimElement } from "@permitzip/bim-kernel";
import { IndexState } from "../src/index-state";
import { FT, IN, Model, SUPPLY } from "./fixtures";

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EVERYWHERE = { min: { x: -1e7, y: -1e7, z: -1e7 }, max: { x: 1e7, y: 1e7, z: 1e7 } };

function snapshot(state: IndexState, ids: readonly string[]) {
  const bodies = ids.map((id) => {
    const b = state.body(id);
    return b ? { id, box: b.box, kind: b.kind, layer: b.layer, plumb: b.plumb } : { id, none: true };
  });
  const surfaces = state.surfaceGrid
    .query(EVERYWHERE)
    .map((slot) => state.surfaceAt(slot))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({ key: s.key, kind: s.kind, bottom: s.bottom, top: s.top, level: s.level }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { bodies, surfaces };
}

function slab(id: string, level: string, x: number): BimElement {
  // A slab as the store holds it; this fixture has no slab authoring command (Model.put).
  return { id: asElementId(id), kind: "slab", version: 1, authoredRev: {}, partition: { level, zone: "Z1", discipline: "structure" }, outline: [{ x, y: 0 }, { x: x + 20 * FT, y: 0 }, { x: x + 20 * FT, y: 20 * FT }, { x, y: 20 * FT }], thickness: 250 } as unknown as BimElement;
}

describe("c5s lint index: level edits", () => {
  for (const seed of [5, 77, 2026]) {
    it(`seed ${seed}: the advanced index equals a fresh one after level moves and renames`, () => {
      const rnd = prng(seed);
      const m = new Model();
      m.put(slab("slab-a", "Level 1", 0), slab("slab-b", "ROOF", 30 * FT), slab("slab-c", "roof", 60 * FT));
      const state = new IndexState(m.head.elements);
      state.buildAll();
      const parts: string[] = [];
      let levelEdits = 0;
      for (let step = 0; step < 30; step++) {
        const roll = rnd();
        let changed: string[] | string;
        if (roll < 0.3) {
          levelEdits += 1;
          const which = rnd() < 0.5 ? "lvl-1" : "lvl-roof";
          changed = rnd() < 0.7 ? m.try({ type: "update_level", levelId: which, elevationMm: Math.round((which === "lvl-1" ? rnd() * 2 : 20 + rnd() * 8) * FT) }) : m.try({ type: "update_level", levelId: which, name: which === "lvl-1" ? (rnd() < 0.5 ? "Level 1" : "First floor") : rnd() < 0.5 ? "ROOF" : "Roof deck" });
        } else if (roll < 0.5 || parts.length === 0) {
          const pid = `rtu-${step}`;
          changed = m.placeRtu(pid, { x: rnd() * 60 * FT, y: rnd() * 30 * FT }, 0, rnd() < 0.5 ? "lvl-roof" : "lvl-1");
          parts.push(pid);
        } else if (roll < 0.7) {
          changed = m.try({ type: "move_elements", ids: [parts[Math.floor(rnd() * parts.length)] ?? ""], delta: { x: (rnd() * 10 - 5) * FT, y: 0 } });
        } else {
          const x0 = rnd() * 50;
          changed = m.try({ type: "route_run", idPrefix: `run-${step}`, levelId: rnd() < 0.5 ? "lvl-1" : "lvl-roof", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 12 * IN }, elevationMm: 9 * FT, system: SUPPLY, points: [{ x: x0 * FT, y: 5 * FT }, { x: (x0 + 12) * FT, y: 5 * FT }] });
        }
        if (typeof changed === "string") continue;
        state.apply(m.head.elements, changed);
        const fresh = new IndexState(m.head.elements);
        fresh.buildAll();
        const ids = Object.keys(m.head.elements);
        expect(snapshot(state, ids)).toEqual(snapshot(fresh, ids));
      }
      expect(levelEdits).toBeGreaterThan(4);
    });
  }

  it("a level move re-reads what stands on it, not the model", () => {
    const m = new Model();
    m.put(slab("slab-a", "Level 1", 0), slab("slab-b", "ROOF", 30 * FT));
    m.placeRtu("rtu-roof", { x: 10 * FT, y: 10 * FT });
    m.duct("lvl1-duct", SUPPLY, [[0, 0], [20, 0]], 9);
    for (let i = 0; i < 40; i++) m.placeRtu(`rtu-l1-${i}`, { x: i * 6 * FT, y: 40 * FT }, 0, "lvl-1");
    const state = new IndexState(m.head.elements);
    state.buildAll();
    const put = jest.spyOn(state as unknown as { put: (el: BimElement) => void }, "put"); // private, spied to count re-reads
    const changed = m.ok({ type: "update_level", levelId: "lvl-roof", elevationMm: 26 * FT });
    state.apply(m.head.elements, changed);
    const reput = new Set(put.mock.calls.map(([el]) => el.id));
    expect([...reput].sort()).toEqual(["lvl-roof", "rtu-roof", "slab-b"]);
    expect(state.body("rtu-roof")?.box.min.z).toBeGreaterThan(25 * FT);
  });
});
