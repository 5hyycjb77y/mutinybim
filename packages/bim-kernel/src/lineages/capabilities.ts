import { coveringResponsibilities, type CoverageContext, type Responsibility } from "../responsibility/types";
import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import type { BimElement } from "../types";
import { lineageRole, type LineageRoleDef } from "./roles";
import type { Lineage, LineageCapability } from "./types";

/**
 * What someone holds on a lineage, as role-row defaults (D1, product owner answer 2).
 * Shape and defaults only: the authorizer (W11) enforces them and stores
 * grants. Nobody on a child can write its parent; that is the authorizer's
 * rule over these capabilities, never a capability here.
 */

/** How a person stands to a lineage, as the host knows it. */
export type LineageRelation =
  /** Made the copy. */
  | "creator"
  /** Named by the creator or owner as an editor. */
  | "named_editor"
  /** Reads the parent; may copy it to propose (anyone who can read a copy may copy it). */
  | "parent_reader"
  /** A responsible professional on the parent whose accepted scope covers what the copy changes (the engineer of record on a contractor's copy). */
  | "parent_responsible"
  | (string & {});

/** A capability the copy's owner granted beyond the default (W11 stores it; one setting on the grant). */
export interface LineageGrantRaise {
  readonly capability: LineageCapability;
}

/** The role's row, or the most restrictive reading for a role this release doesn't know. */
function roleOf(lineage: Pick<Lineage, "role">, set: PackSet): Pick<LineageRoleDef, "read" | "parentResponsible"> {
  return lineageRole(lineage.role, set) ?? { read: "named_only", parentResponsible: { holds: ["read", "propose"] } };
}

/**
 * The capabilities a relation holds on a lineage by default, plus any raise
 * its owner granted that the role allows. A relation this release doesn't
 * know holds nothing.
 */
export function lineageCapabilitiesFor(lineage: Pick<Lineage, "role" | "state">, relation: LineageRelation, raises: readonly LineageGrantRaise[] = [], set: PackSet = activePackSet()): readonly LineageCapability[] {
  const role = roleOf(lineage, set);
  const out = new Set<LineageCapability>();
  switch (relation) {
    case "creator":
    case "named_editor":
      for (const c of ["read", "propose", "edit"] as const) out.add(c);
      break;
    case "parent_reader":
      if (role.read === "parent_readers") for (const c of ["read", "propose"] as const) out.add(c);
      break;
    case "parent_responsible": {
      for (const c of role.parentResponsible.holds) out.add(c);
      const allowed = new Set<string>(role.parentResponsible.ownerMayRaiseTo ?? []);
      for (const r of raises) if (allowed.has(r.capability)) out.add(r.capability);
      break;
    }
    default:
      break;
  }
  // A copy that is no longer open is read only, whoever holds it.
  if (lineage.state !== "open") for (const c of [...out]) if (c !== "read") out.delete(c);
  return [...out];
}

/**
 * The parent's responsible professionals for a copy's changes: accepted
 * responsibilities whose scope covers any record the copy changed (each
 * record as the copy has it, or as it was when the copy removed it).
 */
export function responsibleForCopy(changed: readonly BimElement[], responsibilities: readonly Responsibility[], context: CoverageContext): readonly Responsibility[] {
  const byId = new Map<string, Responsibility>();
  for (const c of coveringResponsibilities(changed, responsibilities, context)) for (const r of c.covering) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
