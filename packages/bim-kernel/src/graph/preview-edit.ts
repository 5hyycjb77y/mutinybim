import { executeCommand, type Command, type PackCommand } from "../commands";
import type { CommandContext } from "../part-commands";
import type { ModelState } from "../types";
import { withSpaceIndexAt } from "../spaces/space-index";
import { dependsOn } from "./queries";
import { GRAPH_ANSWER_LIMIT } from "./types";

/**
 * An edit checked before anyone approves it (round 8 lane F, the Approve
 * card's preflight): the command run on the head without committing (would
 * the model refuse it?), then what it re-opens and the quantities it changes,
 * read on a temporary preview of the touched neighbourhood. Never a branch,
 * never stored in the model.
 *
 * The fingerprint names the answer, not the revision: an unrelated edit to
 * the model leaves it unchanged, so a card only re-asks when what it says
 * would change.
 */

export interface EditPreviewItem {
  /** What re-opens, short ("Exit count in Office 101 and Office 102"). */
  readonly what: string;
  /** Why, in plain words. */
  readonly because: string;
}

interface EditPreviewBase {
  /** The head the check ran on. */
  readonly headRevision: number;
  /** Stable for the same answer; changes when the refusal, the re-opened list or the quantities change. */
  readonly fingerprint: string;
}

export interface EditPreviewRefused extends EditPreviewBase {
  readonly status: "refused";
  readonly code: string;
  readonly message: string;
  readonly elementIds: readonly string[];
}

export interface EditPreviewChecked extends EditPreviewBase {
  readonly status: "checked";
  /** At most five, most consequential first. */
  readonly reopens: readonly EditPreviewItem[];
  /** How many more re-open ("and N more"). */
  readonly more: number;
  /** When nothing re-opens: the words to show instead. */
  readonly empty?: string;
  /** "−42 ft of 1-hour wall". No money. */
  readonly quantityChanges: readonly string[];
  readonly changedCount: number;
  readonly removedIds: readonly string[];
}

export type EditPreview = EditPreviewRefused | EditPreviewChecked;

export interface PreviewEditOptions {
  /** How the edit is named in causes. */
  readonly label?: string;
  readonly context?: CommandContext;
}

/** 53-bit string hash (cyrb53), hex. Not a security boundary: it only tells two answers apart. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The fingerprint of an answer: its refusal, or its re-opened list, count and quantities. */
export function editPreviewFingerprint(answer: Omit<EditPreviewRefused, "fingerprint" | "headRevision"> | Omit<EditPreviewChecked, "fingerprint" | "headRevision">): string {
  const key =
    answer.status === "refused"
      ? ["refused", answer.code, answer.message, [...answer.elementIds].sort()]
      : ["checked", answer.reopens.map((r) => [r.what, r.because]), answer.more, [...answer.quantityChanges], answer.changedCount, [...answer.removedIds].sort()];
  return hash53(JSON.stringify(key));
}

/** Check an edit against the model without committing it: refused (and why), or what it re-opens and changes. */
export function previewEdit(model: ModelState, command: Command | PackCommand, options: PreviewEditOptions = {}): EditPreview {
  const headRevision = Number(model.revision);
  const result = executeCommand(model, command, options.context ?? {});
  if (!result.ok) {
    const refused = { status: "refused" as const, code: result.error.code, message: result.error.message, elementIds: [...result.error.elementIds] };
    return { ...refused, headRevision, fingerprint: editPreviewFingerprint(refused) };
  }
  const removedIds = [...result.removedIds];
  const changedIds = result.changedIds.filter((id) => !result.removedIds.includes(id));
  // The space index follows the preview and comes back (O(changed)), so a preflight never re-reads every space.
  const answer = withSpaceIndexAt(model.elements, result.model.elements, changedIds, removedIds, () =>
    dependsOn(model, { removedIds, changedIds, after: result.model.elements, ...(options.label ? { label: options.label } : {}) }, { limit: GRAPH_ANSWER_LIMIT }),
  );
  const checked = {
    status: "checked" as const,
    reopens: answer.items.map((i) => ({ what: i.label, because: i.cause })),
    more: answer.more,
    ...(answer.items.length === 0 && answer.empty ? { empty: answer.empty } : {}),
    quantityChanges: answer.quantityDeltas.map((q) => q.label),
    changedCount: changedIds.length,
    removedIds,
  };
  return { ...checked, headRevision, fingerprint: editPreviewFingerprint(checked) };
}
