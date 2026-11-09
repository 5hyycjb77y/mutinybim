import { requirementsAt } from "../graph";
import { spaceOf } from "../spaces/space-index";
import type { ModelState } from "../types";
import type { FindingLedger } from "./ledger";
import { dispositionActionWords } from "./standing";

/**
 * The agent's orientation (round 11, D2; FOUNDATION-REVIEW §4.8): a small,
 * host-neutral envelope a tool result may carry so the agent knows where it
 * is without a model scan: which copy and revision, which stage, what it is
 * focused on, a bounded set of what is nearby, the open findings touching
 * the focus (with any decision on them), and the requirements touching it.
 * Every list is capped by count, and "nearby" by a radius the kernel caps
 * too, so the envelope stays small whatever the model's size.
 */

export const ORIENTATION_VERSION = 1;

export const ORIENTATION_LIMITS = {
  focus: 50,
  nearby: 24,
  findings: 8,
  requirements: 8,
  /** 50 ft. */
  radiusMm: 15_240,
  wordsChars: 160,
} as const;

export interface OrientationFinding {
  readonly id: string;
  readonly severity: string;
  readonly words: string;
  readonly subjects: readonly string[];
  /** `open`, or how it was decided ("Accepted", "Accepted against an earlier version of this check"). */
  readonly standing: string;
  readonly decidedBy?: string;
}

export interface OrientationRequirement {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

export interface AgentOrientation {
  readonly v: typeof ORIENTATION_VERSION;
  readonly lineageId: string;
  readonly revision: number;
  /** The project stage the model is in, when the host knows it (G11's stage id). */
  readonly stage: string | null;
  readonly focus: readonly string[];
  readonly nearby: { readonly ids: readonly string[]; readonly radiusMm: number; readonly more: number };
  readonly findings: readonly OrientationFinding[];
  readonly findingsMore: number;
  readonly requirements: readonly OrientationRequirement[];
  readonly requirementsMore: number;
}

export interface OrientationInput {
  readonly model: ModelState;
  readonly ledger: FindingLedger;
  readonly focus: readonly string[];
  readonly radiusMm?: number;
  readonly stage?: string | null;
  /** The host's spatial read (lint's "what's here"): ids within `radiusMm` of the focus, nearest first, at most `limit`. Absent: nothing nearby is listed. */
  nearby?(focus: readonly string[], radiusMm: number, limit: number): readonly string[];
}

function cut(text: string): string {
  return text.length <= ORIENTATION_LIMITS.wordsChars ? text : `${text.slice(0, ORIENTATION_LIMITS.wordsChars - 1)}…`;
}

/** The orientation for a focus. Findings: open ones first, blocking first; requirements: those anchored on the focus or its spaces. */
export function agentOrientation(input: OrientationInput): AgentOrientation {
  const { model, ledger } = input;
  const focus = [...new Set(input.focus)].slice(0, ORIENTATION_LIMITS.focus);
  const radiusMm = Math.max(0, Math.min(input.radiusMm ?? ORIENTATION_LIMITS.radiusMm, ORIENTATION_LIMITS.radiusMm));
  const near = input.nearby ? input.nearby(focus, radiusMm, ORIENTATION_LIMITS.nearby + 1) : [];
  const nearIds = near.filter((id) => !focus.includes(id));
  const nearby = { ids: nearIds.slice(0, ORIENTATION_LIMITS.nearby), radiusMm, more: Math.max(0, nearIds.length - ORIENTATION_LIMITS.nearby) };

  const entries = ledger.entries({ touching: [...focus, ...nearby.ids] });
  const rank = (s: string) => (s === "blocking" ? 0 : s === "warning" ? 1 : 2);
  entries.sort((a, b) => Number(a.standing.state === "disposed") - Number(b.standing.state === "disposed") || rank(a.finding.severity) - rank(b.finding.severity) || (a.finding.id < b.finding.id ? -1 : 1));
  const findings: OrientationFinding[] = entries.slice(0, ORIENTATION_LIMITS.findings).map((e) => {
    const s = e.standing;
    const standing = s.state === "open" ? "open" : s.state === "disposed" ? dispositionActionWords(s.disposition.action) : s.words;
    return {
      id: e.finding.id,
      severity: e.finding.severity,
      words: cut(e.finding.words),
      subjects: e.finding.subjects.slice(0, 6),
      standing,
      ...(s.state === "open" ? {} : { decidedBy: s.disposition.by.displayName ?? s.disposition.by.subject }),
    };
  });

  const anchors = new Map<string, { kind: "space" | "element"; id: string }>();
  for (const id of focus) {
    const el = model.elements[id];
    if (!el) continue;
    if (el.kind === "space") anchors.set(`space:${id}`, { kind: "space", id });
    else {
      anchors.set(`element:${id}`, { kind: "element", id });
      const sp = spaceOf(model.elements, el.id);
      if (sp) anchors.set(`space:${sp.id}`, { kind: "space", id: sp.id });
    }
  }
  const reqs: OrientationRequirement[] = [];
  let reqTotal = 0;
  for (const a of anchors.values()) {
    for (const r of requirementsAt(model, a)) {
      if (r.standing !== "governing") continue;
      reqTotal += 1;
      if (reqs.length < ORIENTATION_LIMITS.requirements) reqs.push({ id: r.id, title: cut(r.title), state: r.fulfilment.state });
    }
  }
  return {
    v: ORIENTATION_VERSION,
    lineageId: ledger.lineage.lineageId,
    revision: model.revision,
    stage: input.stage ?? null,
    focus,
    nearby,
    findings,
    findingsMore: Math.max(0, entries.length - findings.length),
    requirements: reqs,
    requirementsMore: reqTotal - reqs.length,
  };
}
