/**
 * @jest-environment node
 *
 * Round 12 lane M12: moving Mechanical out of the kernel changes no answer
 * on any stored model. On K11's fixture set (the five round-8b stored
 * changesets, the demo, the heavy model, full-BIM XS and a spaces-and-
 * questions floor), these are byte-identical to round 11's output, frozen in
 * `fixtures/m12-round11-outputs.json`:
 *
 * - every element's anchor;
 * - the demo sheet (primitives, tags, schedule), and every view's scene
 *   (primitives and tags), so every drawing and tag the kernel draws;
 * - the auto-tag plan for every view (what each tag would say and where);
 * - what a click at each element's anchor picks in each plan view;
 * - every element's solid (3D and plan footprint), tag style and selection
 *   scopes.
 *
 * Frozen from round 11's committed tree (6eccc2969, extracted read-only and
 * run with its own kernel seeders; the same hashes as this file computes).
 * The move's later steps convert the drawing, tag and pick kind cases to
 * rows against it. Refresh only when a change is meant to alter output:
 * `M12_FREEZE=1 npx jest packages/bim-kernel/__tests__/m12-old-models-open-identically.test.ts`.
 *
 * Fails on round 11's code: nothing (it is the equivalence the move keeps);
 * it fails on any step of the move that changes a drawing, a tag or a pick.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AUTO_TAG_CATEGORIES,
  anchorOf,
  buildSheetScene,
  buildViewPickIndex,
  buildViewScene,
  canonicalJson,
  computeSelectionScopes,
  defaultTagStyleFor,
  demoSheetDefinition,
  freezeElements,
  pickAt,
  planAutoTags,
  recomputeDerived,
  type BimElement,
  type ModelState,
  type ViewElement,
} from "../src";
import { elementSolid } from "../src/drawing/solids";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { HEAVY_TIERS, createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";
import { floor } from "./g7-fixtures";

interface Fixture {
  readonly scenario: string;
  readonly head: ModelState;
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
const FROZEN = path.join(__dirname, "fixtures", "m12-round11-outputs.json");
const STORED = ["r1-demo", "r2-demo-edited", "r3-heavy", "r5-fullbim-xs", "r8-shared-tree"] as const;
const FIXTURES: readonly Fixture[] = STORED.map((name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Fixture);
const frozen = (m: ModelState): ModelState => ({ ...m, elements: freezeElements(m.elements) });

const MODELS: ReadonlyArray<readonly [string, () => ModelState]> = [
  ...FIXTURES.map((f) => [f.scenario, () => f.head] as const),
  ["demo", () => recomputeDerived(createDemoModel("m12-demo")).model],
  ["heavy", () => frozen(createHeavyModel({ ...HEAVY_TIERS.S, modelId: "m12-heavy" }))],
  ["fullbim-xs", () => frozen(createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "m12-xs" }))],
  ["floor", () => floor("m12-floor")],
];

const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 20);

/** A thrown refusal is an answer too: kept as its message so a changed refusal shows. */
function attempt<T>(fn: () => T): T | { readonly threw: string } {
  try {
    return fn();
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

function views(model: ModelState): ViewElement[] {
  return Object.values(model.elements)
    .filter((el): el is ViewElement => el.kind === "view" && !el.deleted)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function elements(model: ModelState): BimElement[] {
  return Object.values(model.elements).sort((a, b) => a.id.localeCompare(b.id));
}

/** One hash per output family, so a failure names what changed. */
function outputs(model: ModelState): Record<string, string> {
  const els = elements(model);
  const vs = views(model);
  const anchors = els.map((el) => [el.id, anchorOf(el)]);
  const sheet = attempt(() => buildSheetScene(model, demoSheetDefinition()));
  const viewScenes = vs.map((v) => [v.id, attempt(() => buildViewScene(model, v.id).scene)]);
  const autoTags = vs.map((v) => [v.id, attempt(() => planAutoTags(model, v.id, { categories: AUTO_TAG_CATEGORIES, idPrefix: "m12", skipTagged: false }))]);
  const picks = vs
    .filter((v) => v.viewType === "floor_plan" || v.viewType === "ceiling_plan")
    .map((v) => {
      const index = attempt(() => buildViewPickIndex(model, v));
      if ("threw" in index) return [v.id, index];
      return [v.id, anchors.map(([id, at]) => [id, at && typeof at === "object" && "x" in at ? pickAt(index, { x: at.x, y: at.y }, 50) : null])];
    });
  const solids = els.map((el) => [el.id, attempt(() => elementSolid(model, el, 0))]);
  const tagStyles = els.map((el) => [el.id, attempt(() => defaultTagStyleFor(model, el))]);
  const scopes = els.slice(0, 400).map((el) => [el.id, attempt(() => computeSelectionScopes(model, el.id))]);
  return {
    anchors: hash(anchors),
    sheet: hash(sheet),
    viewScenes: hash(viewScenes),
    autoTags: hash(autoTags),
    picks: hash(picks),
    solids: hash(solids),
    tagStyles: hash(tagStyles),
    scopes: hash(scopes),
  };
}

const freeze = process.env.M12_FREEZE === "1";
const expected: Record<string, Record<string, string>> = !freeze && existsSync(FROZEN) ? (JSON.parse(readFileSync(FROZEN, "utf8")) as Record<string, Record<string, string>>) : {};
const written: Record<string, Record<string, string>> = {};

afterAll(() => {
  if (freeze) writeFileSync(FROZEN, `${JSON.stringify(written, null, 2)}\n`);
});

describe("m12-old-models-open-identically", () => {
  it.each(MODELS.map(([name, build]) => [name, build] as const))("%s: anchors, drawings, tags, picks, solids and scopes are round 11's", (name, build) => {
    const got = outputs(build());
    if (freeze) {
      written[name] = got;
      return;
    }
    expect(got).toEqual(expected[name]);
  });
});
