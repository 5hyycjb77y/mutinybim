import { registerSchemaStep, schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import { CATEGORY_OVERRIDES_FEATURE } from "./types";

/**
 * Expand, then contract (MIGRATION-PLAN §3). Every reader of this release
 * reads `ViewProps.categoryOverrides`; a writer stores it only when the
 * model server (and, on the server, every connected peer) advertises
 * `graphics:category_overrides`.
 *
 * The gate is a gated record step on views, so it rides 5a's machinery: the
 * feature joins `gatedRecordFeatures()` (every client and server of this
 * release advertises it), and `stepAllowed` answers under the host's upgrade
 * policy for the command being decided. The step has no per-record upgrade:
 * views are never rewritten in bulk or stamped on edit; a view gains
 * `categoryOverrides` only when a person sets one.
 */
export const VIEW_CATEGORY_OVERRIDES_STEP: SchemaStep = {
  kind: "view",
  from: 1,
  to: 2,
  name: "view-category-overrides",
  feature: CATEGORY_OVERRIDES_FEATURE,
  detect: (record) => record.kind === "view" && record.props?.categoryOverrides === undefined,
};

if (!schemaSteps("view").some((s) => s.name === VIEW_CATEGORY_OVERRIDES_STEP.name)) registerSchemaStep(VIEW_CATEGORY_OVERRIDES_STEP);

/** Whether the command being decided may store per-category overrides (the peers read them). */
export function categoryOverridesWritable(): boolean {
  return stepAllowed(VIEW_CATEGORY_OVERRIDES_STEP);
}
