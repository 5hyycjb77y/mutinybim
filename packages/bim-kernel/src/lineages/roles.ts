import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { LINEAGE_CAPABILITIES, LINEAGE_RETURN_POLICIES, type LineageCapability, type LineageReturnPolicy, type LineageRoleId } from "./types";

/**
 * Lineage roles (contract 1.9.0, `kernel.lineage_role` v1): what a copy is
 * for. A row says what it is called, what may go back from it by default,
 * who may read it, and what the parent's responsible professionals hold on
 * it before anyone grants them more. There is no depth limit and no limit on
 * which role may be a parent (product owner answer 2): any lineage can be a parent.
 */

/**
 * Who reads a copy beyond its creator and named editors:
 * - `parent_readers`: everyone who reads its parent (the default);
 * - `named_only`: only its creator, owner party, named people and the parent's responsible professionals.
 * Open: a host may add its own; an unknown one reads as `named_only` (never wider).
 */
export type LineageReadRestriction = "parent_readers" | "named_only" | (string & {});

export interface LineageRoleDef {
  /** `<pack>.<name>` for an add-on's or firm's row; the nine first-party ids are bare. */
  readonly id: LineageRoleId;
  readonly label: string;
  readonly description: string;
  readonly defaultReturnPolicy: LineageReturnPolicy;
  readonly read: LineageReadRestriction;
  /**
   * What the parent's responsible professionals (whose accepted scope covers
   * what the copy changes) hold on it by default, and what its owner may
   * raise them to on the grant. The engineer of record on a contractor's
   * copy: propose (and review) by default, edit when the owner grants it.
   */
  readonly parentResponsible: { readonly holds: readonly LineageCapability[]; readonly ownerMayRaiseTo?: readonly LineageCapability[] };
}

const RESPONSIBLE_ON_CONTRACTOR_COPY = { holds: ["read", "propose", "review"], ownerMayRaiseTo: ["edit"] } as const satisfies LineageRoleDef["parentResponsible"];
const RESPONSIBLE_ON_OWN_COPY = { holds: ["read", "propose", "review"] } as const satisfies LineageRoleDef["parentResponsible"];

/** The nine first-party roles, in the order a picker lists them. */
export const BUILT_IN_LINEAGE_ROLES: readonly LineageRoleDef[] = Object.freeze([
  { id: "design_record", label: "Design record", description: "The design the firm issues and stamps.", defaultReturnPolicy: "never", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_OWN_COPY },
  { id: "option", label: "Option", description: "Another way to do it, compared side by side; one may be merged.", defaultReturnPolicy: "merge", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_OWN_COPY },
  { id: "proposal", label: "Proposal", description: "Changes proposed on a copy and merged when approved. Today's branches are proposals.", defaultReturnPolicy: "merge", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_OWN_COPY },
  { id: "coordination", label: "Coordination", description: "Trades and the builder coordinate here; chosen parts are accepted back.", defaultReturnPolicy: "accept_back", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_CONTRACTOR_COPY },
  { id: "shop", label: "Shop drawings", description: "A fabricator's or contractor's copy, reviewed and never merged; chosen parts may be accepted back.", defaultReturnPolicy: "accept_back", read: "named_only", parentResponsible: RESPONSIBLE_ON_CONTRACTOR_COPY },
  { id: "submittal", label: "Submittal", description: "What a contractor submits for review; a difference approved and not accepted back is a substitution.", defaultReturnPolicy: "accept_back", read: "named_only", parentResponsible: RESPONSIBLE_ON_CONTRACTOR_COPY },
  { id: "external_author", label: "Outside author's model", description: "Another firm's model, kept as they issue it; proposals go back as a reviewed delta.", defaultReturnPolicy: "accept_back", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_CONTRACTOR_COPY },
  { id: "as_built", label: "As built", description: "What was built, recorded during construction. Nothing goes back to the design.", defaultReturnPolicy: "never", read: "parent_readers", parentResponsible: RESPONSIBLE_ON_OWN_COPY },
  { id: "operations", label: "Operations record", description: "The building as it is run and maintained, for decades. Nothing goes back.", defaultReturnPolicy: "never", read: "named_only", parentResponsible: RESPONSIBLE_ON_OWN_COPY },
]);

export const LINEAGE_ROLE_POINT = defineExtensionPoint<LineageRoleDef>({
  id: "kernel.lineage_role",
  version: 1,
  label: "Copy purposes",
  idOf: (r) => r.id,
  builtins: () => BUILT_IN_LINEAGE_ROLES,
});

const ROLE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(LINEAGE_CAPABILITIES);

/** Problems with a contributed role, in words (empty: fine). Used by pack conformance. */
export function lineageRoleProblems(def: LineageRoleDef): string[] {
  const out: string[] = [];
  if (!ROLE_ID.test(def.id)) out.push(`copy purpose id "${def.id}" must be lower case words joined by _ (an add-on's start with its namespace and a dot)`);
  if (def.label.trim().length === 0) out.push(`copy purpose ${def.id}: label is empty`);
  if (def.description.trim().length === 0) out.push(`copy purpose ${def.id}: description is empty`);
  if (!LINEAGE_RETURN_POLICIES.includes(def.defaultReturnPolicy)) out.push(`copy purpose ${def.id}: "${def.defaultReturnPolicy}" isn't a return policy (${LINEAGE_RETURN_POLICIES.join(", ")})`);
  for (const c of [...def.parentResponsible.holds, ...(def.parentResponsible.ownerMayRaiseTo ?? [])]) {
    if (!KNOWN_CAPABILITIES.has(c)) out.push(`copy purpose ${def.id}: "${c}" isn't a capability on a copy (${LINEAGE_CAPABILITIES.join(", ")})`);
  }
  return out;
}

/** Roles available on a model: built-ins, then the set's contributions. */
export function lineageRoles(set: PackSet = activePackSet()): readonly LineageRoleDef[] {
  return set.items(LINEAGE_ROLE_POINT);
}

export function lineageRole(id: string, set: PackSet = activePackSet()): LineageRoleDef | null {
  return lineageRoles(set).find((r) => r.id === id) ?? null;
}

/** How a stored role reads. An unknown id is kept and named, never shown as another role. */
export function lineageRoleWords(id: string, set: PackSet = activePackSet()): string {
  return lineageRole(id, set)?.label ?? `Copy for "${id}" (from an add-on this model doesn't have)`;
}
