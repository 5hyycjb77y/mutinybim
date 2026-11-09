/**
 * Hover and pick in a plan and a section of the synthetic full-BIM model:
 * how long the pick index takes to build, to update after one edit, and how
 * long one hover (pickAt) takes. A hover runs on every pointer move, so it has
 * to fit in a fraction of one 60 Hz frame.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/view-pick.ts --tier=1M
 *
 * Budgets (reference laptop, 1M tier): hover p95 ≤ 4 ms; update after an edit
 * whose changed ids are known p95 ≤ 16 ms. Without the ids the update compares
 * every record, which is reported next to the 3D viewer's own per-edit
 * comparison (`changedElements`) for scale. Exits 1 when a budget fails.
 */
import {
  asElementId,
  buildViewPickIndex,
  pickAt,
  pickInBox,
  type BimElement,
  type ModelState,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { changedElements } from "../../../packages/bim-viewer-3d/src/native-geometry";
import { gc, percentile, round, timeSync } from "./lib";

const HOVER_P95_MS = 4;
/** One frame: the index catches up with an edit before the next repaint when the changed ids are known. */
const UPDATE_P95_MS = 16;

type Tier = keyof typeof FULL_BIM_TIERS;
const arg = process.argv.find((a) => a.startsWith("--tier="))?.slice(7) ?? "1M";
if (!(arg in FULL_BIM_TIERS)) throw new Error(`Unknown tier ${arg}; one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const tier = arg as Tier;

function planView(level: string, min: { x: number; y: number }, max: { x: number; y: number }): ViewElement {
  return { id: asElementId("perf-plan"), kind: "view", version: 1, authoredRev: {}, name: "Perf plan", viewType: "floor_plan", cropMin: min, cropMax: max, props: { level, scale: 96 } };
}

function sectionView(level: string, min: { x: number; y: number }, max: { x: number; y: number }): ViewElement {
  const y = (min.y + max.y) / 2;
  return {
    id: asElementId("perf-section"),
    kind: "view",
    version: 1,
    authoredRev: {},
    name: "Perf section",
    viewType: "section",
    cropMin: { x: 0, y: -2000 },
    cropMax: { x: max.x - min.x, y: 60_000 },
    props: { level, scale: 48, section: { start: { x: min.x, y }, end: { x: max.x, y }, direction: 1, depthMm: 6000 } },
  };
}

function hoverSamples(model: ModelState, view: ViewElement, n: number): { build: number; hover: number[]; box: number; footprints: number } {
  gc();
  const built = timeSync(() => buildViewPickIndex(model, view));
  const index = built.value;
  const w = index.window;
  const hover: number[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < n; i++) {
    const p = { x: w.min.x + rand() * (w.max.x - w.min.x), y: w.min.y + rand() * (w.max.y - w.min.y) };
    hover.push(timeSync(() => pickAt(index, p, 6 * 96 * 0.25)).ms);
  }
  const box = timeSync(() => pickInBox(index, w.min, { x: (w.min.x + w.max.x) / 2, y: (w.min.y + w.max.y) / 2 }, "crossing")).ms;
  return { build: built.ms, hover, box, footprints: index.footprints.size };
}

const made = timeSync(() => createFullBimModel(FULL_BIM_TIERS[tier]));
const model = made.value;
const total = Object.keys(model.elements).length;
const onLevel = Object.values(model.elements).filter((e: BimElement) => e.partition?.level === "L01");
const xs = onLevel.flatMap((e) => ("position" in e ? [e.position.x] : "start" in e ? [e.start.x, e.end.x] : []));
const ys = onLevel.flatMap((e) => ("position" in e ? [e.position.y] : "start" in e ? [e.start.y, e.end.y] : []));
const min = { x: Math.min(...xs), y: Math.min(...ys) };
const max = { x: Math.max(...xs), y: Math.max(...ys) };

const plan = planView("L01", min, max);
const planRun = hoverSamples(model, plan, 2000);
const section = sectionView("L01", min, max);
const sectionRun = hoverSamples(model, section, 2000);

// One edit: move one element on the level, then update the plan's index.
const before = buildViewPickIndex(model, plan);
const target = onLevel.find((e) => e.kind === "column");
const updates: number[] = [];
const hinted: number[] = [];
const viewerDiff: number[] = [];
let current = model;
let previous = before;
for (let i = 0; i < 21 && target; i++) {
  const el = current.elements[target.id];
  if (!el || el.kind !== "column") break;
  const next: ModelState = { ...current, revision: (current.revision + 1) as ModelState["revision"], elements: { ...current.elements, [el.id]: { ...el, position: { x: el.position.x + 10, y: el.position.y } } } };
  viewerDiff.push(timeSync(() => changedElements(current, next)).ms);
  const t = timeSync(() => buildViewPickIndex(next, plan, previous));
  updates.push(t.ms);
  const moved: ModelState = { ...next, revision: (next.revision + 1) as ModelState["revision"], elements: { ...next.elements, [el.id]: { ...el, position: { x: el.position.x + 20, y: el.position.y } } } };
  const h = timeSync(() => buildViewPickIndex(moved, plan, t.value, [el.id]));
  hinted.push(h.ms);
  previous = h.value;
  current = moved;
}

const report = {
  tier,
  total,
  onLevel: onLevel.length,
  createModelMs: round(made.ms),
  plan: { footprints: planRun.footprints, buildMs: round(planRun.build), hoverP50: round(percentile(planRun.hover, 0.5) ?? 0, 3), hoverP95: round(percentile(planRun.hover, 0.95) ?? 0, 3), boxMs: round(planRun.box) },
  section: { footprints: sectionRun.footprints, buildMs: round(sectionRun.build), hoverP50: round(percentile(sectionRun.hover, 0.5) ?? 0, 3), hoverP95: round(percentile(sectionRun.hover, 0.95) ?? 0, 3), boxMs: round(sectionRun.box) },
  updateAfterEdit: { p50: round(percentile(updates, 0.5) ?? 0), p95: round(percentile(updates, 0.95) ?? 0) },
  updateWithChangedIds: { p50: round(percentile(hinted, 0.5) ?? 0, 3), p95: round(percentile(hinted, 0.95) ?? 0, 3) },
  viewerChangedElements: { p50: round(percentile(viewerDiff, 0.5) ?? 0), p95: round(percentile(viewerDiff, 0.95) ?? 0) },
  budgets: { hoverP95: HOVER_P95_MS, updateWithChangedIdsP95: UPDATE_P95_MS },
};
console.log(JSON.stringify(report, null, 2));
const failed = report.plan.hoverP95 > HOVER_P95_MS || report.section.hoverP95 > HOVER_P95_MS || report.updateWithChangedIds.p95 > UPDATE_P95_MS;
if (failed) {
  console.error("[view-pick] over budget");
  process.exit(1);
}
