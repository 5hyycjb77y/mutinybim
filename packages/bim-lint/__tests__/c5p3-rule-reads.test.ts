/**
 * @jest-environment node
 *
 * Batch 5c round 3 (S-10): a rule that reads another kind (`reads`) re-runs on
 * every element it lints when an edit changes that kind, so deleting a
 * footing re-flags its column even when the column isn't near the edit's
 * scope. On the old runner the column is only linted when it is in scope, so
 * the finding is missing until someone touches the column.
 */
import { asRevision, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { DEFAULT_LINT_CONFIG, LintEngine, type RuleDef } from "../src";

const base = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5p3-reads" });
const column = Object.values(base.elements).find((e) => e.kind === "column");
if (!column) throw new Error("the XS model has no column");
const footingId = `${column.id}-ftg`;
if (!base.elements[footingId]) throw new Error("the column has no footing");

function rule(reads: RuleDef["reads"]): RuleDef {
  return {
    id: "c5p3_column_on_footing",
    version: 1,
    pack: "coordination",
    severity: "warning",
    title: "A column bears on its footing",
    scope: "element",
    kinds: ["column"],
    ...(reads ? { reads } : {}),
    run: (ctx, el) => {
      if (ctx.model.elements[`${el.id}-ftg`]) return;
      ctx.emit({ rule: "c5p3_column_on_footing", severity: "warning", elementIds: [el.id], at: { level: ctx.levelNameOf(el), x_ft: 0, y_ft: 0, z_ft: 0 }, message: `${ctx.name(el.id)} bears on nothing` });
    },
  };
}

function afterDeletingFooting(r: RuleDef): string[] {
  const engine = new LintEngine([r]);
  engine.build(base);
  expect(engine.check({ config: DEFAULT_LINT_CONFIG })).toEqual([]);
  const { [footingId]: _gone, ...rest } = base.elements;
  const after: ModelState = { ...base, revision: asRevision(base.revision + 1), elements: rest as Record<string, BimElement> };
  engine.advance(after, [footingId]);
  // The deleted footing has no box any more: the edit's scope is the change alone, as an id-scoped check of a removal is.
  return engine.run({ box: null, documents: [], changed: [footingId] }, { config: DEFAULT_LINT_CONFIG, previous: base }).map((f) => f.elementIds.join(","));
}

describe("c5p3 S-10 lint rules that read other kinds", () => {
  it("with reads: deleting the footing re-flags the column", () => {
    expect(afterDeletingFooting(rule(["component"]))).toContain(column.id);
  });

  it("without reads (the old behaviour): the column outside the scope stays unflagged", () => {
    expect(afterDeletingFooting(rule(undefined))).toEqual([]);
  });
});
