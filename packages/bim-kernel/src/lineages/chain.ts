import type { AuthorRef } from "../authorship/types";
import { lineageRole } from "./roles";
import type { PackSet } from "../packs/set";
import { activePackSet } from "../packs/scope";
import { LINEAGE_WORDS, LineageError, type Lineage, type LineageActKind, type LineageAnchor, type LineageReturnPolicy, type LineageRoleId } from "./types";

/**
 * The parent chain, of any depth, with one code path (product owner answer 2). A
 * lineage's line is its own changesets after its pin, then its parent's line
 * up to that pin, and so on to the first lineage. Nothing here compares an id
 * with the root's or counts depth: `l11-no-main-special-case` greps for it.
 */

/** Finds a lineage of the model by id. */
export type LineageLookup = (id: string) => Lineage | undefined;

export function lineageLookup(lineages: Iterable<Lineage>): LineageLookup {
  const byId = new Map<string, Lineage>();
  for (const l of lineages) byId.set(l.id, l);
  return (id) => byId.get(id);
}

/** One link of a chain: a lineage, and the revision of its line the link below forked from (null for the lineage the chain starts at). */
export interface LineageChainLink {
  readonly lineage: Lineage;
  readonly pinnedAt: number | null;
}

/**
 * The chain from `id` to its first lineage: `id` itself, its parent pinned at
 * the fork revision, the grandparent pinned at the parent's fork revision…
 * Throws LineageError for an unknown id, a missing parent or a cycle.
 */
export function lineageChain(lookup: LineageLookup, id: string): readonly LineageChainLink[] {
  const start = lookup(id);
  if (!start) throw new LineageError(LINEAGE_WORDS.unknownLineage(id));
  const links: LineageChainLink[] = [{ lineage: start, pinnedAt: null }];
  const seen = new Set<string>([start.id]);
  let at: Lineage = start;
  while (at.parent) {
    const parent = lookup(at.parent.lineageId);
    if (!parent) throw new LineageError(LINEAGE_WORDS.brokenChain(at.id));
    if (seen.has(parent.id)) throw new LineageError(LINEAGE_WORDS.cycle(start.id));
    seen.add(parent.id);
    links.push({ lineage: parent, pinnedAt: at.parent.revision });
    at = parent;
  }
  return links;
}

/** The ids of `id`'s ancestors, nearest first (not `id` itself). */
export function ancestorIds(lookup: LineageLookup, id: string): readonly string[] {
  return lineageChain(lookup, id)
    .slice(1)
    .map((l) => l.lineage.id);
}

/**
 * The anchor an act from `from` to `to` is computed against: `to` at the
 * revision `from`'s chain pins it. `to` absent: the parent. Throws when `to`
 * isn't an ancestor of `from`.
 */
export function ancestorAnchor(lookup: LineageLookup, from: string, to?: string): LineageAnchor {
  const chain = lineageChain(lookup, from);
  const target = to ?? chain[1]?.lineage.id;
  const link = target === undefined ? undefined : chain.slice(1).find((l) => l.lineage.id === target);
  if (!link || link.pinnedAt === null) throw new LineageError(LINEAGE_WORDS.notAncestor(from, to ?? "(no parent)"));
  return { lineageId: link.lineage.id, revision: link.pinnedAt };
}

/**
 * The nearest lineage both `a` and `b` descend from (either may be it), at
 * the lowest revision either chain pins it: the base of a three-way compare.
 * The same revision names the same state on both lines below that point.
 */
export function commonAncestor(lookup: LineageLookup, a: string, b: string): LineageAnchor {
  if (a === b) throw new LineageError(LINEAGE_WORDS.sameLineage(a));
  const chainA = lineageChain(lookup, a);
  const pinsB = new Map<string, number | null>(lineageChain(lookup, b).map((l) => [l.lineage.id, l.pinnedAt]));
  for (const link of chainA) {
    if (!pinsB.has(link.lineage.id)) continue;
    const pinB = pinsB.get(link.lineage.id) ?? null;
    const pins = [link.pinnedAt, pinB].filter((p): p is number => p !== null);
    const revision = Math.min(...pins);
    return { lineageId: link.lineage.id, revision };
  }
  throw new LineageError(LINEAGE_WORDS.noCommonAncestor(a, b));
}

/** A stretch of a lineage's line read from one lineage's own changesets: revisions in (from, to]. */
export interface LineageSegment {
  readonly lineageId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Which lineage's own changesets hold revisions (from, to] of `id`'s line,
 * oldest first (the order one store returns them). Each lineage owns the
 * revisions above the pin the link below it forked from; the first lineage
 * owns everything below.
 */
export function lineageSegments(chain: readonly { readonly lineage: Pick<Lineage, "id" | "parent"> }[], from: number, to: number): readonly LineageSegment[] {
  if (to <= from) return [];
  const out: LineageSegment[] = [];
  let upper = to;
  for (let i = 0; i < chain.length && upper > from; i++) {
    const link = chain[i];
    if (!link) break;
    const ownFloor = link.lineage.parent ? link.lineage.parent.revision : Number.NEGATIVE_INFINITY;
    const lower = Math.max(from, ownFloor);
    if (upper > lower) out.push({ lineageId: link.lineage.id, from: lower, to: upper });
    upper = Math.min(upper, lower);
  }
  return out.reverse();
}

/** Which acts a return policy allows. An unknown policy allows none (never wider than written). */
export function returnPolicyAllows(policy: LineageReturnPolicy | (string & {}), act: LineageActKind): boolean {
  switch (policy) {
    case "merge":
      return true;
    case "accept_back":
      return act === "review" || act === "accept_back";
    case "review_only":
      return act === "review";
    default:
      return false;
  }
}

/** Throws in words when `lineage`'s policy or state refuses `act`. */
export function assertActAllowed(lineage: Lineage, act: LineageActKind): void {
  if (lineage.state !== "open" && lineage.state !== "frozen") throw new LineageError(LINEAGE_WORDS.notOpen(lineage.name));
  if (!returnPolicyAllows(lineage.returnPolicy, act)) {
    const words = act === "accept_back" ? "accepted back" : act === "merge" ? "merged" : "reviewed";
    throw new LineageError(LINEAGE_WORDS.policyRefuses(lineage.name, words, lineage.returnPolicy));
  }
}

export interface ForkLineageInput {
  readonly id: string;
  readonly parent: Lineage;
  /** The parent's revision the copy starts from (its head, or a saved or issued version). */
  readonly revision: number;
  readonly parentHead: number;
  readonly role: LineageRoleId;
  readonly name: string;
  readonly createdBy: AuthorRef;
  readonly createdAt: string;
  /** Overrides the role's default. */
  readonly returnPolicy?: LineageReturnPolicy;
  readonly owner?: { readonly party: string };
  readonly terms?: { readonly disclaimerId?: string };
}

/**
 * A new lineage's record. Any lineage can be a parent, at any depth; anyone
 * who can read a copy may copy it (who reads is the authorizer's, W11). The
 * state itself is a pin: `forkState(parentHead, revision, parentLineChanges)`.
 */
export function forkLineage(input: ForkLineageInput, set: PackSet = activePackSet()): Lineage {
  if (!Number.isInteger(input.revision) || input.revision < 0 || input.revision > input.parentHead) throw new LineageError(LINEAGE_WORDS.forkTooNew(input.revision, input.parentHead));
  if (input.parent.state === "closed") throw new LineageError(LINEAGE_WORDS.notOpen(input.parent.name));
  const role = lineageRole(input.role, set);
  const returnPolicy = input.returnPolicy ?? role?.defaultReturnPolicy ?? "never";
  return {
    id: input.id,
    parent: { lineageId: input.parent.id, revision: input.revision },
    role: input.role,
    returnPolicy,
    state: "open",
    name: input.name,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    ...(input.owner ? { owner: input.owner } : {}),
    ...(input.terms ? { terms: input.terms } : {}),
  };
}
