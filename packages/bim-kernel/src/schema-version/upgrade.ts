import type { BimElement } from "../types";
import { currentSchemaVersion, schemaSteps, schemaVersionOf, stepAllowed } from "./registry";

/**
 * Quiet upgrade on edit (the product owner's decision 6): every record the command
 * touched that is below its kind's current version, and has per-record
 * steps the peers can read, is upgraded in the command's working copy. The
 * command's changeset then carries the upgraded record and undo restores the
 * stored one, in the same batch as the edit.
 *
 * Runs from `finish()` in command-core.ts (an edit hook, `edit-hook.ts`) on
 * the command's result, before re-deriving and validating: a step upgrades
 * the edited record, so commands keep reading both shapes during the expand
 * window (MIGRATION-PLAN §3, `readAs`). Kinds with no
 * registered steps are skipped at once and their records are never stamped,
 * so a model with nothing to upgrade writes exactly what it wrote before.
 *
 * Returns the ids it upgraded.
 */
export function upgradeOnEdit(working: Record<string, BimElement>, touched: Iterable<string>): string[] {
  const upgraded: string[] = [];
  for (const id of touched) {
    const stored = working[id];
    if (!stored) continue;
    const chain = schemaSteps(stored.kind);
    if (chain.length === 0) continue;
    const current = currentSchemaVersion(stored.kind);
    let record = stored;
    let version = schemaVersionOf(record);
    while (version < current) {
      const step = chain.find((s) => s.from === version);
      if (!step || !step.upgrade || !stepAllowed(step)) break;
      record = Object.assign({}, step.upgrade(record), { schemaVersion: step.to });
      version = step.to;
    }
    if (record !== stored) {
      working[id] = record;
      upgraded.push(id);
    }
  }
  return upgraded;
}
