import type { BimElement } from "../types";

/**
 * Per-kind record schema versions and the upgrades between them
 * (MIGRATION-PLAN §3, "Records"). A stored record without `schemaVersion`
 * reads as version 1, unless a step can tell its version from its shape
 * (`detect`, the drafting precedent: drafting records were never stamped).
 *
 * Upgrades run on edit, never in bulk: the command that touches a record
 * below the current version upgrades it inside the same batch, so the
 * changeset carries the upgraded record and undo puts the old one back.
 *
 * This module is a leaf: it imports types only, so modules that register
 * steps at load time never read a value through an import cycle.
 */
export interface SchemaStep {
  readonly kind: BimElement["kind"];
  readonly from: number;
  /** Always `from + 1`. */
  readonly to: number;
  readonly name: string;
  /**
   * Protocol feature every peer must advertise before this step may write
   * its shape (`packages/bim-sync/src/protocol-version.ts`). Null: every
   * deployed reader already reads the new shape, so it may always be written.
   */
  readonly feature: string | null;
  /** For records stored before stamping: whether this record is still at `from`. */
  readonly detect?: (record: BimElement) => boolean;
  /**
   * The upgrade of one record, pure. Absent: the owning module upgrades
   * inside its own command because the step rewrites several records at once
   * (drafting's rectangle into four joined lines, `annotation/drafting-migrations.ts`).
   */
  readonly upgrade?: (record: BimElement) => BimElement;
}

const steps = new Map<string, SchemaStep[]>();

/** Register one step at module load (startup). Throws on a gap or a duplicate: a broken chain must never ship. */
export function registerSchemaStep(step: SchemaStep): void {
  if (step.to !== step.from + 1) throw new Error(`[schema-version] ${step.kind} step "${step.name}" must go from ${step.from} to ${step.from + 1}, not ${step.to}`);
  const chain = steps.get(step.kind) ?? [];
  const existing = chain.find((s) => s.from === step.from);
  if (existing) {
    if (existing.name === step.name) return; // the same module loaded twice (test isolation)
    throw new Error(`[schema-version] ${step.kind} already has a step from ${step.from} ("${existing.name}"); "${step.name}" can't also be one`);
  }
  const expected = chain.length === 0 ? 1 : (chain[chain.length - 1]?.to ?? 1);
  if (step.from !== expected) throw new Error(`[schema-version] ${step.kind} step "${step.name}" starts at ${step.from}; the chain is at ${expected}`);
  steps.set(step.kind, [...chain, step]);
}

/** Remove a kind's steps (tests that register their own chain). */
export function unregisterSchemaSteps(kind: string): void {
  steps.delete(kind);
}

export function schemaSteps(kind: string): readonly SchemaStep[] {
  return steps.get(kind) ?? [];
}

/** Every gated step's feature. A peer whose kernel registered a step reads its shape, so it advertises these. */
export function gatedRecordFeatures(): string[] {
  const features: string[] = [];
  for (const chain of steps.values()) for (const s of chain) if (s.feature !== null) features.push(s.feature);
  return features;
}

/** The version new and upgraded records of this kind are written at. */
export function currentSchemaVersion(kind: string): number {
  const chain = steps.get(kind);
  return chain && chain.length > 0 ? (chain[chain.length - 1]?.to ?? 1) : 1;
}

/** The `schemaVersion` stamped on a stored record, if any. */
export function storedSchemaVersion(record: object): number | undefined {
  if (!("schemaVersion" in record)) return undefined;
  const v = record.schemaVersion;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined;
}

/** The schema version a stored record is at. */
export function schemaVersionOf(record: BimElement): number {
  const stamped = storedSchemaVersion(record);
  if (stamped !== undefined) return stamped;
  const chain = steps.get(record.kind);
  if (!chain || chain.length === 0) return 1;
  let detectable = 0;
  for (const s of chain) {
    if (!s.detect) continue;
    if (s.detect(record)) return s.from;
    detectable = s.to;
  }
  // Steps that can recognise an old record and none do: it is at least past them.
  return detectable > 0 ? detectable : 1;
}

/** Whether a peer advertises a feature. Supplied by the host for the command being decided. */
export type UpgradePolicy = (feature: string) => boolean;

/** No host said what its peers read: only ungated steps run. */
const UNGATED_ONLY: UpgradePolicy = () => false;
let activePolicy: UpgradePolicy = UNGATED_ONLY;
/** Inside `withoutUpgrades`: no step runs, gated or not. */
let suspended = false;

/**
 * Decide `fn` with `policy` answering which gated steps may write. The model
 * server passes "every connected peer advertises it"; a client passes "the
 * server advertised it", so its prediction matches what the server will store.
 */
export function withUpgradePolicy<T>(policy: UpgradePolicy, fn: () => T): T {
  const previous = activePolicy;
  activePolicy = policy;
  try {
    return fn();
  } finally {
    activePolicy = previous;
  }
}

/**
 * Decide `fn` with no upgrades at all. Undo restores the stored records
 * exactly, so the record it puts back is not upgraded again; the next edit
 * upgrades it.
 */
export function withoutUpgrades<T>(fn: () => T): T {
  const previous = suspended;
  suspended = true;
  try {
    return fn();
  } finally {
    suspended = previous;
  }
}

export function stepAllowed(step: SchemaStep): boolean {
  if (suspended) return false;
  return step.feature === null || activePolicy(step.feature);
}
