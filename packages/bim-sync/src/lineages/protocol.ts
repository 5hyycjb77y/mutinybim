import { z } from "zod";
import {
  branchModelId,
  type BranchRef,
} from "@permitzip/bim-kernel";
import {
  LINEAGES_ACCEPT_BACK_FEATURE,
  LINEAGES_REVIEW_FEATURE,
  LINEAGES_ROLES_FEATURE,
  REVIEW_OUTCOMES,
  type Lineage,
  type LineageAct,
  type LineageAnchor,
  type LineageDifference,
} from "@permitzip/bim-kernel/lineages";
import { STATE_AT_MAX_IDS } from "../branches/limits";
import { peerHas, type Protocol } from "../protocol-version";
import { LINEAGES_DELTA_FEATURE } from "./features";

/**
 * Lineage messages (round 11 lane L11, D1): copies with a purpose, the
 * overlay compare, review and accept back. A client sends one only when the
 * server's welcome advertised its feature; an older server never sees it
 * (`lineageRequestRefusal` answers in the "older server" words). An older
 * peer sees copies as branches (`lineagesForPeer`). Each feature stays
 * unadvertised until its server writer lands (W11).
 */

export { LINEAGES_ACCEPT_BACK_FEATURE, LINEAGES_REVIEW_FEATURE, LINEAGES_ROLES_FEATURE };

const requestId = z.string().min(1).max(100);
const revision = z.number().int().min(0);
const lineageId = z.string().min(1).max(64);
const recordIds = z.array(z.string().min(1).max(200)).min(1).max(STATE_AT_MAX_IDS);
const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const lineageClientMessageSchemas = [
  z.object({ type: z.literal("lineage_list"), requestId }),
  /** A copy of `from` (absent: this session's copy) at `fromRevision` (absent: its head), with a purpose. */
  z.object({
    type: z.literal("lineage_create"),
    requestId,
    name: z.string().trim().min(1).max(80),
    role: z.string().min(1).max(96),
    from: lineageId.optional(),
    fromRevision: revision.optional(),
    owner: z.object({ party: z.string().trim().min(1).max(200) }).strict().optional(),
    terms: z.object({ disclaimerId: z.string().min(1).max(100) }).strict().optional(),
  }),
  /** The overlay: two copies against their common ancestor. */
  z.object({ type: z.literal("lineage_compare"), requestId, a: lineageId, b: lineageId }),
  /** `to` absent: the copy's parent. `deltaDigest`: what the reviewer was shown. */
  z.object({ type: z.literal("lineage_review"), requestId, lineageId, to: lineageId.optional(), outcome: z.union([z.enum(REVIEW_OUTCOMES), z.string().min(1).max(64)]), reason: z.string().trim().max(2000).optional(), deltaDigest: digest }),
  z.object({ type: z.literal("lineage_accept_back"), requestId, from: lineageId, to: lineageId.optional(), recordIds, deltaDigest: digest }),
  /**
   * What a review or accept back of `lineageId` against `to` (absent: its parent) cites: the
   * records the copy changed since the anchor and their digest. `recordIds`: only these (an
   * accept back of some); `atRevision`: the copy's head the person looked at (a later head is
   * refused, so a changed copy is never signed for unseen).
   */
  z.object({ type: z.literal("lineage_delta"), requestId, lineageId, to: lineageId.optional(), recordIds: recordIds.optional(), atRevision: revision.optional() }),
] as const;

export type LineageClientMessage = z.infer<(typeof lineageClientMessageSchemas)[number]>;

export const LINEAGE_CLIENT_TYPES: ReadonlySet<string> = new Set(lineageClientMessageSchemas.map((s) => s.shape.type.value));

export function isLineageClientMessage(msg: { readonly type: string }): msg is LineageClientMessage {
  return LINEAGE_CLIENT_TYPES.has(msg.type);
}

export type LineageServerMessage =
  | { readonly type: "lineages"; readonly requestId: string; readonly lineages: readonly Lineage[] }
  | { readonly type: "lineage_saved"; readonly requestId: string; readonly lineage: Lineage }
  /** `truncated`: more differences than one answer carries; the screen says so and asks for fewer. */
  | { readonly type: "lineage_compare_result"; readonly requestId: string; readonly ancestor: LineageAnchor; readonly differences: readonly LineageDifference[]; readonly truncated: boolean }
  /** `seq`: the sign-off record's sequence; `revision`: the target's new revision for an accept back. */
  | { readonly type: "lineage_act_recorded"; readonly requestId: string; readonly act: LineageAct; readonly seq?: number; readonly revision?: number }
  /** `changedIds`: every record the copy changed since `anchor`, or the chosen ones (sorted); `headRevision`: the copy's head they were read at. */
  | { readonly type: "lineage_delta_result"; readonly requestId: string; readonly anchor: LineageAnchor; readonly headRevision: number; readonly changedIds: readonly string[]; readonly deltaDigest: string }
  | { readonly type: "request_refused"; readonly requestId: string; readonly reason: string };

/** The feature a server advertises before a client may send each message. */
export const LINEAGE_MESSAGE_FEATURES: Readonly<Record<LineageClientMessage["type"], string>> = {
  lineage_list: LINEAGES_ROLES_FEATURE,
  lineage_create: LINEAGES_ROLES_FEATURE,
  lineage_compare: LINEAGES_ROLES_FEATURE,
  lineage_review: LINEAGES_REVIEW_FEATURE,
  lineage_accept_back: LINEAGES_ACCEPT_BACK_FEATURE,
  lineage_delta: LINEAGES_DELTA_FEATURE,
};

/** Every answer a lineage request gets (a client waits for one of these by its requestId). */
export const LINEAGE_SERVER_TYPES: readonly LineageServerMessage["type"][] = ["lineages", "lineage_saved", "lineage_compare_result", "lineage_act_recorded", "lineage_delta_result", "request_refused"];

/** What a person reads when the model server is an older release (no price, no blame). */
export const LINEAGE_OLDER_SERVER_WORDS: Readonly<Record<string, string>> = {
  [LINEAGES_ROLES_FEATURE]: "Copies with a purpose aren't available on this model server yet: it is an older release. Branches still work. Ask your administrator to update the server.",
  [LINEAGES_REVIEW_FEATURE]: "Reviewing a copy isn't available on this model server yet: it is an older release. Ask your administrator to update the server.",
  [LINEAGES_ACCEPT_BACK_FEATURE]: "Accepting parts of a copy back isn't available on this model server yet: it is an older release. Ask your administrator to update the server.",
  [LINEAGES_DELTA_FEATURE]: "Reviewing a copy's changes isn't available on this model server yet: it is an older release. Ask your administrator to update the server.",
};

/** The refusal a client answers itself with when the server didn't advertise the message's feature; null when it may send. */
export function lineageRequestRefusal(server: Protocol | undefined, msg: LineageClientMessage): Extract<LineageServerMessage, { type: "request_refused" }> | null {
  const feature = LINEAGE_MESSAGE_FEATURES[msg.type];
  if (peerHas(server, feature)) return null;
  return { type: "request_refused", requestId: msg.requestId, reason: LINEAGE_OLDER_SERVER_WORDS[feature] ?? LINEAGE_OLDER_SERVER_WORDS[LINEAGES_ROLES_FEATURE] ?? "" };
}

/**
 * A lineage as a round 8b branch, for a peer that doesn't read lineages: only
 * a copy whose parent is a first lineage has a faithful branch form (its base
 * revision is that lineage's). A copy of a copy has none; it is not listed.
 */
export function lineageAsBranchRef(baseModelId: string, lineage: Lineage, parent: Lineage | undefined): BranchRef | null {
  if (!lineage.parent || !parent || parent.id !== lineage.parent.lineageId || parent.parent !== null) return null;
  return {
    branchId: lineage.id,
    modelId: branchModelId(baseModelId, lineage.id),
    baseModelId,
    baseRevision: lineage.parent.revision,
    name: lineage.name,
    createdBy: lineage.createdBy.subject,
    createdAt: lineage.createdAt,
    state: lineage.state === "open" ? "open" : "closed",
  };
}

/** What a peer reads of the model's lineages: all of them, or their branch form for an older peer. */
export function lineagesForPeer(peer: Protocol | undefined, baseModelId: string, lineages: readonly Lineage[]): { readonly lineages: readonly Lineage[] } | { readonly branches: readonly BranchRef[] } {
  if (peerHas(peer, LINEAGES_ROLES_FEATURE)) return { lineages };
  const byId = new Map(lineages.map((l) => [l.id, l]));
  const branches: BranchRef[] = [];
  for (const l of lineages) {
    const b = lineageAsBranchRef(baseModelId, l, l.parent ? byId.get(l.parent.lineageId) : undefined);
    if (b) branches.push(b);
  }
  return { branches };
}
