import { anchorKeyOf, anchorOfRequirementId, requirementsAt, requirementsOf } from "../../graph";
import { isLocatedKind } from "../../graph/auxiliary";
import { graphStateIn } from "../../graph/engine";
import { isDeterminationRecord, isRequirementStateRecord, isRuleRecordElement } from "../../graph/records";
import { withModelStatePacks } from "../../packs/scope";
import type { Requirement } from "../../graph/types";
import { ruleVersionOf } from "../../responsibility/checking-context";
import { spaceOf, spacesOfZone } from "../../spaces/space-index";
import { elementsOfKind } from "../../store";
import type { BimElement, ElementId, ModelState } from "../../types";
import { findingRefId, findingSubjects, findingWords, type FindingRef } from "../ref";
import type { FindingChange, FindingChangeContext, FindingReadContext, FindingSourceRow } from "./point";

/**
 * Requirement checks as findings: a governing requirement whose fulfilment
 * is `not_met` (blocking) or `open` (a warning: nothing fulfils it yet).
 * `unchecked` and `met` are not problems. The finding id is the
 * requirement's own stable id (`requirement:<provider>:<rule>:<key>:<anchor>`);
 * its version is the rule's version when the rule is stored with the model
 * (C10's `ruleVersion`), else "1". A requirement `overridden` state reads as
 * an `override` disposition (`record.ts`), its stored bytes unchanged.
 *
 * Incremental: after an edit only the anchors it can reach are read again
 * (`requirementsAt`, which re-derives only what the edit dirtied): every
 * anchor with an evaluation that read a changed id (the graph's own reverse
 * index), the changed spaces and zones, the space a changed element sits in,
 * a changed determination's subject, a changed requirement state's anchor,
 * the anchors of findings already listed on a changed id, and the model
 * anchor. A changed rule, or a determination about the whole model, reads
 * every requirement again.
 */

type Elements = Readonly<Record<string, BimElement>>;
type AnchorRef = Requirement["anchor"];

const FAILING: ReadonlySet<string> = new Set(["not_met", "open"]);

const ruleVersions = new WeakMap<Elements, ReadonlyMap<string, string>>();

/** Versions of the rules stored with the model (the local source), by `<provider>:<rule id>`, once per revision (a kind-index read). */
function storedRuleVersions(elements: Elements): ReadonlyMap<string, string> {
  const hit = ruleVersions.get(elements);
  if (hit) return hit;
  const out = new Map<string, string>();
  for (const el of elementsOfKind(elements, "rule" as BimElement["kind"])) if (isRuleRecordElement(el)) out.set(`${el.rule.provider}:${el.rule.ruleId}`, ruleVersionOf(el.rule));
  ruleVersions.set(elements, out);
  return out;
}

export function requirementFindingId(requirementId: string): string {
  return findingRefId("requirement", requirementId);
}

/** One requirement as a finding, or null when it isn't a problem. */
export function requirementFindingRef(r: Requirement, model: ModelState, lineageId: string): FindingRef | null {
  if (r.standing !== "governing" || !FAILING.has(r.fulfilment.state)) return null;
  const subjects = findingSubjects([...(r.anchor.id ? [r.anchor.id] : []), ...r.fulfilment.elementIds]);
  const what = r.fulfilment.summary ?? r.cause;
  return {
    id: requirementFindingId(r.id),
    source: { kind: "requirement", id: `${r.provider}:${r.ruleId}`, version: storedRuleVersions(model.elements).get(`${r.provider}:${r.ruleId}`) ?? "1" },
    severity: r.fulfilment.state === "not_met" ? "blocking" : "warning",
    subjects,
    lineageId,
    revision: model.revision,
    words: findingWords(r.fulfilment.state === "not_met" ? `${r.title} is not met: ${what}` : `${r.title}: nothing meets it yet (${what})`),
  };
}

function keyOf(a: AnchorRef): string {
  return anchorKeyOf(a);
}

/** The anchors one changed id can reach in `elements`, or "all" when it can reach every one. `elementAnchors`: the rules in force anchor on element classes. */
function anchorsOf(elements: Elements, id: string, out: Map<string, AnchorRef>, elementAnchors: boolean): "all" | void {
  const el = elements[id];
  if (!el) return;
  if (isRuleRecordElement(el)) return "all";
  const add = (a: AnchorRef) => out.set(keyOf(a), a);
  if (isDeterminationRecord(el)) {
    const s = el.determination.subject;
    if (s.kind === "model" || !s.id) return "all";
    const subject = elements[s.id];
    if (subject?.kind === "zone") {
      add({ kind: "zone", id: s.id });
      for (const sp of spacesOfZone(elements, s.id as ElementId)) add({ kind: "space", id: sp.id });
    } else if (subject) add({ kind: subject.kind === "space" ? "space" : "element", id: s.id });
    return;
  }
  if (isRequirementStateRecord(el)) {
    const a = anchorOfRequirementId(el.state.requirementId, elements);
    if (a) add(a);
    return;
  }
  if (el.kind === "space") add({ kind: "space", id });
  else if (el.kind === "zone") {
    add({ kind: "zone", id });
    for (const sp of spacesOfZone(elements, el.id)) add({ kind: "space", id: sp.id });
  } else {
    if (elementAnchors) add({ kind: "element", id });
    if (isLocatedKind(el)) {
      const s = spaceOf(elements, el.id);
      if (s) add({ kind: "space", id: s.id });
    }
  }
}

/** An anchor from the graph's anchor key (`model`, `space:S1`). */
function anchorFromKey(key: string): AnchorRef | null {
  if (key === "model") return { kind: "model", id: null };
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  if (kind !== "space" && kind !== "zone" && kind !== "element") return null;
  return { kind, id: key.slice(at + 1) };
}

function readAll(ctx: FindingReadContext): FindingRef[] {
  const out: FindingRef[] = [];
  for (const r of requirementsOf(ctx.model)) {
    const f = requirementFindingRef(r, ctx.model, ctx.lineageId);
    if (f) out.push(f);
  }
  return out;
}

function changed(ctx: FindingChangeContext): FindingChange | null | "reread" {
  const anchors = new Map<string, AnchorRef>();
  const state = withModelStatePacks(ctx.model, () => graphStateIn(ctx.model));
  const elementAnchors = state.compiled.elementByClass.size > 0;
  for (const id of ctx.changedIds) {
    if (anchorsOf(ctx.model.elements, id, anchors, elementAnchors) === "all") return "reread";
    if (anchorsOf(ctx.previous.elements, id, anchors, elementAnchors) === "all") return "reread";
  }
  // No rule in force and nothing listed: no requirement can have moved (a rule edit was caught above).
  if (state.compiled.rules.size === 0 && ctx.current.size === 0) return null;
  // Every evaluation that read a changed id (the graph's own reverse index, carried to this revision; a dirtied evaluation keeps its reads until it is read again).
  for (const id of ctx.changedIds) {
    for (const ev of state.evaluationsReading(id)) {
      const a = anchorFromKey(ev.anchorKey);
      if (a) anchors.set(keyOf(a), a);
    }
  }
  // Findings already listed on a changed id: read their anchors again too (a fulfilling element moved away).
  for (const f of ctx.touching(ctx.changedIds)) {
    const a = anchorOf(f, ctx);
    if (a) anchors.set(keyOf(a), a);
  }
  // The model anchor too: a model-wide count reads class slots, which the reverse index doesn't list by element id.
  anchors.set("model", { kind: "model", id: null });
  const put = new Map<string, FindingRef>();
  const read = new Set<string>();
  for (const a of anchors.values()) {
    const reqs = a.id === null || ctx.model.elements[a.id] ? requirementsAt(ctx.model, a) : [];
    for (const r of reqs) {
      read.add(requirementFindingId(r.id));
      const f = requirementFindingRef(r, ctx.model, ctx.lineageId);
      if (f) put.set(f.id, f);
    }
  }
  // Listed findings on a read anchor that it no longer lists as a problem (met now, or gone).
  const retire = new Set<string>();
  for (const id of read) if (ctx.current.has(id) && !put.has(id)) retire.add(id);
  const anchorIds: string[] = [];
  for (const a of anchors.values()) if (a.id !== null) anchorIds.push(a.id);
  for (const f of ctx.touching(anchorIds)) {
    if (put.has(f.id)) continue;
    const a = anchorOf(f, ctx);
    if (!a || anchors.has(keyOf(a))) retire.add(f.id);
  }
  if (retire.size === 0 && put.size === 0) return null;
  return { retire: [...retire], put: [...put.values()] };
}

function anchorOf(f: FindingRef, ctx: FindingChangeContext): AnchorRef | null {
  const reqId = f.id.slice("requirement:".length);
  return anchorOfRequirementId(reqId, ctx.model.elements) ?? anchorOfRequirementId(reqId, ctx.previous.elements);
}

export const REQUIREMENT_FINDING_SOURCE: FindingSourceRow = { id: "requirement", label: "Code and requirement checks", all: readAll, changed };
