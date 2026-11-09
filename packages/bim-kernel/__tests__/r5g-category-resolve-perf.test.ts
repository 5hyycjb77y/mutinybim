/**
 * @jest-environment node
 *
 * `graphics.category_resolve.tower` (NEXT-BATCH §5): every element of the
 * tower-14 synthetic resolved to its look in one plan view. "before" is the
 * code this replaced (hiddenCategories / lineWeights / the part map, read
 * per element), measured on the same model, so the budget row starts from a
 * number taken before the change. Heavy (~140k elements): runs only with
 * R5G_PERF=1, through the one heavy slot (`/tmp/mutinybim-5b-run.sh`).
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { builtinRegistry, type BimElement, type ModelState, type PartCategory, type ViewCategory, type ViewElement, type ViewProps } from "../src";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { buildCategoryRegistry, elementLook, withCategoryRegistry } from "../src/categories";

const run = process.env.R5G_PERF === "1" ? describe : describe.skip;

const OLD_PART: Readonly<Partial<Record<PartCategory, ViewCategory>>> = { air_terminal: "air_terminal", duct_accessory: "duct_fitting", pipe_accessory: "pipe", electrical_device: "electrical_devices", lighting_fixture: "lighting_fixtures", electrical_equipment: "electrical_equipment" };
const OLD_KIND: Partial<Record<BimElement["kind"], ViewCategory>> = { duct_segment: "duct", elbow: "duct_fitting", tap: "duct_fitting", terminal: "air_terminal", equipment: "equipment", wall: "walls", opening: "doors_windows", room: "rooms", grid: "grids", column: "structure", beam: "structure", tag: "tags", dimension: "dimensions" };

function oldResolve(m: ModelState, view: Pick<ViewElement, "props">, el: BimElement): number {
  const run = el.kind === "run_segment" || el.kind === "run_fitting" ? (el.kind === "run_segment" ? (el.domain === "duct" ? "duct" : "pipe") : el.domain === "duct" ? "duct_fitting" : "pipe") : null;
  let c: ViewCategory | null = run ?? OLD_KIND[el.kind] ?? null;
  if (c === null && el.kind === "part") {
    const t = m.elements[el.typeId];
    if (t?.kind === "part_type") c = OLD_PART[t.definition.category] ?? "equipment";
  }
  const hidden = c !== null && (view.props?.hiddenCategories ?? []).includes(c);
  const pen = c ? view.props?.lineWeights?.[c]?.projection : undefined;
  return (hidden ? 1 : 0) + (pen ? 2 : 0);
}

function stats(ms: number[]): { p50: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  return { p50: Number((s[Math.floor(s.length * 0.5)] ?? 0).toFixed(2)), p95: Number((s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0).toFixed(2)) };
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

run("graphics.category_resolve.tower", () => {
  it("measures before (old path) and after (one resolver), cold and after one edit", () => {
    const tower = createFullBimModel({ floors: 14, zonesPerFloor: 2, modelId: "synthetic-tower-14" });
    const elements = Object.values(tower.elements);
    const legacy: ViewProps = { level: "Level 1", hiddenCategories: ["tags", "lighting_fixtures"], lineWeights: { duct: { projection: "wide" } } };
    const withOverrides: ViewProps = { ...legacy, categoryOverrides: { "mep.electrical_device": { halftone: true }, "service:sanitary": { pattern: "dashed" }, pipe: { lineWeights: { projection: "thin" } } } };
    const SAMPLES = 9;
    let sink = 0;
    const before: number[] = [];
    const afterLegacy: number[] = [];
    const afterOverridesCold: number[] = [];
    const afterOneEdit: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const v = { props: { ...legacy } };
      before.push(time(() => elements.forEach((el) => (sink += oldResolve(tower, v, el)))));
      const v2 = { props: { ...legacy } };
      afterLegacy.push(time(() => elements.forEach((el) => (sink += elementLook(tower, v2, el).visible ? 0 : 1))));
      // Cold: a fresh registry, so every element's class is recognized once.
      const reg = buildCategoryRegistry({ classes: builtinRegistry().extend().build() });
      const v3 = { props: { ...withOverrides } };
      afterOverridesCold.push(time(() => withCategoryRegistry(reg, () => elements.forEach((el) => (sink += elementLook(tower, v3, el).visible ? 0 : 1)))));
      // One edit: one element record replaced; everything else is cached by record and chain.
      const edited = elements.map((el, k) => (k === 1000 ? { ...el } : el));
      afterOneEdit.push(time(() => withCategoryRegistry(reg, () => edited.forEach((el) => (sink += elementLook(tower, v3, el).visible ? 0 : 1)))));
    }
    const report = { elements: elements.length, before: stats(before), afterLegacy: stats(afterLegacy), afterOverridesCold: stats(afterOverridesCold), afterOneEdit: stats(afterOneEdit) };
    // Jest's console is silenced in this repo's config; the numbers land in a file the person running it reads.
    writeFileSync(process.env.R5G_PERF_OUT ?? "/tmp/r5g-category-resolve-tower.json", JSON.stringify(report, null, 2));
    expect(sink).toBeGreaterThanOrEqual(0);
  });
});
