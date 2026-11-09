/**
 * ventilation.table.2k — outdoor air for 2,000 spaces on the synthetic tower
 * (ROADMAP M1 on F3's spaces).
 *
 *   node --import tsx scripts/perf/mutinybim/ventilation-outdoor-air.ts [--samples=7]
 *
 * Builds tower-14 with a space made from every room (restaurant dining use,
 * IMC rates pinned), loads the ventilation pack, then measures:
 *
 *   ventilation.table.2k.cold     the whole-model table, nothing kept (2,000 evaluations, both standards)
 *   ventilation.advance.one_edit  advance by one edited space's id (1 re-evaluation)
 *   ventilation.table.2k.edit     the whole-model table after that edit (1,999 kept, 0 new evaluations)
 *   ventilation.level_table       one level's table, warm (what the panel reads per render)
 *
 * Prints one JSON object (median and p95 per metric, plus counts that prove
 * the edit re-evaluated one space).
 */
import { asElementId, elementsOfKind, type BimElement, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { BUILTIN_SPACE_USES, SPACE_USE_LIBRARY_ID, SPACE_USE_RATE_TARGETS, spaceUseCatalog } from "@permitzip/bim-library";
import { pinnedUseForCommand, pinSpaceUse } from "@permitzip/bim-calc";
import { VentilationEngine } from "@permitzip/bim-pack-mechanical";
import { executeSpaceDesignCommand } from "../../../packages/bim-kernel/src/spaces/space-commands";
import { advanceSpaceIndex } from "../../../packages/bim-kernel/src/spaces/space-index";

import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const dining = BUILTIN_SPACE_USES.find((u) => u.id === "restaurant_dining");
if (!dining) throw new Error("restaurant_dining space use missing from the built-in library");
const pinned = pinSpaceUse(SPACE_USE_LIBRARY_ID, dining, SPACE_USE_RATE_TARGETS);
if (typeof pinned === "string") throw new Error(pinned);
const pinnedUse = pinnedUseForCommand(pinned);
const uses = spaceUseCatalog().catalog;

function buildTower(): { model: ModelState; spaces: ElementId[] } {
  let model = createFullBimModel({ floors: 14, zonesPerFloor: 2, rooms: { cols: 8, rows: 9 }, modelId: "synthetic-tower-14-ventilation" });
  const names = [...new Set(elementsOfKind(model.elements, "room").map((r) => r.partition?.level).filter((n): n is string => !!n))];
  const elements: Record<string, BimElement> = { ...model.elements };
  names.forEach((name, i) => {
    const id = asElementId(`lvl-${name}`);
    elements[id] = { id, kind: "level", version: 1, authoredRev: {}, name, elevationMm: i * 4000 };
  });
  model = { ...model, elements };
  for (const level of elementsOfKind(model.elements, "level")) {
    const r = executeSpaceDesignCommand(model, { type: "make_spaces_from_rooms", levelId: level.id, use: pinnedUse });
    if (!r.ok) {
      if (/no rooms|already has/i.test(r.error.message)) continue;
      throw new Error(`make_spaces_from_rooms on ${level.name}: ${r.error.message}`);
    }
    model = r.model;
  }
  return { model, spaces: elementsOfKind(model.elements, "space").map((s) => s.id) };
}

const cold: number[] = [];
const advance: number[] = [];
const edit: number[] = [];
const level: number[] = [];
let counts = { spaces: 0, elements: 0, coldEvaluations: 0, reevaluatedOnEdit: 0, recomputed: 0, editTableEvaluations: 0 };

for (let i = 0; i < samples; i++) {
  const { model, spaces } = buildTower();
  const engine = new VentilationEngine({ uses });
  cold.push(time(() => engine.table(model.elements, { kind: "model" })));
  const coldEvaluations = engine.evaluations;

  const target = spaces[Math.floor(spaces.length / 2)] as ElementId;
  const s = model.elements[target];
  if (s?.kind !== "space" || !s.levelId) throw new Error("space missing");
  const r = executeSpaceDesignCommand(model, { type: "edit_space", spaceId: target, occupants: 55 });
  if (!r.ok) throw new Error(r.error.message);
  advanceSpaceIndex(model.elements, r.model.elements, r.changedIds, r.removedIds);
  const before = engine.evaluations;
  let recomputed = 0;
  advance.push(time(() => { recomputed = engine.advance(r.model.elements, r.changedIds).recomputed.length; }));
  const afterAdvance = engine.evaluations;
  edit.push(time(() => engine.table(r.model.elements, { kind: "model" })));
  const levelId = s.levelId;
  level.push(time(() => engine.table(r.model.elements, { kind: "level", levelId })));
  counts = { spaces: spaces.length, elements: Object.keys(r.model.elements).length, coldEvaluations, reevaluatedOnEdit: afterAdvance - before, recomputed, editTableEvaluations: engine.evaluations - afterAdvance };
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(
  `${JSON.stringify({ suite: "ventilation", metrics: { "ventilation.table.2k.cold": row(cold), "ventilation.advance.one_edit": row(advance), "ventilation.table.2k.edit": row(edit), "ventilation.level_table": row(level) }, counts }, null, 2)}\n`,
);
const c = { totalElements: counts.elements, affectedElements: counts.reevaluatedOnEdit };
emit({
  suite: "batch",
  workload: { spaces: "2k on the synthetic tower", samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: "ventilation.table.2k.cold", values: cold, counts: c, note: "Whole-model ventilation table, nothing kept: every space under IMC and ASHRAE 62.1." },
    { metric: "ventilation.advance.one_edit", values: advance, counts: c, note: "Advance by one edited space's id (its occupants changed)." },
    { metric: "ventilation.table.2k.edit", values: edit, counts: c, note: "Whole-model table after the edit: 1,999 kept results, the edited one re-evaluated by advance." },
    { metric: "ventilation.level_table", values: level, counts: c, note: "One level's table, warm: what the Ventilation panel reads per render." },
  ],
});
