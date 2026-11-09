import { registerSchemaStep, schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import { CONSTRUCTION_STAGES_FEATURE, QTO_CLASSIFICATION_FEATURE } from "./types";

/**
 * Expand, then contract (MIGRATION-PLAN §3). Every reader of this release
 * reads `classification` and `constructionStageId` and keeps
 * `construction_stage` records; a writer stores them only when the model
 * server (and, on the server, every connected peer) advertises
 * `qto:classification` / `construction:stages`.
 *
 * Each gate is a gated record step with no per-record upgrade (the
 * `view-category-overrides` precedent), so its feature joins
 * `gatedRecordFeatures()`: every client and server of this release
 * advertises it, and `stepAllowed` answers under the host's policy for the
 * command being decided. Nothing is rewritten or stamped on edit.
 */
export const QTO_CLASSIFICATION_STEP: SchemaStep = {
  kind: "element_type",
  from: 1,
  to: 2,
  name: "qto-classification",
  feature: QTO_CLASSIFICATION_FEATURE,
  detect: (record) => record.kind === "element_type" && record.classification === undefined,
};

export const CONSTRUCTION_STAGES_STEP: SchemaStep = {
  kind: "construction_stage",
  from: 1,
  to: 2,
  name: "construction-stages",
  feature: CONSTRUCTION_STAGES_FEATURE,
  detect: (record) => record.kind === "construction_stage" && record.schemaVersion === undefined,
};

for (const step of [QTO_CLASSIFICATION_STEP, CONSTRUCTION_STAGES_STEP]) {
  if (!schemaSteps(step.kind).some((s) => s.name === step.name)) registerSchemaStep(step);
}

/** Whether the command being decided may store classification codes (the peers read them). */
export function classificationWritable(): boolean {
  return stepAllowed(QTO_CLASSIFICATION_STEP);
}

/** Whether the command being decided may store construction stages and an element's stage. */
export function constructionStagesWritable(): boolean {
  return stepAllowed(CONSTRUCTION_STAGES_STEP);
}

/** The refusal tail when a peer is older (`elements/commands.ts` OLDER_SERVER wording). */
export const OLDER_PEER = "can't be saved yet: the model server this model is open on is an older version that doesn't store it. Try again once the server is updated";
