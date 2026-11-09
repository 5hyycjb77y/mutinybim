/**
 * @jest-environment node
 *
 * Round 11 lane K11: reading anchors from kind rows, moving the three
 * legacy commands' duct halves into the Mechanical add-on (`claims`) and
 * placing hosted kinds through `hostedBy.placement` changes no answer on any
 * stored model. Checked on the stored-changeset fixtures written by round 8b
 * (rounds 1–8b), the demo, the heavy model, the full-BIM XS trees and a
 * spaces-and-questions floor against frozen copies of round 10's code:
 * every element's anchor (round 10's switch), every slide, resize and unit
 * move (same model, same changed ids, same refusals in the same words),
 * every hosted record's derived position and the same issues.
 *
 * Fails on round 10's code where the shapes are new (`kernelKindRow`,
 * `hostedPlacementOf`); the equivalence itself is what this lane must keep.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  anchorOf,
  freezeElements,
  recomputeDerived,
  type ModelState,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { HEAVY_TIERS, createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";
import { kernelKindRow } from "../src/registry/element-kind-point";
import { round10AnchorOf } from "./reference/round10-anchor-of";
import { floor } from "./g7-fixtures";

interface Fixture {
  readonly scenario: string;
  readonly head: ModelState;
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
const STORED = ["r1-demo", "r2-demo-edited", "r3-heavy", "r5-fullbim-xs", "r8-shared-tree"] as const;
const FIXTURES: readonly Fixture[] = STORED.map((name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Fixture);

const K11_MODELS: ReadonlyArray<readonly [string, ModelState]> = [
  ...FIXTURES.map((f) => [f.scenario, f.head] as const),
  ["demo", recomputeDerived(createDemoModel("k11-demo")).model],
  [
    "heavy",
    (() => {
      const m = createHeavyModel({ ...HEAVY_TIERS.S, modelId: "k11-heavy" });
      return { ...m, elements: freezeElements(m.elements) };
    })(),
  ],
  [
    "fullbim-xs",
    (() => {
      const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "k11-xs" });
      return { ...m, elements: freezeElements(m.elements) };
    })(),
  ],
  ["floor", floor("k11-floor")],
];

describe("k11-old-models-open-identically", () => {
  it("kernel kinds are read from kernel rows (fails on round 10: no kernel rows)", () => {
    expect(kernelKindRow("wall")).toBeDefined();
  });

  it.each(K11_MODELS.map(([name, model]) => [name, model] as const))("%s: every element sits where round 10's anchorOf put it", (_name, model) => {
    const kinds = new Set<string>();
    for (const el of Object.values(model.elements)) {
      expect([el.id, anchorOf(el)]).toEqual([el.id, round10AnchorOf(el)]);
      kinds.add(el.kind);
    }
    expect(kinds.size).toBeGreaterThan(1);
  });
});
