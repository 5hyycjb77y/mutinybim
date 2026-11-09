import { canonicalize, sha256HexOf } from "../authorship/canonical";
import type { QuantityDelta } from "../graph/types";
import type { ElementCoverage, Responsibility } from "../responsibility/types";
import { CHANGE_ORDER_STATUSES, CHANGE_WORDS, type ChangeOrderStatus, type ChangeTarget } from "./types";

/** Tolerant reader: a status this release doesn't know is kept for display but allows no action. */
export function readChangeOrderStatus(value: unknown): ChangeOrderStatus | null {
  return CHANGE_ORDER_STATUSES.find((s) => s === value) ?? null;
}

/** Who acts on a change order in each state. */
export type ChangeOrderActor = "opener" | "addressee";

interface Move {
  readonly to: ChangeOrderStatus;
  readonly by: ChangeOrderActor;
  readonly needsReason: boolean;
}

const MOVES: Readonly<Record<ChangeOrderStatus, readonly Move[]>> = {
  draft: [{ to: "sent", by: "opener", needsReason: false }],
  sent: [
    { to: "accepted", by: "addressee", needsReason: true },
    { to: "refused", by: "addressee", needsReason: true },
    { to: "no_cost", by: "addressee", needsReason: true },
  ],
  accepted: [],
  refused: [],
  no_cost: [],
};

/** The moves the given actor has from `from` (empty for an unknown status). */
export function changeOrderMoves(from: ChangeOrderStatus | null, actor: ChangeOrderActor): readonly ChangeOrderStatus[] {
  if (from === null) return [];
  return MOVES[from].filter((m) => m.by === actor).map((m) => m.to);
}

/** Null when the move is allowed; otherwise why not, in words. */
export function changeOrderMoveProblem(input: {
  readonly from: ChangeOrderStatus | null;
  readonly to: ChangeOrderStatus;
  readonly actor: ChangeOrderActor | null;
  readonly reason?: string | null;
}): string | null {
  if (input.from === null) return "This change order is in a state this release doesn't know, so it can't be changed here.";
  const move = MOVES[input.from].find((m) => m.to === input.to);
  if (!move) return input.from === "draft" ? "Send the change order first; then the party it's addressed to answers it." : "This change order is already answered.";
  if (input.actor !== move.by) return move.by === "addressee" ? CHANGE_WORDS.onlyAddressee : "Only the person who opened this change order can send it.";
  if (move.needsReason && (input.reason ?? "").trim().length === 0) return CHANGE_WORDS.reasonRequired;
  return null;
}

/**
 * The responsibilities a person may classify a change under: their own
 * accepted rows that cover at least one changed element (as coverage, the
 * part's own scoped rows, else the discipline's unscoped rows). A project
 * lead fallback never classifies: significance is a professional's call.
 */
export function classifyingResponsibilities(coverage: readonly ElementCoverage[], personRef: string): Responsibility[] {
  const out = new Map<string, Responsibility>();
  for (const c of coverage) {
    for (const r of c.covering) {
      if (r.party.kind === "person" && r.party.ref === personRef && r.acceptedAt !== undefined) out.set(r.id, r);
    }
  }
  return [...out.values()].sort((a, b) => a.discipline.localeCompare(b.discipline) || a.id.localeCompare(b.id));
}

/** Null when this person may classify the change; otherwise who can, in words. */
export function classifyProblem(coverage: readonly ElementCoverage[], personRef: string): string | null {
  if (coverage.length === 0) return "Nothing changed in this range, so there is nothing to classify.";
  return classifyingResponsibilities(coverage, personRef).length > 0 ? null : CHANGE_WORDS.noResponsibility;
}

/** A stable key for "newest classification per target". */
export function changeTargetKey(target: ChangeTarget): string {
  return target.kind === "version_range" ? `range:${target.modelId}:${target.fromRevision}:${target.toRevision}` : `branch:${target.modelId}:${target.branchId}`;
}

/** `sha256:<hex>` over the canonical JSON of the deltas (sorted by group, then measure). What a classifier or answerer saw. */
export function deltaDigest(deltas: readonly QuantityDelta[]): string {
  const rows = [...deltas]
    .map((d) => ({ measure: d.measure, group: d.group, delta: d.delta, unit: d.unit }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.measure.localeCompare(b.measure));
  return `sha256:${sha256HexOf(canonicalize(rows))}`;
}
