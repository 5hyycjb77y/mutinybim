import { withModelStatePacks } from "../packs/scope";
import type { ScenarioOverlay } from "../requirements/scenario";
import { spaceOf, spacesOfZone } from "../spaces/space-index";
import { draftElements } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { quantityDeltasBetween } from "../qto/delta";
import { isLocatedKind } from "./auxiliary";
import { ruleKeyOf } from "./compile";
import { allAnchors, graphStateIn, previewStateIn, requirementById, type GraphState } from "./engine";
import { anchorKeyOf, determinationWords, type AnchorRef } from "./inputs";
import { boundedAreaWords, groupedMakeupWords, makeupRole, spacesTouchedBy } from "./makeup";
import { listWords, nameOf, valueWords } from "./names";
import { isDeterminationRecord } from "./records";
import {
  DEPENDS_ON_EMPTY,
  GRAPH_ANSWER_LIMIT,
  WHY_EMPTY,
  type DependsOnAnswer,
  type GraphEdge,
  type GraphQueryOptions,
  type NodeRef,
  type RankedAnswer,
  type RankedItem,
  type Requirement,
} from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * The two graph queries (contract 1.4.0, REQUIREMENTS-GRAPH §1):
 *
 *   why(model, node)        from an element (or space, requirement, rule,
 *                           determination) back through fulfilled_by,
 *                           produces and informs to the rules,
 *                           determinations and inputs that put it there
 *   dependsOn(model, target) what re-opens if the target changes: a node, a
 *                           proposed edit (removed / changed ids, with the
 *                           after-state when the caller has it) or a
 *                           scenario overlay, evaluated on the touched
 *                           neighbourhood only, never a copy of the model
 *
 * Both answers are short and ranked (product owner decision 6): at most the limit
 * (five), most consequential first (how many requirements and fulfilments
 * each item moves), then "and N more". Every item is a sentence with a named
 * cause; an empty answer says so in words.
 */

/**
 * A proposed edit: what it removes and changes, and (when the caller ran the command) the record after it.
 * `removedIds` and `changedIds` together name every id where `after` differs from the model (an
 * `ExecuteOk`'s `removedIds` and `changedIds`): the preview's indexes fork from the model's on them.
 */
export interface ProposedEdit {
  readonly removedIds?: readonly string[];
  readonly changedIds?: readonly string[];
  readonly after?: Elements;
  /** How the edit is named in causes ("Merge Offices 101–103"). */
  readonly label?: string;
}

export type DependsOnTarget = NodeRef | ScenarioOverlay | ProposedEdit;

function isNodeRef(t: DependsOnTarget): t is NodeRef {
  return "kind" in t && typeof t.kind === "string" && "id" in t && typeof t.id === "string";
}

function isOverlay(t: DependsOnTarget): t is ScenarioOverlay {
  return "scenario" in t && typeof t.scenario === "object" && t.scenario !== null;
}

function rankAndCut(items: readonly RankedItem[], limit: number, empty: string): RankedAnswer {
  const sorted = [...items].sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
  const shown = sorted.slice(0, Math.max(0, limit));
  return { items: shown, more: sorted.length - shown.length, ...(shown.length === 0 ? { empty } : {}) };
}

const reqNode = (r: Requirement): NodeRef => ({ kind: "requirement", id: r.id, provider: r.provider });
const ruleNode = (r: Requirement): NodeRef => ({ kind: "rule", id: r.ruleId, provider: r.provider });

function anchorRefFor(elements: Elements, id: string): AnchorRef | null {
  const el = elements[id];
  if (!el) return null;
  if (el.kind === "space") return { kind: "space", id };
  if (el.kind === "zone") return { kind: "zone", id };
  return { kind: "element", id };
}

/** The anchors whose requirements an element can reach: its space, the spaces it bounds, its own anchor, a determination's subject. */
function anchorsAround(state: GraphState, elements: Elements, id: string): AnchorRef[] {
  const el = elements[id];
  if (!el) return [];
  const out = new Map<string, AnchorRef>();
  const add = (a: AnchorRef | null) => {
    if (a) out.set(anchorKeyOf(a), a);
  };
  if (isDeterminationRecord(el)) {
    const s = el.determination.subject;
    if (s.kind === "model" || !s.id) for (const a of allAnchors(state)) add(a);
    else {
      add(anchorRefFor(elements, s.id));
      if (elements[s.id]?.kind === "zone") for (const sp of spacesOfZone(elements, s.id as ElementId)) add({ kind: "space", id: sp.id });
    }
    return [...out.values()];
  }
  if (el.kind === "space" || el.kind === "zone") add({ kind: el.kind, id });
  if (el.kind === "zone") for (const sp of spacesOfZone(elements, el.id)) add({ kind: "space", id: sp.id });
  if (isLocatedKind(el)) {
    const s = spaceOf(elements, el.id);
    if (s) add({ kind: "space", id: s.id });
  }
  for (const s of spacesTouchedBy(elements, el)) add({ kind: "space", id: s });
  if (state.compiled.elementByClass.size > 0 && el.kind !== "space" && el.kind !== "zone") add({ kind: "element", id });
  return [...out.values()];
}

function anchorName(elements: Elements, r: Requirement): string {
  return r.anchor.id === null ? "the model" : nameOf(elements[r.anchor.id], r.anchor.id);
}

// ── why ────────────────────────────────────────────────────────────────────

/** Why a node is in the model: the requirements it fulfils, the rules that produced them, the determinations and inputs they were decided from. */
export function why(model: ModelState, node: NodeRef, options: GraphQueryOptions = {}): RankedAnswer {
  const limit = options.limit ?? GRAPH_ANSWER_LIMIT;
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    const elements = model.elements;
    const items = new Map<string, RankedItem>();
    const put = (key: string, item: RankedItem) => {
      const prior = items.get(key);
      if (!prior) items.set(key, item);
      else items.set(key, { ...prior, weight: Math.max(prior.weight, item.weight), edges: [...(prior.edges ?? []), ...(item.edges ?? [])] });
    };
    const explain = (r: Requirement, target: NodeRef | null) => {
      const where = anchorName(elements, r);
      const edges: GraphEdge[] = [{ from: ruleNode(r), to: reqNode(r), kind: "produces", cause: r.cause }];
      if (target) edges.push({ from: reqNode(r), to: target, kind: "fulfilled_by", cause: r.fulfilment.summary ?? `${nameOf(elements[target.id], target.id)} counts toward it` });
      put(`req:${r.id}`, {
        node: reqNode(r),
        label: `${r.title} in ${where}`,
        cause: `${r.fulfilment.summary ? `${r.fulfilment.summary}; ` : ""}needs ${valueWords(r.value, r.unit)}${r.status !== "proposed" ? ` (${r.status})` : ""}`,
        weight: 1 + r.fulfilment.elementIds.length,
        edges,
      });
      put(`rule:${r.provider}:${r.ruleId}`, {
        node: ruleNode(r),
        label: `${r.citation.instrument} ${r.citation.section}: ${r.title}`.trim(),
        cause: `the ${state.compiled.sources.find((s) => s.id === r.provider)?.label ?? r.provider} rule that produces it for ${where}`,
        weight: Math.max(1, state.reachOfRule(ruleKeyOf(r.provider, r.ruleId))),
      });
      const ev = state.evaluation(anchorKeyOf({ kind: r.anchor.kind, id: r.anchor.id }), ruleKeyOf(r.provider, r.ruleId));
      for (const d of ev?.determinations ?? []) {
        put(`det:${d.id}`, {
          node: { kind: "determination", id: d.id },
          label: determinationWords(elements, d),
          cause: `${r.title} applies because of it`,
          weight: Math.max(1, state.readersOf(d.id)),
          edges: [
            { from: { kind: "determination", id: d.id }, to: ruleNode(r), kind: "informs", cause: determinationWords(elements, d) },
            ...d.determination.inputs.map((i): GraphEdge => ({ from: { kind: "determination", id: d.id }, to: { kind: "input", id: i.elementId ? `${i.elementId}|${i.key}` : i.key }, kind: "decided_from", cause: `decided from ${i.key.replace(/[._]/g, " ")}${i.value !== undefined ? ` = ${valueWords(i.value, i.unit)}` : ""}` })),
          ],
        });
      }
      if (r.anchor.id && r.anchor.kind !== "element") {
        put(`anchor:${r.anchor.id}`, {
          node: { kind: r.anchor.kind === "space" ? "space" : r.anchor.kind, id: r.anchor.id },
          label: where,
          cause: `${r.title} is anchored to ${where}`,
          weight: state.requirementsAt({ kind: r.anchor.kind, id: r.anchor.id }).length,
          edges: [{ from: { kind: r.anchor.kind, id: r.anchor.id }, to: reqNode(r), kind: "anchors", cause: `${where} carries it` }],
        });
      }
    };

    switch (node.kind) {
      case "requirement": {
        const r = requirementById(model, node.id);
        if (r) explain(r, null);
        break;
      }
      case "rule": {
        for (const a of allAnchors(state)) for (const r of state.requirementsAt(a)) if (r.ruleId === node.id && (!node.provider || r.provider === node.provider)) explain(r, null);
        break;
      }
      case "determination": {
        const d = elements[node.id];
        if (!isDeterminationRecord(d)) break;
        for (const i of d.determination.inputs) {
          const id = i.elementId ? `${i.elementId}|${i.key}` : i.key;
          put(`input:${id}`, { node: { kind: "input", id }, label: `${i.elementId ? `${nameOf(elements[i.elementId], i.elementId)} ` : ""}${i.key.replace(/[._]/g, " ")}${i.value !== undefined ? ` = ${valueWords(i.value, i.unit)}` : ""}`, cause: `${determinationWords(elements, d)} was decided from it`, weight: 1, edges: [{ from: { kind: "determination", id: d.id }, to: { kind: "input", id }, kind: "decided_from", cause: d.determination.reasoning }] });
        }
        const old = d.determination.supersedes;
        const prev = old ? elements[old] : undefined;
        if (old) put(`det:${old}`, { node: { kind: "determination", id: old }, label: isDeterminationRecord(prev) ? determinationWords(elements, prev) : old, cause: "it replaces this earlier determination", weight: 1, edges: [{ from: { kind: "determination", id: d.id }, to: { kind: "determination", id: old }, kind: "supersedes", cause: d.determination.reasoning }] });
        break;
      }
      default: {
        const el = elements[node.id];
        if (!el) break;
        if (el.kind === "space" || el.kind === "zone") {
          for (const r of state.requirementsAt({ kind: el.kind, id: el.id })) explain(r, null);
          break;
        }
        const target: NodeRef = { kind: "element", id: el.id };
        for (const a of anchorsAround(state, elements, el.id)) for (const r of state.requirementsAt(a)) if (r.fulfilment.elementIds.includes(el.id)) explain(r, target);
      }
    }
    return rankAndCut([...items.values()], limit, WHY_EMPTY);
  });
}

// ── dependsOn ──────────────────────────────────────────────────────────────

interface Moved {
  readonly r: Requirement;
  readonly after: Requirement | null;
  readonly cause: string;
  readonly fulfilmentMoved: boolean;
}

function same(a: Requirement, b: Requirement): boolean {
  return a.value === b.value && a.status === b.status && a.standing === b.standing && a.fulfilment.state === b.fulfilment.state && a.fulfilment.delivered === b.fulfilment.delivered && a.problem === b.problem;
}

function outcome(before: Requirement | null, after: Requirement | null): string {
  if (before && !after) return "no longer applies";
  if (!before && after) return `now applies (${valueWords(after.value, after.unit)})`;
  if (!before || !after) return "re-opens";
  if (before.value !== after.value) return `${valueWords(before.value, before.unit)} → ${valueWords(after.value, after.unit)}`;
  if (before.fulfilment.state !== after.fulfilment.state) return `now ${after.fulfilment.state.replace(/_/g, " ")}${after.fulfilment.summary ? ` (${after.fulfilment.summary})` : ""}`;
  if (before.problem !== after.problem && after.problem) return after.problem;
  return "re-opens";
}

/** What one changed id did, from where the requirement stands. */
function changeWords(before: Elements, after: Elements | null, id: string, label: string | undefined): string {
  const b = before[id];
  const a = after ? after[id] : undefined;
  const el = a ?? b;
  if (!el) return label ?? `${id} changed`;
  if (isDeterminationRecord(el)) {
    if (!b) return `${determinationWords(after ?? before, el)} recorded`;
    if (after && !a) return `${determinationWords(before, el)} removed`;
    return a && isDeterminationRecord(a) ? `now ${determinationWords(after ?? before, a)}` : `${determinationWords(before, el)} may change`;
  }
  const name = nameOf(el);
  if (after === null) return label ?? `if ${name} changes`;
  if (!a) return `${name} removed`;
  if (!b) return `${name} added`;
  return label ?? `${name} changed`;
}

function analyse(model: ModelState, state: GraphState, ids: readonly string[], after: Elements | null, label: string | undefined, limit: number): DependsOnAnswer {
  const before = model.elements;
  const preview = after ? previewStateIn({ ...model, elements: after }, state, ids) : null;
  const anchors = new Map<string, AnchorRef>();
  for (const id of ids) {
    for (const a of anchorsAround(state, before, id)) anchors.set(anchorKeyOf(a), a);
    if (after && preview) for (const a of anchorsAround(preview, after, id)) anchors.set(anchorKeyOf(a), a);
  }
  // Room makeup: which spaces each changed wall, opening, ceiling or obstruction belongs to.
  const makeup = new Map<string, { role: "ceiling" | "room"; changes: { before: BimElement | undefined; after: BimElement | undefined }[] }>();
  for (const id of ids) {
    const b = before[id];
    const a = after ? after[id] : undefined;
    const role = makeupRole(a ?? b);
    if (!role) continue;
    const spaces = new Set([...(b ? spacesTouchedBy(before, b) : []), ...(a && after ? spacesTouchedBy(after, a) : [])]);
    for (const s of spaces) {
      const entry = makeup.get(s) ?? { role: role === "ceiling" ? "ceiling" : "room", changes: [] };
      if (role !== "ceiling") entry.role = "room";
      entry.changes.push({ before: b, after: after ? a : b });
      makeup.set(s, entry);
      anchors.set(anchorKeyOf({ kind: "space", id: s }), { kind: "space", id: s });
    }
  }
  const idSet = new Set(ids);
  const moved: Moved[] = [];
  for (const a of anchors.values()) {
    const inBefore = a.id === null || before[a.id] !== undefined;
    const inAfter = !after || a.id === null || after[a.id] !== undefined;
    const was = inBefore ? state.requirementsAt(a) : [];
    const now = preview && inAfter ? preview.requirementsAt(a) : null;
    const nowById = new Map((now ?? []).map((r) => [r.id, r]));
    const spaceMakeup = a.kind === "space" && a.id ? makeup.get(a.id) : undefined;
    const spaceLabel = a.id ? nameOf(before[a.id] ?? (after ? after[a.id] : undefined), a.id) : "the model";
    const seen = new Set<string>();
    for (const r of was) {
      seen.add(r.id);
      const next = now ? (nowById.get(r.id) ?? null) : r;
      const readsHit = r.reads.find((x) => idSet.has(x));
      const ceilingReader = state.compiled.rules.get(ruleKeyOf(r.provider, r.ruleId))?.readsCeiling ?? false;
      const byMakeup = spaceMakeup && (spaceMakeup.role === "room" || ceilingReader);
      const changed = now ? next === null || !same(r, next) : readsHit !== undefined;
      if (!byMakeup && !changed) continue;
      const makeupWords = byMakeup && spaceMakeup ? ((after && a.id ? boundedAreaWords(before, after, a.id, spaceMakeup.changes) : null) ?? groupedMakeupWords(spaceMakeup.changes, spaceLabel)) : null;
      const cause = makeupWords !== null ? (after ? makeupWords : `if ${makeupWords.replace(/ changed(;|$)/g, " changes$1")}`) : changeWords(before, after, readsHit ?? ids[0] ?? "", label);
      const fulfilmentMoved = r.fulfilment.elementIds.length > 0 || (next !== null && next.fulfilment.state !== r.fulfilment.state);
      moved.push({ r, after: next, cause: now ? `${cause}: ${outcome(r, next)}` : cause, fulfilmentMoved });
    }
    for (const r of now ?? []) {
      if (seen.has(r.id)) continue;
      const cause = spaceMakeup ? groupedMakeupWords(spaceMakeup.changes, spaceLabel) : changeWords(before, after, ids.find((x) => r.reads.includes(x)) ?? ids[0] ?? "", label);
      moved.push({ r, after: r, cause: `${cause}: ${outcome(null, r)}`, fulfilmentMoved: r.fulfilment.elementIds.length > 0 });
    }
  }
  // One item per requirement key: "Exit count in Office 101, Office 102 and Office 103".
  const groups = new Map<string, Moved[]>();
  for (const m of moved) {
    const list = groups.get(m.r.key);
    if (list) list.push(m);
    else groups.set(m.r.key, [m]);
  }
  const elementsForNames = after ?? before;
  const items: RankedItem[] = [];
  for (const [, list] of groups) {
    const first = list[0];
    if (!first) continue;
    const names = list.map((m) => (m.r.anchor.id === null ? "the model" : nameOf(before[m.r.anchor.id] ?? elementsForNames[m.r.anchor.id], m.r.anchor.id)));
    const where = listWords([...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
    const causes = [...new Set(list.map((m) => m.cause))];
    items.push({
      node: reqNode(first.r),
      label: `${first.r.title} in ${where}`,
      cause: causes.length <= 2 ? causes.join("; ") : `${causes.slice(0, 2).join("; ")}; and ${causes.length - 2} more`,
      weight: list.length + list.filter((m) => m.fulfilmentMoved).length,
      edges: list.map((m): GraphEdge => ({ from: m.r.anchor.id ? { kind: m.r.anchor.kind, id: m.r.anchor.id } : { kind: "input", id: "model" }, to: reqNode(m.r), kind: "anchors", cause: m.cause })),
    });
  }
  const quantityDeltas = after ? quantityDeltasBetween(before, after, ids) : [];
  return { ...rankAndCut(items, limit, DEPENDS_ON_EMPTY), quantityDeltas };
}

function overlayAfter(elements: Elements, overlay: ScenarioOverlay): { readonly after: Elements; readonly ids: string[] } {
  const draft = draftElements(elements);
  const ids: string[] = [];
  for (const o of overlay.overrides ?? []) {
    const el = draft[o.elementId];
    if (!el) {
      console.error(`[bim-kernel/graph] scenario ${overlay.scenario.id} overrides ${o.elementId}, which isn't in the model; that override is skipped`);
      continue;
    }
    const prior = "values" in el && typeof el.values === "object" && el.values !== null ? (el.values as Readonly<Record<string, number | string | boolean>>) : {};
    draft[o.elementId] = Object.assign({}, el, { values: { ...prior, ...o.values } });
    ids.push(o.elementId);
  }
  return { after: draft, ids };
}

/** What re-opens if the target changes, ranked, with each cause named, plus the quantity deltas of a proposed edit. */
export function dependsOn(model: ModelState, target: DependsOnTarget, options: GraphQueryOptions = {}): DependsOnAnswer {
  const limit = options.limit ?? GRAPH_ANSWER_LIMIT;
  return withModelStatePacks(model, () => {
    const state = graphStateIn(model);
    if (isOverlay(target)) {
      const { after, ids } = overlayAfter(model.elements, target);
      return analyse(model, state, ids, after, target.scenario.label, limit);
    }
    if (isNodeRef(target)) {
      if (target.kind === "requirement" || target.kind === "rule") {
        // What a requirement or rule moves: its fulfilments, listed by why's walk the other way.
        const reqs = target.kind === "requirement" ? [requirementById(model, target.id)].filter((r): r is Requirement => r !== null) : allAnchors(state).flatMap((a) => state.requirementsAt(a)).filter((r) => r.ruleId === target.id && (!target.provider || r.provider === target.provider));
        const items: RankedItem[] = reqs.map((r) => ({ node: reqNode(r), label: `${r.title} in ${anchorName(model.elements, r)}`, cause: r.fulfilment.summary ?? r.cause, weight: 1 + r.fulfilment.elementIds.length }));
        return { ...rankAndCut(items, limit, DEPENDS_ON_EMPTY), quantityDeltas: [] };
      }
      const id = target.kind === "input" ? (target.id.split("|")[0] ?? target.id) : target.id;
      return analyse(model, state, [id], null, undefined, limit);
    }
    const removed = target.removedIds ?? [];
    const changed = target.changedIds ?? [];
    let after = target.after ?? null;
    if (!after && removed.length > 0) {
      const draft = draftElements(model.elements);
      for (const id of removed) delete draft[id];
      after = draft;
    }
    return analyse(model, state, [...new Set([...removed, ...changed])], after, target.label, limit);
  });
}
