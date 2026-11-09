import { lineageCapabilitiesFor, lineageRole, LineageError, LINEAGE_WORDS, type Lineage, type LineageCapability, type LineageGrantRaise, type LineageRelation } from "@permitzip/bim-kernel/lineages";

/**
 * Who may do what on which copy (round 11 lane W11, D1, product decision answer 2).
 *
 * The host answers two things about a verified person: what they may do on
 * the model's project (`ModelCapability`, the first copy's rights), and the
 * grants named on copies (`LineageGrantRecord`). The model server holds the
 * copies themselves (their parent, purpose, creator). This rule combines them
 * down the parent chain, any depth, one code path:
 *
 * - the first copy (the design): read with project read, edit with project edit;
 * - a copy: its creator and the people named as editors edit it; people named
 *   to read or review it hold that; everyone who reads its parent reads it
 *   (and may copy it) unless its purpose restricts reading to named people;
 *   the parent's responsible professionals whose scope covers what the copy
 *   changes hold what the purpose gives them (propose, review), raised to edit
 *   only by an edit grant the purpose allows;
 * - a round 8b branch row (no copy row of its own) keeps its rule: whoever
 *   edits its parent edits it;
 * - a copy that is no longer open is read only.
 *
 * Nothing here gives a right on an ancestor from a right on a child: edit on
 * a copy never reaches its parent. The three acts are checked against the
 * target's own rights (`canAct`).
 */

/** Who edits a copy besides its creator and named people. Stored with the copy row; a branch row with none reads `parent_editors`. */
export type LineageEditScope = "named" | "parent_editors";

/** A copy as the model server stores it: the kernel's lineage and who edits it. */
export interface LineageRow {
  readonly lineage: Lineage;
  readonly editScope: LineageEditScope;
}

/**
 * A capability named for one person on one copy (a host's own grant records,
 * or standalone `bim.lineage_members`).
 *
 * `userId` absent: the person asked about. `grantedBy` absent: the host vouches
 * for the grant (a standalone host's members). `grantedBy` present: the host
 * only recorded who granted it (a host can't know who made a copy; the model
 * server does), so the grant counts only when it traces back to the copy's
 * creator through edit grants (`honoredGrants`).
 */
export interface LineageGrantRecord {
  readonly lineageId: string;
  readonly capability: LineageCapability;
  readonly userId?: string;
  readonly grantedBy?: string;
}

/**
 * The person's grants that count on each copy of the chain: vouched-for ones,
 * and recorded ones whose granter is the copy's creator or holds an edit grant
 * that itself counts (any length of hand-offs, no self-grants).
 */
export function honoredGrants(chain: readonly LineageRow[], grants: readonly LineageGrantRecord[], userId: string): LineageGrantRecord[] {
  const out: LineageGrantRecord[] = [];
  for (const { lineage } of chain) {
    const on = grants.filter((g) => g.lineageId === lineage.id);
    if (on.length === 0) continue;
    const trusted = new Set<string>([lineage.createdBy.subject]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const g of on) {
        if (g.capability !== "edit" || g.grantedBy === undefined || g.userId === undefined || trusted.has(g.userId)) continue;
        if (g.grantedBy !== g.userId && trusted.has(g.grantedBy)) {
          trusted.add(g.userId);
          grew = true;
        }
      }
    }
    for (const g of on) {
      if (g.userId !== undefined && g.userId !== userId) continue;
      if (g.grantedBy === undefined || (g.grantedBy !== userId && trusted.has(g.grantedBy))) out.push(g);
    }
  }
  return out;
}

/** The project-level capabilities that feed the first copy's rights (`ModelCapability` without the import cycle). */
export interface ModelRights {
  readonly read: boolean;
  readonly edit: boolean;
}

export interface LineageRightsInput {
  readonly userId: string;
  readonly model: ModelRights;
  /** Nearest first, ending at the model's first copy (`lineageChain` order). */
  readonly chain: readonly LineageRow[];
  /** The person's live grants on this model's copies (any copies; only the chain's are read). */
  readonly grants: readonly LineageGrantRecord[];
  /** Copies whose changes the person's accepted responsibility on the parent covers (the engineer of record). */
  readonly responsibleOn?: ReadonlySet<string>;
}

export type LineageRights = ReadonlyMap<string, ReadonlySet<LineageCapability>>;

const NONE: ReadonlySet<LineageCapability> = new Set();

function relationsFromGrants(grants: readonly LineageCapability[]): { relations: LineageRelation[]; direct: LineageCapability[] } {
  const relations: LineageRelation[] = [];
  const direct: LineageCapability[] = [];
  for (const g of grants) {
    if (g === "edit") relations.push("named_editor");
    else direct.push(g);
  }
  return { relations, direct };
}

/**
 * Each copy of the chain mapped to what the person holds on it. Throws
 * LineageError when the chain is empty or doesn't end at a first copy.
 */
export function lineageRights(input: LineageRightsInput): LineageRights {
  const last = input.chain[input.chain.length - 1];
  if (!last) throw new LineageError("A copy's rights need at least the copy itself.");
  if (last.lineage.parent !== null) throw new LineageError(LINEAGE_WORDS.brokenChain(last.lineage.id));
  const grantsOn = new Map<string, LineageCapability[]>();
  for (const g of honoredGrants(input.chain, input.grants, input.userId)) grantsOn.set(g.lineageId, [...(grantsOn.get(g.lineageId) ?? []), g.capability]);
  const out = new Map<string, ReadonlySet<LineageCapability>>();
  let parentRights: ReadonlySet<LineageCapability> | null = null;
  for (let i = input.chain.length - 1; i >= 0; i--) {
    const row = input.chain[i];
    if (!row) continue;
    const { lineage } = row;
    const caps = new Set<LineageCapability>();
    if (parentRights === null) {
      if (input.model.read) for (const c of ["read", "propose"] as const) caps.add(c);
      if (input.model.read && input.model.edit) caps.add("edit");
    } else {
      const named = grantsOn.get(lineage.id) ?? [];
      const { relations, direct } = relationsFromGrants(named);
      if (lineage.createdBy.subject === input.userId) relations.push("creator");
      if (parentRights.has("read")) relations.push("parent_reader");
      if (parentRights.has("read") && input.responsibleOn?.has(lineage.id)) relations.push("parent_responsible");
      const raises: LineageGrantRaise[] = named.map((capability) => ({ capability }));
      for (const relation of relations) for (const c of lineageCapabilitiesFor(lineage, relation, raises)) caps.add(c);
      // A named read / propose / review holds that and read; never more.
      for (const c of direct) {
        caps.add("read");
        caps.add(c);
      }
      if (row.editScope === "parent_editors" && parentRights.has("edit")) for (const c of ["read", "propose", "edit"] as const) caps.add(c);
      if (lineage.state !== "open") for (const c of [...caps]) if (c !== "read") caps.delete(c);
    }
    out.set(lineage.id, caps);
    parentRights = caps;
  }
  return out;
}

/** What the person holds on one copy of the rights map (none when it isn't there). */
export function rightsOn(rights: LineageRights, lineageId: string): ReadonlySet<LineageCapability> {
  return rights.get(lineageId) ?? NONE;
}

/** Whether a role restricts reading to named people (an unknown role does: never wider than written). */
export function readRestricted(lineage: Pick<Lineage, "role">): boolean {
  const role = lineageRole(lineage.role);
  return role ? role.read !== "parent_readers" : true;
}

/** Words for a refusal on a copy (no price, no blame; say what to do next). */
export const LINEAGE_RIGHTS_WORDS = {
  noRead: "This copy is shared only with the people named on it. Ask its owner to add you.",
  noEdit: "Only people named on this copy can edit it. Ask its owner to add you as an editor, or make your own copy of it to propose changes.",
  noEditOnAncestor: "You can view the design but not edit it. If you were named on a copy, open that copy to edit it; or make your own copy to propose changes.",
  noPropose: "You can view this copy but not copy it. Ask its owner for access.",
  noReview: "Only the people the copy is sent to for review can record a review on it.",
  noAcceptBack: "Only people who can edit the copy these records go back to can accept them back.",
} as const;

/**
 * Why a connection can't edit the copy it is on: the first copy (the design)
 * says where copy editors edit; a copy says who may. The rights map lists the
 * chain from the first copy down, so the first key is the first copy.
 */
export function readOnlyWords(rights: LineageRights, lineageId: string): string {
  const first = rights.keys().next().value;
  return first === lineageId ? LINEAGE_RIGHTS_WORDS.noEditOnAncestor : LINEAGE_RIGHTS_WORDS.noEdit;
}

/** The capability an act needs, and on which copy: review on the child; accept back and merge need edit on the target. */
export function canAct(rights: LineageRights, act: { readonly kind: "review"; readonly lineageId: string } | { readonly kind: "accept_back" | "merge"; readonly from: string; readonly to: string }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (act.kind === "review") return rightsOn(rights, act.lineageId).has("review") ? { ok: true } : { ok: false, reason: LINEAGE_RIGHTS_WORDS.noReview };
  if (!rightsOn(rights, act.from).has("read")) return { ok: false, reason: LINEAGE_RIGHTS_WORDS.noRead };
  return rightsOn(rights, act.to).has("edit") ? { ok: true } : { ok: false, reason: LINEAGE_RIGHTS_WORDS.noAcceptBack };
}
