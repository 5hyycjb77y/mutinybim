/**
 * @jest-environment node
 *
 * Property: an engine told what each edit changed (`advance`) finds exactly
 * what a fresh engine built on the same revision finds, over random edit
 * sequences (place, move, raise, route, delete), with the linked building in.
 * The same must hold for the near-edit scope the lint block reads.
 */
import type { Command } from "@permitzip/bim-kernel";
import { ALL_RULES, LintEngine } from "../src";
import { config, FT, IN, linkedBuilding, Model, RETURN, SUPPLY } from "./fixtures";

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

const ids = (findings: ReadonlyArray<{ id: string }>) => findings.map((f) => f.id).sort();

describe("advance equals a full rebuild", () => {
  for (const seed of [7, 21, 1984]) {
    it(`seed ${seed}: 40 random edits`, () => {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const m = new Model();
      const linked = [linkedBuilding()];
      const engine = new LintEngine();
      engine.build(m.head, linked);
      const cfg = config({ ruleset: "issue" });
      const parts: string[] = [];
      let applied = 0;
      const kinds = new Set<string>();
      for (let step = 0; step < 40; step++) {
        const roll = rnd();
        const segments = Object.values(m.head.elements).filter((e) => e.kind === "run_segment").map((e) => e.id as string);
        let command: Command;
        if (roll < 0.25 || parts.length === 0) {
          const pid = `rtu-${step}`;
          const r = m.placeRtu(pid, { x: (rnd() * 80 - 10) * FT, y: (rnd() * 50 - 5) * FT }, Math.round(rnd() * 3) * 6 * IN - 6 * IN);
          parts.push(pid);
          engine.advance(m.head, r);
          applied += 1;
        } else {
          if (roll < 0.45) command = { type: "move_elements", ids: [pick(parts)], delta: { x: (rnd() * 20 - 10) * FT, y: (rnd() * 20 - 10) * FT } };
          else if (roll < 0.55) command = { type: "move_elements", ids: [pick(parts)], delta: { x: 0, y: 0 }, dzMm: (rnd() * 4 - 2) * FT };
          else if (roll < 0.8) {
            const x0 = rnd() * 50;
            const y0 = rnd() * 35;
            const horizontal = rnd() < 0.5;
            command = {
              type: "route_run",
              idPrefix: `run-${step}`,
              levelId: rnd() < 0.5 ? "lvl-1" : "lvl-roof",
              domain: "duct",
              size: { shape: "rect", width: (12 + Math.round(rnd() * 12)) * IN, height: 12 * IN },
              elevationMm: (rnd() < 0.5 ? 9 : -1.5) * FT,
              system: rnd() < 0.5 ? SUPPLY : RETURN,
              points: [
                { x: x0 * FT, y: y0 * FT },
                horizontal ? { x: (x0 + 15) * FT, y: y0 * FT } : { x: x0 * FT, y: (y0 + 15) * FT },
              ],
            };
          } else if (segments.length > 0 && roll < 0.9) command = { type: "delete_elements", ids: [pick(segments)], policy: "disconnect" };
          else {
            const victim = pick(parts);
            command = { type: "delete_elements", ids: [victim], policy: "cascade" };
          }
          const r = m.try(command);
          if (typeof r === "string") continue;
          kinds.add(command.type);
          if (command.type === "delete_elements") for (const d of command.ids) parts.splice(parts.indexOf(d), parts.includes(d) ? 1 : 0);
          engine.advance(m.head, r);
          applied += 1;
        }
        const fresh = new LintEngine();
        fresh.build(m.head, linked);
        expect(ids(engine.check({ config: cfg }))).toEqual(ids(fresh.check({ config: cfg })));
      }
      expect(applied).toBeGreaterThan(25);
      expect([...kinds].sort()).toEqual(["delete_elements", "move_elements", "route_run"]);
    });
  }

  /*
   * A scoped run skips work that can't report: pair-only rules on elements
   * outside pairsFrom, and elements whose kind has no rule to run. The
   * reference engine runs the same rules with nothing skippable (no rule is
   * pair-only, and a silent rule applies to every kind), so every element in
   * scope is read and every rule is called. The findings must be identical,
   * field for field and in order, before and after each edit.
   */
  for (const seed of [3, 1001]) {
    it(`seed ${seed}: a scoped run finds exactly what a run that skips nothing finds`, () => {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const m = new Model();
      const linked = [linkedBuilding()];
      const fast = new LintEngine();
      const reference = new LintEngine([...ALL_RULES.map((r) => ({ ...r, pairsOnly: false })), { id: "test-silent", version: 1, pack: "coordination", severity: "info", title: "Reads every element", scope: "element", run: () => undefined }]);
      fast.build(m.head, linked);
      reference.build(m.head, linked);
      const cfg = config({ ruleset: "issue" });
      const parts: string[] = [];
      let compared = 0;
      for (let step = 0; step < 30; step++) {
        const before = m.head;
        const roll = rnd();
        let changed: string[] | string;
        if (roll < 0.2 || parts.length === 0) {
          const pid = `rtu-${step}`;
          changed = m.placeRtu(pid, { x: (rnd() * 80 - 10) * FT, y: (rnd() * 50 - 5) * FT }, Math.round(rnd() * 3) * 6 * IN - 6 * IN);
          parts.push(pid);
        } else if (roll < 0.3) {
          const pid = `diffuser-${step}`;
          changed = m.placeDiffuser(pid, { x: rnd() * 50 * FT, y: rnd() * 35 * FT });
          parts.push(pid);
        } else if (roll < 0.55) {
          changed = m.try({ type: "move_elements", ids: [pick(parts)], delta: { x: (rnd() * 20 - 10) * FT, y: (rnd() * 20 - 10) * FT }, ...(rnd() < 0.3 ? { dzMm: (rnd() * 4 - 2) * FT } : {}) });
        } else {
          const x0 = rnd() * 50;
          const y0 = rnd() * 35;
          changed = m.try({
            type: "route_run",
            idPrefix: `run-${step}`,
            levelId: rnd() < 0.5 ? "lvl-1" : "lvl-roof",
            domain: "duct",
            size: { shape: "rect", width: (12 + Math.round(rnd() * 12)) * IN, height: 12 * IN },
            elevationMm: (rnd() < 0.5 ? 9 : -1.5) * FT,
            system: rnd() < 0.5 ? SUPPLY : RETURN,
            points: [
              { x: x0 * FT, y: y0 * FT },
              rnd() < 0.5 ? { x: (x0 + 15) * FT, y: y0 * FT } : { x: x0 * FT, y: (y0 + 15) * FT },
            ],
          });
        }
        if (typeof changed === "string") continue;
        const after = m.head;
        const scopeOf = (e: LintEngine) => ({ ...e.scopeFor(changed as string[], e.boxesIn(before, changed as string[]), e.boxesIn(after, changed as string[]), cfg.scope_radius_ft * FT), pairsFrom: changed as string[] });
        const was = fast.run(scopeOf(fast), { config: cfg });
        expect(was).toEqual(reference.run(scopeOf(reference), { config: cfg }));
        fast.advance(after, changed);
        reference.advance(after, changed);
        const now = fast.run(scopeOf(fast), { config: cfg, previous: before, editedByAgent: true });
        expect(now).toEqual(reference.run(scopeOf(reference), { config: cfg, previous: before, editedByAgent: true }));
        expect(fast.check({ config: cfg, ids: changed })).toEqual(reference.check({ config: cfg, ids: changed }));
        compared += 1;
      }
      expect(compared).toBeGreaterThan(20);
      expect(fast.check({ config: cfg })).toEqual(reference.check({ config: cfg }));
      expect(fast.check({ config: cfg }).some((f) => f.rule === "clash-hard" || f.rule === "clash-soft")).toBe(true);
    });
  }

  it("the near-edit scope matches a fresh engine's too", () => {
    const m = new Model();
    const linked = [linkedBuilding()];
    const engine = new LintEngine();
    engine.build(m.head, linked);
    const first = m.duct("sa", SUPPLY, [[10, 10], [50, 10]], 9);
    engine.advance(m.head, first);
    const changed = m.duct("ra", RETURN, [[30, 0], [30, 30]], 9);
    engine.advance(m.head, changed);
    const fresh = new LintEngine();
    fresh.build(m.head, linked);
    const scope = (e: LintEngine) => e.scopeFor(changed, [], e.boxesIn(m.head, changed), 10 * FT);
    expect(ids(engine.run(scope(engine), { config: config() }))).toEqual(ids(fresh.run(scope(fresh), { config: config() })));
    expect(ids(engine.run(scope(engine), { config: config() })).some((x) => x.startsWith("clash-hard:"))).toBe(true);
  });
});
