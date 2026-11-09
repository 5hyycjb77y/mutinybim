import { registerSchemaStep, schemaSteps, stepAllowed, type SchemaStep } from "../schema-version/registry";
import type { BimElement } from "../types";
import { isCeiling } from "./read";
import { CEILINGS_FEATURE } from "./types";

/**
 * Expand, then contract (MIGRATION-PLAN §3). Every reader of this release
 * reads and keeps `ceiling` records; a writer stores one only when the model
 * server (and, on the server, every connected peer) advertises
 * `elements:ceilings`.
 *
 * The gate is a gated record step on ceilings, so it rides the schema-version
 * machinery: the feature joins `gatedRecordFeatures()` (every client and
 * server of this release advertises it) and `stepAllowed` answers under the
 * host's upgrade policy for the command being decided.
 *
 * Version 1 is a ceiling with no class (one written before ceilings were
 * classed, or by a tool that writes the bare shape). The step classes it as
 * the built-in `arch.ceiling` on the next edit that touches it, in the same
 * changeset, so undo puts the stored record back. Untouched records are never
 * rewritten.
 */

/** The built-in class every ceiling is recognised as (registry/builtin.ts). */
export const CEILING_CLASS_ID = "arch.ceiling";

export const CEILING_CLASS_STEP = "ceiling_class";

export function upgradeCeilingClass(record: BimElement): BimElement {
  if (!isCeiling(record) || record.classId !== undefined) return record;
  return { ...record, classId: CEILING_CLASS_ID, classSource: "recognised" };
}

export const CEILING_RECORD_STEP: SchemaStep = {
  kind: "ceiling",
  from: 1,
  to: 2,
  name: CEILING_CLASS_STEP,
  feature: CEILINGS_FEATURE,
  detect: (record) => isCeiling(record) && record.classId === undefined,
  upgrade: upgradeCeilingClass,
};

if (!schemaSteps("ceiling").some((s) => s.name === CEILING_CLASS_STEP)) registerSchemaStep(CEILING_RECORD_STEP);

/** Whether the command being decided may write ceiling records (the peers read them); false inside undo. */
export function ceilingsWritable(): boolean {
  return stepAllowed(CEILING_RECORD_STEP);
}

/** What a writer says when its peers don't store ceilings. */
export const CEILINGS_NOT_YET =
  "Ceilings can't be saved on this model yet: the model server it is open on is an older version that doesn't store them. Nothing changed; try again once the server is updated";
