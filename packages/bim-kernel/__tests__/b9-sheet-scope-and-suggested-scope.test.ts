/**
 * @jest-environment node
 *
 * Round 9 lane B9.
 *
 * - b9-sheet-scope-covers: a responsibility scoped to sheets covers what the
 *   views placed on those sheets show (the view's level, inside a plan's
 *   crop), and nothing else. Round 8b gave coverage no sheet membership
 *   (`sheetsOf` was always empty), so a sheet scope covered nothing.
 * - b9-suggested-scope: "Take responsibility for this" starts from the part's
 *   own levels and systems; too many values drop that selector (broader,
 *   never narrower than the part). No suggestion existed in 8b.
 */
import {
  asElementId,
  coveringResponsibilities,
  modelCoverageContext,
  partitionOf,
  sheetMembership,
  suggestedScopeFor,
  SUGGESTED_SCOPE_MAX,
  type BimElement,
  type ModelState,
  type Responsibility,
  type Sheet,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const BIG = 1e9;

function view(id: string, over: Partial<ViewElement> = {}): ViewElement {
  return { id: asElementId(id), version: 1, authoredRev: {}, kind: "view", name: id, viewType: "floor_plan", cropMin: { x: -BIG, y: -BIG }, cropMax: { x: BIG, y: BIG }, ...over };
}

function sheet(id: string, viewIds: readonly string[], over: Partial<Sheet> = {}): Sheet {
  return { id: asElementId(id), version: 1, authoredRev: {}, kind: "sheet", number: id, title: id, viewIds: viewIds.map(asElementId), ...over };
}

function withDocs(model: ModelState, docs: readonly BimElement[]): ModelState {
  const elements: Record<string, BimElement> = { ...model.elements };
  for (const d of docs) elements[d.id] = d;
  return { ...model, elements };
}

describe("b9-sheet-scope-covers", () => {
  const base = createDemoModel("b9-sheets");
  const model = withDocs(base, [
    view("v-all"),
    view("v-far", { cropMin: { x: BIG / 2, y: BIG / 2 }, cropMax: { x: BIG / 2 + 1, y: BIG / 2 + 1 } }),
    view("v-other-level", { props: { level: "Level 9" } }),
    view("v-schedule", { viewType: "schedule" }),
    view("v-gone", { deleted: true }),
    sheet("M-101", ["v-all"]),
    sheet("M-102", ["v-far"]),
    sheet("M-103", ["v-other-level", "v-schedule", "v-gone"]),
    sheet("M-104", ["v-all"], { deleted: true }),
  ]);
  const sd1 = model.elements["sd-1"];
  if (!sd1) throw new Error("sd-1");
  const discipline = partitionOf(sd1).discipline;
  const row = (id: string, sheets: readonly string[]): Responsibility => ({ id, party: { kind: "person", ref: "u-rao", label: "J. Rao" }, discipline, scope: { sheets }, acceptedAt: "2026-11-01T00:00:00Z" });

  it("an element appears on the sheets whose live views draw it: its level, inside a plan's crop", () => {
    const sheetsOf = sheetMembership(model);
    expect(sheetsOf(sd1)).toEqual(["M-101"]);
  });

  it("a sheet scope covers what its sheets show, through the model's coverage context", () => {
    const ctx = modelCoverageContext(model, { sheetsOf: sheetMembership(model) });
    const [onSheet] = coveringResponsibilities([sd1], [row("r-101", ["M-101"])], ctx);
    expect(onSheet?.covering.map((r) => r.id)).toEqual(["r-101"]);
    expect(onSheet?.fallback).toBeNull();
    const [offSheet] = coveringResponsibilities([sd1], [row("r-102", ["M-102"]), row("r-103", ["M-103"])], ctx);
    expect(offSheet?.covering).toEqual([]);
    // Without sheet membership (round 8b's merge context) the same row covered nothing.
    const [before] = coveringResponsibilities([sd1], [row("r-101", ["M-101"])], modelCoverageContext(model));
    expect(before?.covering).toEqual([]);
  });

  it("a model with no sheets: every element is on none", () => {
    expect(sheetMembership(base)(sd1)).toEqual([]);
  });
});

describe("b9-suggested-scope", () => {
  const base = createDemoModel("b9-suggest");
  const system = { id: asElementId("sys-sa"), version: 1, authoredRev: {}, kind: "mep_system", name: "SA-1", systemKind: "supply_air" } as unknown as BimElement;
  const model = withDocs(base, [system]);
  const ctx = modelCoverageContext(model);
  const sd1 = model.elements["sd-1"];
  const sd2 = model.elements["sd-2"];
  if (!sd1 || !sd2) throw new Error("terminals");
  const on = (el: BimElement, level: string, systemId?: string): BimElement => ({ ...el, partition: { ...partitionOf(el), level }, ...(systemId ? { systemId } : {}) }) as BimElement;

  it("the part's own levels and systems, in words", () => {
    const s = suggestedScopeFor([on(sd1, "Level 3", "sys-sa"), on(sd2, "Level 2", "sys-sa")], ctx, model);
    expect(s.scope).toEqual({ levels: ["Level 2", "Level 3"], systems: ["sys-sa"] });
    expect(s.words).toBe("Level 2 and Level 3; system SA-1");
  });

  it("more values than a person checks at a glance drops that selector (broader, never narrower)", () => {
    const many = Array.from({ length: SUGGESTED_SCOPE_MAX + 1 }, (_, i) => on(sd1, `Level ${i + 1}`));
    const s = suggestedScopeFor(many, ctx, model);
    expect(s.scope.levels).toBeUndefined();
  });

  it("nothing to narrow to: all of it", () => {
    expect(suggestedScopeFor([], ctx, model)).toEqual({ scope: {}, words: "all of it" });
  });
});
