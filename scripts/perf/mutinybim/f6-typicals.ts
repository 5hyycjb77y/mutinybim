/**
 * Typicals in every trade (F6): what a typical's copies changing costs, and
 * the per-copy lint at a large count. Not run by builders (resource rules);
 * the coordinator runs it before and after and sets the budgets.
 *
 * - typicals.copies.advance.<n>: the carried requirements engine moving to a
 *   model where one typical (a bathroom: 1 space, 1 estimate, 4 devices) goes
 *   from 24 to 25 copies, beside n other loads in their own spaces. Only the
 *   typical's own loads should be re-derived: p50 / p95 ms, and `rederived`.
 * - typicals.copy-lint.<copies>: the per-copy intake/exhaust check over one
 *   typical (an RTU and an exhaust fan) repeated in a row, p50 / p95 ms.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/f6-typicals.ts
 */
import {
  BUILTIN_PART_TYPES,
  DEFAULT_SETTINGS,
  RequirementsEngine,
  allocationPolicyOf,
  executeCommand,
  modelSpaceLocator,
  type Command,
  type ModelState,
} from "../../../packages/bim-kernel/src";
import { LintEngine, DEFAULT_LINT_CONFIG } from "../../../packages/bim-lint/src";
import { gc, percentile, round, timeSync } from "./lib";

const SAMPLES = 9;

function run(m: ModelState, c: Command): { model: ModelState; changed: string[] } {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return { model: r.model, changed: [...r.changedIds, ...r.removedIds] };
}

function base(others: number): ModelState {
  let m: ModelState = { modelId: "f6-perf", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }).model;
  const sq = (x: number, y: number) => [{ x, y }, { x: x + 3000, y }, { x: x + 3000, y: y + 3000 }, { x, y: y + 3000 }];
  const spaces = Math.ceil(others / 4) + 1;
  for (let i = 0; i < spaces; i += 400) {
    const batch = Array.from({ length: Math.min(400, spaces - i) }, (_, k) => ({ spaceId: `s-${i + k}`, number: `${i + k}`, name: `Room ${i + k}`, levelId: "lvl-1", outline: sq(((i + k) % 50) * 4000, Math.floor((i + k) / 50) * 4000) }));
    m = run(m, { type: "create_space", spaces: batch }).model;
  }
  const loads = Array.from({ length: others }, (_, i) => {
    const s = 1 + Math.floor(i / 4);
    return { id: `ld-${i}`, anchor: { kind: "point" as const, levelId: "lvl-1", position: { x: (s % 50) * 4000 + 500 + (i % 4) * 500, y: Math.floor(s / 50) * 4000 + 1000 } }, values: { dfu: 1, wsfu_total: 1 } };
  });
  for (let i = 0; i < loads.length; i += 500) m = run(m, { type: "create_load", loads: loads.slice(i, i + 500) }).model;
  m = run(m, { type: "create_load", loads: [{ id: "bath-est", anchor: { kind: "space", id: "s-0" }, values: { dfu: 8 } }, ...[0, 1, 2, 3].map((k) => ({ id: `bath-${k}`, anchor: { kind: "point" as const, levelId: "lvl-1", position: { x: 500 + k * 500, y: 1000 } }, values: { dfu: 2 } }))] }).model;
  m = run(m, { type: "create_group", groupId: "g-bath", name: "Bathroom 001" }).model;
  m = run(m, { type: "assign_elements_to_group", ids: ["s-0", "bath-est", "bath-0", "bath-1", "bath-2", "bath-3"], groupId: "g-bath" }).model;
  return run(m, { type: "set_group_typical", groupId: "g-bath", mark: "001", array: { count: 24, columns: 6, spacingMm: { x: 200_000, y: 0 } } }).model;
}

function copiesAdvance(others: number): { p50: number; p95: number; rederived: number } {
  const m0 = base(others);
  const ms: number[] = [];
  let rederived = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const engine = new RequirementsEngine({ locator: modelSpaceLocator, policy: allocationPolicyOf(m0.elements) });
    engine.advance(m0, []);
    const next = run(m0, { type: "set_group_typical", groupId: "g-bath", array: { count: 25, columns: 6, spacingMm: { x: 200_000, y: 0 } } });
    const before = engine.stats.rederived;
    gc();
    ms.push(timeSync(() => engine.advance(next.model, next.changed)).ms);
    rederived = engine.stats.rederived - before;
  }
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3), rederived };
}

function copyLint(copies: number): { p50: number; p95: number; findings: number } {
  const rtu = BUILTIN_PART_TYPES.find((t) => t.id === "builtin:rtu-5-ton@2");
  const fan = BUILTIN_PART_TYPES.find((t) => t.id === "builtin:inline-fan-10@1");
  if (!rtu || !fan) throw new Error("starter library is missing the RTU or the fan");
  let m: ModelState = { modelId: "f6-lint", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "roof", name: "ROOF", elevationMm: 7500 }).model;
  m = run(m, { type: "place_part", partId: "rtu-1", typeId: rtu.id, partType: rtu.definition, levelId: "roof", position: { x: 0, y: 0 }, mark: "RTU-1" }).model;
  m = run(m, { type: "place_part", partId: "ef-1", typeId: fan.id, partType: fan.definition, levelId: "roof", position: { x: 9000, y: 0 }, mark: "EF-1", intakes: { outlet: "hood" } }).model;
  m = run(m, { type: "create_group", groupId: "g-unit", name: "Unit 001" }).model;
  m = run(m, { type: "assign_elements_to_group", ids: ["rtu-1", "ef-1"], groupId: "g-unit" }).model;
  m = run(m, { type: "set_group_typical", groupId: "g-unit", mark: "001", array: { count: copies, columns: 50, spacingMm: { x: 9000, y: 12_000 } } }).model;
  const ms: number[] = [];
  let findings = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const e = new LintEngine();
    e.build(m);
    gc();
    const t = timeSync(() => e.run({ box: null, documents: [], changed: ["g-unit"] }, { config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" } }));
    ms.push(t.ms);
    findings = t.value.filter((f) => f.rule === "typical-copy-intake-near-exhaust").length;
  }
  return { p50: round(percentile(ms, 0.5) ?? 0, 3), p95: round(percentile(ms, 0.95) ?? 0, 3), findings };
}

console.log(
  JSON.stringify({
    "typicals.copies.advance.2000": copiesAdvance(2000),
    "typicals.copies.advance.20000": copiesAdvance(20_000),
    "typicals.copy-lint.24": copyLint(24),
    "typicals.copy-lint.500": copyLint(500),
  }),
);
