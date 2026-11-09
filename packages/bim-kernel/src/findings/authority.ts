import type { AuthorRef } from "../authorship/types";
import { coveringResponsibilities, type CoverageContext, type Responsibility } from "../responsibility/types";
import type { BimElement } from "../types";
import { DISPOSITION_REASON_MAX, DISPOSITION_REASON_MIN, overrideRefusal, RETRACTED_ACTION, type FindingDispositionAction } from "./disposition";
import type { FindingRef } from "./ref";

/**
 * Who may record a decision on a finding (round 11, D2):
 *
 * - a person, never an agent (an agent proposes; a person records);
 * - a responsible professional whose accepted scope covers every subject of
 *   the finding that is an element of this model (round 8 coverage: the
 *   discipline's scoped rows, else its unscoped rows, else the project
 *   lead), and under a firm's "any one of" rule any one of the covering
 *   people is enough;
 * - `override` on a reliance finding stays the record's own signer's (C10).
 *
 * Pure: the host calls it before it sends `record_finding_disposition`, with
 * the responsibility rows and the coverage context it already has.
 */

export interface DispositionAuthorityInput {
  readonly by: AuthorRef;
  readonly action: FindingDispositionAction;
  readonly reason: string;
  readonly finding: Pick<FindingRef, "id" | "source" | "subjects">;
  readonly elements: Readonly<Record<string, BimElement>>;
  readonly responsibilities: readonly Responsibility[];
  readonly coverage: CoverageContext;
  /** True when `by` is the host's project lead (who decides for elements no one is responsible for). */
  readonly isProjectLead?: boolean;
  /** A reliance finding's signer, for `override`. */
  readonly signer?: AuthorRef;
  readonly signerName?: string;
  /** The host's id for a person, as responsibility rows name them. Absent: the author's subject. */
  personRef?(author: AuthorRef): string;
  /** An element's name in a sentence. Absent: its id. */
  nameOf?(id: string): string;
}

/** Most names a refusal lists before "and N more". */
const NAMES_SHOWN = 3;

function listWords(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length > NAMES_SHOWN) return `${unique.slice(0, NAMES_SHOWN).join(", ")} and ${unique.length - NAMES_SHOWN} more`;
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1] ?? ""}`;
}

/** Why `by` may not record this decision, in words, or null when they may. */
export function dispositionRefusal(input: DispositionAuthorityInput): string | null {
  const { by, action, finding } = input;
  if (by.kind !== "person") return "An agent can propose this decision; a person records it.";
  const reason = input.reason.trim();
  if (action !== RETRACTED_ACTION && reason.length < DISPOSITION_REASON_MIN) return "Say why in a sentence; reviewers will read it.";
  if (reason.length > DISPOSITION_REASON_MAX) return `Keep the reason under ${DISPOSITION_REASON_MAX} characters.`;
  if (action === "override" && finding.source.kind === "reliance") {
    if (!input.signer) return "Only the person who signed this can override it, and the model doesn't know who that is.";
    return overrideRefusal({ signer: input.signer, by, reason: input.reason, ...(input.signerName ? { signerName: input.signerName } : {}) });
  }
  const me = (input.personRef ?? ((a: AuthorRef) => a.subject))(by);
  const subjects: BimElement[] = [];
  for (const id of finding.subjects) {
    const el = input.elements[id];
    if (el) subjects.push(el);
  }
  if (subjects.length === 0) return input.isProjectLead === true ? null : "No one is responsible for what this finding is about, so the project lead decides it.";
  const name = input.nameOf ?? ((id: string) => id);
  const uncovered: string[] = [];
  const whoCan: string[] = [];
  for (const c of coveringResponsibilities(subjects, input.responsibilities, input.coverage)) {
    if (c.fallback === "project_lead") {
      if (input.isProjectLead !== true) {
        uncovered.push(name(c.elementId));
        whoCan.push("the project lead");
      }
      continue;
    }
    if (c.covering.some((r) => r.party.kind === "person" && r.party.ref === me)) continue;
    uncovered.push(name(c.elementId));
    for (const r of c.covering) whoCan.push(r.party.label);
  }
  if (uncovered.length === 0) return null;
  return `Only someone responsible for ${listWords(uncovered)} can decide this (${listWords(whoCan)}).`;
}
