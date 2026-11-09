import { lineJoinRow } from "./joins/contract";
import { distance, planWidth } from "./geometry";
import { KernelError, anchorOf, connectorPointUnlessKept, wallLength } from "./model";
import { deriveNetwork, establishedFacts, factsPackSet, knownConsistent, knownIssues, knownNetworkOf, knownValid, networkOf, registerColdFacts, registerFactsTranslation, sameTopology, sortBy, type NetworkIndex } from "./network";
import { buildLedger, carryPointReads, detachedPointIndex, hasPointReads, hasUsablePointReads, installPointIndex, noteColdPass, recordInto, seedSparseLedger, settlePointReads, updateLedger, validLedger, withoutPackSetRecorder, type DetachedPointIndex, type Ledger, type UnitChecks } from "./validate-ledger";
import { registerRevisionCarry } from "./revision-carry";
import type { PackSet } from "./packs/set";
export { ledgerStats as incrementalValidationStats, type LedgerStats as IncrementalValidationStats } from "./validate-ledger";
import { activePackSet, withPackSet } from "./packs/scope";
import { derivedCheck, isFullyDerived, recomputeDerived } from "./derived";
import { findDisconnected } from "./topology";
import { treeNetwork } from "./tree-network";
import { elementKindTable } from "./registry/element-kind-point";
import { connectorEndsTable, type ConnectorEndsTable } from "./kinds/ends";
import { hostedAt, type HostedAt } from "./kinds/hosted";
import { storedField } from "./kinds";
import { elementSlots } from "./store";
import { asElementId, type BimElement, type Connection, type ElementId, type ModelState, type Profile } from "./types";
import type { KernelErrorCode } from "./model";
import { instanceValueIssues, partTypeIssues } from "./parts";
import { routingIssues, routingNeighbours } from "./routing/validate";
import { serviceIssues } from "./connections/validate";
import { serviceNeighbours } from "./connections/model";

export interface ValidationIssue {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

function sameProfile(a: Profile, b: Profile): boolean {
  if (a.shape === "rect" && b.shape === "rect") return a.width === b.width && a.height === b.height;
  if (a.shape === "round" && b.shape === "round") return a.diameter === b.diameter;
  return false;
}

function endOf(model: ModelState, id: ElementId): BimElement {
  const el = model.elements[id];
  if (!el) throw new KernelError("element_not_found", `Element ${id} does not exist`, [id]);
  return el;
}

/**
 * `readA` / `readB` are the ends when the caller already has them; a missing
 * one is looked up (and throws) here, in connectorPoint's order.
 */
function connectionIssues(model: ModelState, c: Connection, issues: ValidationIssue[], readA?: BimElement, readB?: BimElement): void {
  const ea = readA ?? endOf(model, c.a.elementId);
  // A connection to a kind whose add-on isn't loaded is kept as stored, not measured (a missing end still throws).
  const pa = connectorPointUnlessKept(model, ea, c.a.end);
  const eb = readB ?? endOf(model, c.b.elementId);
  const pb = connectorPointUnlessKept(model, eb, c.b.end);
  if (pa === null || pb === null) return;
  if (distance(pa, pb) > model.settings.connectorToleranceMm) {
    issues.push({
      code: "disconnected",
      message: `Connection ${c.id} is open by ${distance(pa, pb).toFixed(1)} mm`,
      elementIds: [c.a.elementId, c.b.elementId],
    });
  }
  if ("profile" in ea && "profile" in eb && !sameProfile(ea.profile, eb.profile)) {
    issues.push({
      code: "profile_incompatible",
      message: `${ea.id} and ${eb.id} meet with different sizes and no transition`,
      elementIds: [ea.id, eb.id],
    });
  }
}

/** Shortest wall the model accepts. */
export const MIN_WALL_MM = 100;

function missing(issues: ValidationIssue[], el: BimElement, ref: ElementId, what: string): void {
  issues.push({ code: "element_not_found", message: `${el.id} ${what} ${ref}, which does not exist`, elementIds: [el.id] });
}

/** How a check reads a referenced element: `model.elements[id]`, or the same answer from a faster source. */
type ElementLookup = (id: ElementId) => BimElement | undefined;

/** Building and document checks: walls long enough, openings inside their wall, references resolve. */
function buildingIssues(el: BimElement, issues: ValidationIssue[], get: ElementLookup): void {
  switch (el.kind) {
    case "wall": {
      const len = wallLength(el);
      if (len < MIN_WALL_MM) {
        issues.push({
          code: "min_straight_length",
          message: `${el.id} would be ${len.toFixed(1)} mm long, shorter than the ${MIN_WALL_MM} mm minimum wall`,
          elementIds: [el.id],
        });
      }
      return;
    }
    case "opening": {
      const host = get(el.hostId);
      if (!host || (host.kind !== "wall" && !lineJoinRow(host.kind))) {
        missing(issues, el, el.hostId, "is hosted on");
        return;
      }
      if (host.kind !== "wall") return;
      const half = el.width / 2;
      if (el.offset < half || el.offset > wallLength(host) - half) {
        issues.push({
          code: "outside_host",
          message: `${el.mark} does not fit inside wall ${host.id} at that position`,
          elementIds: [el.id, host.id],
        });
      }
      return;
    }
    case "tag": {
      const target = get(el.targetId);
      if (!target) missing(issues, el, el.targetId, "tags");
      else if (!anchorOf(target)) {
        issues.push({ code: "invalid_value", message: `${el.id} tags ${target.id}, a ${target.kind}, which cannot be tagged`, elementIds: [el.id] });
      }
      return;
    }
    case "dimension":
      for (const ref of [el.aId, el.bId]) if (!get(ref)) missing(issues, el, ref, "measures");
      return;
    case "sheet":
      for (const ref of el.viewIds) if (!get(ref)) missing(issues, el, ref, "places view");
      return;
    case "part_type": {
      const first = partTypeIssues(el.definition)[0];
      if (first) issues.push({ code: "invalid_value", message: `${el.definition.typeName}: ${first.message}`, elementIds: [el.id] });
      return;
    }
    case "part": {
      const type = get(el.typeId);
      if (!type || type.kind !== "part_type") {
        missing(issues, el, el.typeId, "is a");
        return;
      }
      const level = get(el.levelId);
      if (!level || level.kind !== "level") {
        missing(issues, el, el.levelId, "is hosted on level");
        return;
      }
      const first = instanceValueIssues(type.definition, el.values)[0];
      if (first) issues.push({ code: "invalid_value", message: `${el.mark || type.definition.typeName}: ${first.message}`, elementIds: [el.id] });
      if (el.planned !== undefined) {
        const name = el.mark || type.definition.typeName;
        if (el.planned.levelHint !== undefined && get(el.planned.levelHint)?.kind !== "level") missing(issues, el, el.planned.levelHint, "is planned for level");
        if (el.planned.spaceHint !== undefined && get(el.planned.spaceHint)?.kind !== "space") missing(issues, el, el.planned.spaceHint, "is planned for space");
        // A run end sits on a connector in the drawing; a part that isn't drawn has nowhere for it to sit.
        if (el.links && Object.keys(el.links).length > 0) issues.push({ code: "unsupported_geometry", message: `${name} isn't placed yet, so no run can connect to it; place it first (Not placed yet › Place)`, elementIds: [el.id] });
        if (el.host || el.planeId !== undefined) issues.push({ code: "unsupported_geometry", message: `${name} isn't placed yet, so it can't stand on a slab or a mounting plane; place it first`, elementIds: [el.id] });
        return;
      }
      if (!Number.isFinite(el.offsetMm) || Math.abs(el.offsetMm) > 100_000) {
        issues.push({ code: "invalid_value", message: `${el.mark || el.id} is ${el.offsetMm} mm above its level; keep it within 100 m`, elementIds: [el.id] });
      }
      return;
    }
    case "level":
      if (!Number.isFinite(el.elevationMm)) issues.push({ code: "invalid_value", message: `Level ${el.name} has no usable elevation`, elementIds: [el.id] });
      return;
    default:
      return;
  }
}

/** A record its kind row places along a host (`hostedBy.placement`), as it reads; null for every other record. */
function placedOf(el: BimElement, ends: ConnectorEndsTable = connectorEndsTable()): HostedAt | null {
  const placement = ends.placement(el.kind);
  return placement === null ? null : hostedAt(el, placement);
}

function isProfile(v: unknown): v is Profile {
  if (typeof v !== "object" || v === null) return false;
  const shape: unknown = Reflect.get(v, "shape");
  return (shape === "rect" && typeof Reflect.get(v, "width") === "number") || (shape === "round" && typeof Reflect.get(v, "diameter") === "number");
}

/** The members of a spacing group that are placed records, by their place along the host, in member order. */
function placedMembers(members: Iterable<BimElement | undefined>): { id: ElementId; s: number }[] {
  const out: { id: ElementId; s: number }[] = [];
  for (const m of members) {
    const at = m ? placedOf(m) : null;
    if (m && at) out.push({ id: m.id, s: at.s });
  }
  return out;
}

/** What the add-ons in force say about every element of one pass, read once for it (an unrecorded pass only: a recorded check reads them itself). */
interface PassRules {
  readonly kinds: ReturnType<typeof elementKindTable>;
  readonly tree: ReturnType<typeof treeNetwork>;
}

/** Per-element checks. For a placed hosted record with a valid host, returns the host id (its spacing group). */
function elementIssues(model: ModelState, el: BimElement, issues: ValidationIssue[], lookup?: ElementLookup, rules?: PassRules, ends?: ConnectorEndsTable): ElementId | null {
  const { settings } = model;
  const get = lookup ?? ((id: ElementId) => model.elements[id]);
  buildingIssues(el, issues, get);
  routingIssues(model.elements, el, settings, issues);
  serviceIssues(model.elements, el, issues);
  // A kind an add-on owns brings its own checks (its row on `ELEMENT_KIND_POINT`).
  (rules?.kinds ?? elementKindTable()).row(el.kind)?.check?.(el, settings, issues);
  const at = placedOf(el, ends);
  if (at !== null) {
    const host = get(at.hostId);
    // Which kinds host placed records, and how far `s` runs along one, are the add-ons' (the tree face of the pack set in force).
    const span = host ? (rules?.tree ?? treeNetwork()).tapSpan(host) : null;
    if (!host || span === null) {
      issues.push({ code: "disconnected", message: `${el.id} has no host`, elementIds: [el.id] });
      return null;
    }
    if (at.s < settings.tapEndClearanceMm || at.s > span - settings.tapEndClearanceMm) {
      issues.push({
        code: "outside_host",
        message: `${el.id} is within ${settings.tapEndClearanceMm} mm of the end of ${host.id}`,
        elementIds: [el.id, host.id],
      });
    }
    const own = storedField(el, "profile");
    const hostProfile = storedField(host, "profile");
    if (isProfile(own) && isProfile(hostProfile) && planWidth(own) >= planWidth(hostProfile)) {
      issues.push({
        code: "profile_incompatible",
        message: `${el.id} branch is as wide as its host ${host.id}`,
        elementIds: [el.id, host.id],
      });
    }
    return host.id;
  }
  return null;
}

function spacingIssues(model: ModelState, hostId: ElementId, taps: readonly { id: ElementId; s: number }[], issues: ValidationIssue[]): void {
  const sorted = [...taps].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && cur.s - prev.s < model.settings.minTapSpacingMm) {
      issues.push({
        code: "tap_spacing",
        message: `${prev.id} and ${cur.id} are closer than ${model.settings.minTapSpacingMm} mm on ${hostId}`,
        elementIds: [prev.id, cur.id],
      });
    }
  }
}

/**
 * Deterministic network validation. Runs identically in the browser
 * (prediction), on the sequencer (commit) and in workers.
 */
export function validateModel(model: ModelState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // The index already resolved every connection end to a slot: read the ends by slot, not by id.
  const net = networkOf(model);
  const read = net.readerFor(model.elements);
  model.connections.forEach((c, pos) => {
    const a = net.endSlot(pos, "a");
    const b = net.endSlot(pos, "b");
    connectionIssues(model, c, issues, a < 0 ? undefined : read(a), b < 0 ? undefined : read(b));
  });

  const tapsByHost = new Map<ElementId, { id: ElementId; s: number }[]>();
  const slots = elementSlots(model.elements);
  const get: ElementLookup = (id) => model.elements[id];
  const ends = connectorEndsTable();
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    const hostId = elementIssues(model, el, issues, get, undefined, ends);
    const at = hostId === null ? null : placedOf(el, ends);
    if (hostId === null || at === null) continue;
    const list = tapsByHost.get(hostId) ?? [];
    list.push({ id: el.id, s: at.s });
    tapsByHost.set(hostId, list);
  }
  for (const [hostId, taps] of tapsByHost) spacingIssues(model, hostId, taps, issues);

  const disconnected = disconnectedIssue(model);
  if (disconnected) issues.push(disconnected);
  return issues;
}

function disconnectedIssue(model: ModelState): ValidationIssue | null {
  const disconnected = findDisconnected(model);
  if (disconnected.length === 0) return null;
  return {
    code: "disconnected",
    message: `${disconnected.length} element(s) are not connected to any equipment`,
    elementIds: disconnected,
  };
}

/** What one cold pass established about a record. */
export interface ColdFacts {
  readonly consistent: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * `isFullyDerived(model)` and `validateModel(model)` in one walk over the
 * slots: each element is read once for both, and the elements it refers to
 * (a tap's host, an opening's host, an annotation's ends) are read by slot
 * through the topology index's forward rows instead of by id. Same answers,
 * same issue order. Null when the derived check needs a full recompute, the
 * record is ahead of its index, or a check throws: the two then run
 * separately, as before.
 */
export function coldFacts(model: ModelState): ColdFacts | null {
  try {
    return coldPass(model);
  } catch (err) {
    // Each fact's own path runs again on its own and throws where it always has; nothing is recorded from here.
    void err;
    return null;
  }
}

function coldPass(model: ModelState): ColdFacts | null {
  const check = derivedCheck(model);
  if (!check) return null;
  const net = networkOf(model);
  const slots = elementSlots(model.elements);
  if (slots.table.slotOf !== net.order) return null;
  noteColdPass();
  // The save waits for no recording: which add-on contributions each check reads is built after it (`buildPointReads`).
  const facts = withoutPackSetRecorder(() => coldChecks(model, check, net, slots));
  if (!hasUsablePointReads(model)) pointReadsWanted.add(model.elements);
  return facts;
}

// ── The point index, built after the save (round 10) ─────────────────────────

/**
 * Records whose cold pass left their point index to be built (and the
 * revisions made from them before it was). Until it is, a switch of add-on
 * set re-checks the whole model, as for any record without one.
 */
const pointReadsWanted = new WeakSet<object>();

/** One slice-at-a-time recorded pass over one record: the checks a cold pass runs, in its order, recording what each reads. */
interface PointReadsJob {
  readonly model: ModelState;
  readonly rules: PackSet;
  readonly index: DetachedPointIndex;
  readonly net: NetworkIndex;
  phase: "connections" | "elements" | "groups" | "whole";
  at: number;
  readonly hostOrder: number[];
  readonly hostSeen: Uint8Array;
}

let pointReadsJob: PointReadsJob | null = null;

/** True when `model`'s record waits for its point index (`buildPointReads` has work to do). */
export function pointReadsPending(model: ModelState): boolean {
  return pointReadsWanted.has(model.elements) && !hasUsablePointReads(model);
}

/** How many point indexes `buildPointReads` finished, and how many it gave up on (the record moved on, a check threw). */
const pointReadsStats = { built: 0, abandoned: 0 };

export function pointReadsBuildStats(): Readonly<typeof pointReadsStats> {
  return { ...pointReadsStats };
}

/**
 * Build `model`'s point index after the save that skipped it, for at most
 * `budgetMs` (hosts call it when idle: the client from an idle callback, the
 * model server after a commit, with their current head). True when nothing is
 * left to do for `model`. A slice runs whole checks: a check is never split.
 * The index is the one a recorded cold pass gives, installed only when every
 * check has run; a head that moves on starts it again on the new head.
 */
export function buildPointReads(model: ModelState, budgetMs = Number.POSITIVE_INFINITY): boolean {
  if (!pointReadsPending(model)) {
    if (pointReadsJob?.model === model) pointReadsJob = null;
    return true;
  }
  let job = pointReadsJob;
  if (!job || job.model.elements !== model.elements || job.model.connections !== model.connections || job.model.settings !== model.settings) {
    if (job) pointReadsStats.abandoned += 1;
    job = startPointReads(model);
    pointReadsJob = job;
    if (!job) {
      pointReadsWanted.delete(model.elements);
      pointReadsStats.abandoned += 1;
      return true;
    }
  }
  const started = performance.now();
  const current = job;
  let done: boolean;
  try {
    done = withPackSet(current.rules, () => stepPointReads(current, started, budgetMs));
  } catch (err) {
    // The cold pass on this record ran these same checks without throwing; a switch still re-checks everything.
    console.error("[validate] building the point index failed; an add-on switch on this model re-checks it whole", err);
    pointReadsJob = null;
    pointReadsWanted.delete(model.elements);
    pointReadsStats.abandoned += 1;
    return true;
  }
  if (!done) return false;
  pointReadsJob = null;
  pointReadsWanted.delete(model.elements);
  if (establishedFacts(model)?.rules === current.rules && installPointIndex(model, current.index)) pointReadsStats.built += 1;
  else pointReadsStats.abandoned += 1;
  return true;
}

function startPointReads(model: ModelState): PointReadsJob | null {
  // Recorded under the set the record's facts hold under, whatever scope the host calls from (a cold pass records there too).
  const rules = establishedFacts(model)?.rules;
  if (!rules) return null;
  const net = networkOf(model);
  if (elementSlots(model.elements).table.slotOf !== net.order) return null;
  return { model, rules, index: detachedPointIndex(model), net, phase: "connections", at: 0, hostOrder: [], hostSeen: new Uint8Array(net.size) };
}

/** Run `job`'s checks until done or past `budgetMs` since `started`; true when done. */
function stepPointReads(job: PointReadsJob, started: number, budgetMs: number): boolean {
  const { model, net } = job;
  const slots = elementSlots(model.elements);
  const pass = recordInto(job.index);
  const sink: ValidationIssue[] = [];
  // The clock is read every 64 checks, and only after some ran: every slice makes progress.
  let ran = 0;
  const over = (): boolean => (++ran & 63) === 0 && performance.now() - started > budgetMs;
  try {
    if (job.phase === "connections") {
      const read = net.readerFor(model.elements);
      const list = model.connections;
      for (; job.at < list.length; job.at++) {
        if (over()) return false;
        const c = list[job.at];
        if (!c) continue;
        const a = net.endSlot(job.at, "a");
        const b = net.endSlot(job.at, "b");
        pass.begin();
        connectionIssues(model, c, sink, a < 0 ? undefined : read(a), b < 0 ? undefined : read(b));
        pass.connection();
        sink.length = 0;
      }
      job.phase = "elements";
      job.at = 0;
    }
    if (job.phase === "elements") {
      let at = -1;
      let firstId: ElementId | undefined;
      let secondId: ElementId | undefined;
      const byRef = (second: boolean, id: ElementId): BimElement | undefined => {
        const ref = at < net.size ? net.referencedSlot(at, second) : -1;
        return ref >= 0 && ref < slots.size ? slots.at(ref) : model.elements[id];
      };
      const get: ElementLookup = (id) => (id === firstId ? byRef(false, id) : id === secondId ? byRef(true, id) : model.elements[id]);
      // Read outside the recorded checks, only to find each record's host; each check reads it again, recorded.
      const ends = connectorEndsTable();
      for (; job.at < slots.size; job.at++) {
        if (over()) return false;
        const slot = job.at;
        const el = slots.at(slot);
        if (!el) continue;
        at = slot;
        const placed = placedOf(el, ends);
        firstId = placed !== null ? placed.hostId : el.kind === "opening" ? el.hostId : el.kind === "tag" ? el.targetId : el.kind === "dimension" ? el.aId : undefined;
        secondId = el.kind === "dimension" ? el.bId : undefined;
        pass.begin();
        const hostId = elementIssues(model, el, sink, get);
        pass.element(slot);
        sink.length = 0;
        if (hostId === null || placed === null) continue;
        const host = slot < net.size ? net.referencedSlot(slot) : -1;
        if (host < 0 || host >= net.size) throw new ColdPassDeclined();
        if (!job.hostSeen[host]) {
          job.hostSeen[host] = 1;
          job.hostOrder.push(host);
        }
      }
      job.phase = "groups";
      job.at = 0;
    }
    if (job.phase === "groups") {
      for (; job.at < job.hostOrder.length; job.at++) {
        if (over()) return false;
        const host = job.hostOrder[job.at] ?? -1;
        const { start, end } = net.hostedTapRange(host);
        if (end - start < 2) continue;
        const members: (BimElement | undefined)[] = [];
        for (let i = start; i < end; i++) members.push(slots.at(net.tapSlotAt(i)));
        const taps = placedMembers(members);
        const hostEl = slots.at(host);
        if (!hostEl) continue;
        pass.begin();
        spacingIssues(model, hostEl.id, taps, sink);
        pass.group();
        sink.length = 0;
      }
      job.phase = "whole";
    }
    pass.begin();
    disconnectedIssue(model);
    pass.whole();
    return true;
  } finally {
    pass.end();
  }
}

function coldChecks(model: ModelState, check: NonNullable<ReturnType<typeof derivedCheck>>, net: NetworkIndex, slots: ReturnType<typeof elementSlots>): ColdFacts {
  const issues: ValidationIssue[] = [];
  // The checks that found something: run again, recorded, they are a sparse ledger (one pass, not two).
  const issueEnds: ElementId[] = [];
  const issueElements: ElementId[] = [];
  const issueGroups: ElementId[] = [];
  const read = net.readerFor(model.elements);
  model.connections.forEach((c, pos) => {
    const a = net.endSlot(pos, "a");
    const b = net.endSlot(pos, "b");
    const had = issues.length;
    connectionIssues(model, c, issues, a < 0 ? undefined : read(a), b < 0 ? undefined : read(b));
    if (issues.length > had) issueEnds.push(c.a.elementId);
  });
  let at = -1;
  let firstId: ElementId | undefined;
  let secondId: ElementId | undefined;
  const byRef = (second: boolean, id: ElementId): BimElement | undefined => {
    const ref = at < net.size ? net.referencedSlot(at, second) : -1;
    return ref >= 0 && ref < slots.size ? slots.at(ref) : model.elements[id];
  };
  const get: ElementLookup = (id) => (id === firstId ? byRef(false, id) : id === secondId ? byRef(true, id) : model.elements[id]);
  // Spacing groups in the order their first tap appears, read back from the index's hosted-tap rows.
  const ends = connectorEndsTable();
  const hostOrder: number[] = [];
  const hostSeen = new Uint8Array(net.size);
  const rules: PassRules = { kinds: elementKindTable(), tree: treeNetwork() };
  for (let slot = 0; slot < slots.size; slot++) {
    const el = slots.at(slot);
    if (!el) continue;
    check.visit(slot, el);
    at = slot;
    // The kind once: elements of every shape pass here, and each read of it is a lookup across them all.
    const kind = el.kind;
    const placed = placedOf(el, ends);
    firstId = placed !== null ? placed.hostId : kind === "opening" ? el.hostId : kind === "tag" ? el.targetId : kind === "dimension" ? el.aId : undefined;
    secondId = kind === "dimension" ? el.bId : undefined;
    const had = issues.length;
    const hostId = elementIssues(model, el, issues, get, rules, ends);
    if (issues.length > had) issueElements.push(el.id);
    if (hostId === null || placed === null) continue;
    const host = slot < net.size ? net.referencedSlot(slot) : -1;
    // A valid host the index has no row for (only a record ahead of its index): the grouped path decides.
    if (host < 0 || host >= net.size) throw new ColdPassDeclined();
    if (!hostSeen[host]) {
      hostSeen[host] = 1;
      hostOrder.push(host);
    }
  }
  for (const host of hostOrder) {
    const { start, end } = net.hostedTapRange(host);
    if (end - start < 2) continue;
    const members: (BimElement | undefined)[] = [];
    for (let i = start; i < end; i++) members.push(slots.at(net.tapSlotAt(i)));
    const taps = placedMembers(members);
    const hostEl = slots.at(host);
    if (!hostEl) continue;
    const had = issues.length;
    spacingIssues(model, hostEl.id, taps, issues);
    if (issues.length > had) issueGroups.push(hostEl.id);
  }
  const disconnected = disconnectedIssue(model);
  if (disconnected) issues.push(disconnected);
  const consistent = check.result();
  if (issues.length === 0) return { consistent, issues };
  const ledger = seedSparseLedger(model, UNIT_CHECKS, {
    elements: issueElements,
    connectionsAt: issueEnds,
    allConnections: false,
    groups: issueGroups,
    allGroups: false,
    whole: disconnected !== null,
  });
  if (!ledger) return { consistent, issues };
  ledgers.set(ledger.issues, ledger);
  return { consistent, issues: ledger.issues };
}

/** The cold pass leaves the record to each fact's own path (a record ahead of its index). */
class ColdPassDeclined extends Error {}

registerColdFacts(coldFacts);

/** Every issue full validation finds in `model`, computed once per model state. */
export function issuesOf(model: ModelState): readonly ValidationIssue[] {
  return knownIssues(model, () => validateModel(model));
}

export interface EditCheck {
  /** Why the edit is refused, or null when it may go ahead. */
  readonly refusal: ValidationIssue | null;
  /** Issues still open after an accepted edit. All were open before it. */
  readonly open: readonly ValidationIssue[];
}

/** An issue's elements as a set, for the long lists (the unreached-elements issue names many). */
const idSets = new WeakMap<ValidationIssue, ReadonlySet<ElementId>>();

function idSetOf(b: ValidationIssue): ReadonlySet<ElementId> {
  let set = idSets.get(b);
  if (!set) {
    set = new Set(b.elementIds);
    idSets.set(b, set);
  }
  return set;
}

function namesAll(b: ValidationIssue, ids: readonly ElementId[]): boolean {
  if (b.elementIds.length <= 16) return ids.every((id) => b.elementIds.includes(id));
  const names = idSetOf(b);
  return ids.every((id) => names.has(id));
}

/** True when the issue names any of `ids`; a long issue carried across a batch's steps is read through its set, not walked per step. */
function namesAny(b: ValidationIssue, ids: ReadonlySet<ElementId>): boolean {
  if (b.elementIds.length <= 16 || b.elementIds.length <= ids.size) return b.elementIds.some((id) => ids.has(id));
  const names = idSetOf(b);
  for (const id of ids) if (names.has(id)) return true;
  return false;
}

/** `before` already reported this issue: same code, and it names no element the earlier report didn't. */
function earlierReport(before: readonly ValidationIssue[], issue: ValidationIssue): ValidationIssue | undefined {
  return before.find((b) => b.code === issue.code && namesAll(b, issue.elementIds));
}

/** Where each element and code first appears in an issue list, so `earlierReport` reads only candidates. */
interface ReportIndex {
  readonly byElement: ReadonlyMap<ElementId, readonly number[]>;
  readonly firstOfCode: ReadonlyMap<string, number>;
}

const reportIndexes = new WeakMap<readonly ValidationIssue[], ReportIndex>();

function reportIndexOf(before: readonly ValidationIssue[]): ReportIndex {
  const known = reportIndexes.get(before);
  if (known) return known;
  const byElement = new Map<ElementId, number[]>();
  const firstOfCode = new Map<string, number>();
  before.forEach((b, pos) => {
    if (!firstOfCode.has(b.code)) firstOfCode.set(b.code, pos);
    for (const id of b.elementIds) {
      const list = byElement.get(id);
      if (!list) byElement.set(id, [pos]);
      else if (list[list.length - 1] !== pos) list.push(pos);
    }
  });
  const index = { byElement, firstOfCode };
  reportIndexes.set(before, index);
  return index;
}

/** `earlierReport` for many issues against one list: a few scan it, more read an index of it. Same answers. */
function earlierReports(before: readonly ValidationIssue[]): (issue: ValidationIssue) => ValidationIssue | undefined {
  let scans = 0;
  return (issue) => {
    if (scans < 8) {
      scans += 1;
      return earlierReport(before, issue);
    }
    const index = reportIndexOf(before);
    const first = issue.elementIds[0];
    if (first === undefined) {
      const pos = index.firstOfCode.get(issue.code);
      return pos === undefined ? undefined : before[pos];
    }
    for (const pos of index.byElement.get(first) ?? []) {
      const b = before[pos];
      if (b && b.code === issue.code && namesAll(b, issue.elementIds)) return b;
    }
    return undefined;
  };
}

// ── Incremental validation (round 8) ─────────────────────────────────────────

/** Full validation, one connection, element, spacing group and reach check at a time (see validate-ledger.ts). */
const UNIT_CHECKS: UnitChecks<ValidationIssue> = {
  connection: (model, c, out) => connectionIssues(model, c, out),
  element: (model, el, out) => {
    const groupKey = elementIssues(model, el, out);
    return groupKey !== null && placedOf(el) !== null ? groupKey : null;
  },
  group: (model, key, members, out) => {
    spacingIssues(model, key, placedMembers(members), out);
  },
  whole: (model) => disconnectedIssue(model),
  sameWhole: (prior, after, changed) => {
    if (after.connections === prior.connections && sameTopology(prior.elements, after.elements, changed)) return true;
    // Reach changes: give `after` an index derived from the prior one's where that applies, instead of a fresh build.
    if (after.connections === prior.connections) deriveNetwork(prior.elements, after.elements, after.connections, changed);
    return false;
  },
  connectionPosition: (model, c) => {
    for (const pos of networkOf(model).connectionPositionsOf(c.a.elementId)) if (model.connections[pos] === c) return pos;
    return model.connections.indexOf(c);
  },
  connectionsAt: (model, id) => networkOf(model).connectionsOf(id),
  rules: () => activePackSet(),
  // What `firstIssueAfter` re-checks on a valid model: the same rule bounds a sparse ledger's valid checks.
  structural: (prior, after, changed) => {
    if (after.connections !== prior.connections || after.settings !== prior.settings || !sameTopology(prior.elements, after.elements, changed)) return null;
    return [...affectedElements(networkOf(prior), prior.elements, after.elements, changed)];
  },
  groupMembers: (model, key) => networkOf(model).hostedTaps(key),
  groupKeys: (model) => {
    const keys = new Set<ElementId>();
    const slots = elementSlots(model.elements);
    for (let slot = 0; slot < slots.size; slot++) {
      const el = slots.at(slot);
      const at = el ? placedOf(el) : null;
      if (at) keys.add(at.hostId);
    }
    return [...keys];
  },
};

/** Each known issue list's ledger: what produced it, check by check (keyed by the list a model's facts hold). */
const ledgers = new WeakMap<readonly ValidationIssue[], Ledger<ValidationIssue>>();

/** `sparse`: a sparse ledger may answer (an edit made by a command, which `firstIssueAfter`'s rule bounds). */
function ledgerOf(model: ModelState, sparse: boolean): Ledger<ValidationIssue> {
  const known = issuesOf(model);
  const ledger = ledgers.get(known);
  if (ledger && ledger.connections === model.connections && ledger.settings === model.settings && (sparse || !ledger.sparse)) return ledger;
  const built = buildLedger(model, UNIT_CHECKS);
  ledgers.set(known, built);
  return built;
}

export interface IssuesAfterEdit {
  /** Every issue `validateModel(after)` reports, in its order. */
  readonly issues: readonly ValidationIssue[];
  /** True for an issue carried unchanged from `issuesOf(prior)`: the same object as in that list. */
  readonly isCarried: (issue: ValidationIssue) => boolean;
}

/**
 * `validateModel(after)`, where `after` differs from `prior` only in the
 * elements `changed` lists and possibly its connections: only the checks
 * that read something the edit changed run again; every other answer is
 * carried from `prior`'s. The first call on a model with no ledger yet
 * (a head loaded cold) pays one full pass that records what each check reads.
 */
export function issuesAfterEdit(prior: ModelState, after: ModelState, changed: readonly ElementId[]): IssuesAfterEdit {
  return issuesAfter(prior, after, changed, false);
}

function issuesAfter(prior: ModelState, after: ModelState, changed: readonly ElementId[], sparse: boolean): IssuesAfterEdit {
  const known = issuesOf(prior);
  const next = updateLedger(ledgerOf(prior, sparse), prior, after, changed, UNIT_CHECKS);
  ledgers.set(next.issues, next);
  const carried = next.from === known;
  return { issues: next.issues, isCarried: (issue) => carried && !next.fresh.has(issue) };
}

/**
 * Whether an edit from `prior` to `after` may go ahead. It's refused for an
 * issue it creates, and for an issue already open on an element the command
 * itself edited (`touched`) that the edit leaves open: fix it first, or in
 * the same edit. Issues open elsewhere don't block unrelated edits. `base`
 * is `prior` with the edit's connection changes (what `firstIssueAfter`
 * compares against); `after` differs from it only in `changed`.
 */
export function checkEdit(prior: ModelState, base: ModelState, after: ModelState, changed: readonly ElementId[], touched: readonly ElementId[] = changed): EditCheck {
  if (issuesOf(prior).length === 0) return { refusal: firstIssueAfter(base, after, changed), open: [] };
  // `after` is fully derived; compare it with the prior model as derivation leaves it (a head loaded cold may hold stale positions).
  const settled = knownConsistent(prior, () => isFullyDerived(prior)) ? prior : recomputeDerived(prior).model;
  const before = issuesOf(settled);
  if (before.length === 0) return { refusal: validateModel(after)[0] ?? null, open: [] };
  const next = issuesAfter(prior, after, changed, true);
  const all = next.issues;
  const edited = new Set<ElementId>(touched);
  // A carried issue is an object of `before` when `before` is the prior's own list: it has an earlier report.
  const carriedAreEarlier = before === issuesOf(prior);
  const earlierOf = earlierReports(before);
  for (const issue of all) {
    const touchesEdit = namesAny(issue, edited);
    if (!touchesEdit && carriedAreEarlier && next.isCarried(issue)) continue;
    const earlier = earlierOf(issue);
    if (!earlier) return { refusal: issue, open: [] };
    if (touchesEdit) {
      const now = earlier.message === issue.message ? "" : ` (after this edit: "${issue.message}")`;
      return {
        refusal: {
          code: issue.code,
          message: `This edit changes an element with an open issue: "${earlier.message}"${now}. Fix that issue first, or fix it in this same edit.`,
          elementIds: issue.elementIds,
        },
        open: [],
      };
    }
  }
  return { refusal: null, open: all };
}

/**
 * The first issue `validateModel(after)` would report, where `after` differs
 * from `base` only in `changed`. When `base` is known valid, only the
 * connections, elements and tap groups those changes can affect are checked,
 * in the same order as a full validation (under the add-on set in force).
 * "Known valid" counts only under the set it was established under: with a
 * different set in force it is a full pass.
 */
export function firstIssueAfter(base: ModelState, after: ModelState, changed: readonly ElementId[]): ValidationIssue | null {
  const net = networkOf(base);
  const incremental =
    factsPackSet(base) === activePackSet() &&
    after.connections === base.connections &&
    after.settings === base.settings &&
    sameTopology(base.elements, after.elements, changed) &&
    knownValid(base, () => issuesOf(base).length === 0);
  if (!incremental) return validateModel(after)[0] ?? null;

  const affected = affectedElements(net, base.elements, after.elements, changed);
  const issues: ValidationIssue[] = [];

  const positions = new Set<number>();
  for (const id of affected) for (const pos of net.connectionPositionsOf(id)) positions.add(pos);
  for (const pos of [...positions].sort((a, b) => a - b)) {
    const c = after.connections[pos];
    if (c) connectionIssues(after, c, issues);
    if (issues[0]) return issues[0];
  }

  const ordered = sortBy(affected, (id) => net.order.get(id) ?? 0);
  // Spacing groups to recheck: tap's hostId (index key) -> host's own id (group name).
  const hosts = new Map<string, ElementId>();
  for (const id of ordered) {
    const el = after.elements[id];
    if (!el) continue;
    const hostId = elementIssues(after, el, issues);
    const at = hostId === null ? null : placedOf(el);
    if (hostId !== null && at !== null) hosts.set(at.hostId, hostId);
    if (issues[0]) return issues[0];
  }

  // A host's spacing group sits where its first tap sits in element order.
  const groupAt = (key: string): number => net.order.get(net.hostedTaps(key)[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
  for (const key of sortBy(hosts.keys(), groupAt)) {
    const taps = placedMembers(net.hostedTaps(key).map((tapId) => after.elements[tapId]));
    spacingIssues(after, hosts.get(key) ?? asElementId(key), taps, issues);
    if (issues[0]) return issues[0];
  }
  // Reachability depends only on topology, unchanged from the valid base.
  return null;
}

type Elements = Readonly<Record<string, BimElement>>;

/** Changed elements plus the taps they host and whatever points at them: everything whose checks could differ. */
function affectedElements(net: NetworkIndex, base: Elements, model: Elements, changed: Iterable<string>): Set<ElementId> {
  const out = new Set<ElementId>();
  for (const raw of changed) {
    const id = asElementId(raw);
    out.add(id);
    const el = model[id];
    if (el && net.tree.hostsTaps(el.kind)) for (const tapId of net.hostedTaps(id)) out.add(tapId);
    for (const dep of net.dependents(id)) out.add(dep);
    // Routed runs keep their links on both ends: what they link to now, and what they linked to before.
    for (const n of routingNeighbours(model[id])) out.add(n);
    for (const n of routingNeighbours(base[id])) out.add(n);
    // Served-from links keep both ends too.
    for (const n of serviceNeighbours(model[id])) out.add(n);
    for (const n of serviceNeighbours(base[id])) out.add(n);
  }
  return out;
}

// ── Add-on switches (round 9 K9) ───────────────────────────────────────────

/**
 * The facts under the set in force from those under `from`: only checks
 * that read a contribution the two sets answer differently run again (the
 * point index of the record), then "fully derived" is checked once under the
 * new set. Null when the record keeps no usable index or ledger: the cold
 * pass answers.
 */
function translateFacts(model: ModelState, from: PackSet, fromIssues: readonly ValidationIssue[]): ColdFacts | null {
  const prev = fromIssues.length === 0 ? validLedger<ValidationIssue>(model, from) : ledgers.get(fromIssues);
  if (!prev || prev.rules !== from || prev.connections !== model.connections || prev.settings !== model.settings) return null;
  if (!hasUsablePointReads(model)) return null;
  const next = updateLedger(prev, model, model, [], UNIT_CHECKS);
  settlePointReads(model);
  if (next.issues.length > 0) ledgers.set(next.issues, next);
  return { consistent: isFullyDerived(model), issues: next.issues };
}

registerFactsTranslation(translateFacts);

/** Which checks hold a list's issues: connections by id, elements, groups by key, the whole-model check. */
export interface IssueUnits {
  readonly connections: readonly string[];
  readonly elements: readonly ElementId[];
  readonly groups: readonly ElementId[];
  readonly whole: boolean;
}

const NO_ISSUE_UNITS: IssueUnits = { connections: [], elements: [], groups: [], whole: false };

/** The checks holding `issues` (a model's known list), from its ledger; null when it has none. */
export function issueUnitsOf(model: ModelState, issues: readonly ValidationIssue[]): IssueUnits | null {
  if (issues.length === 0) return NO_ISSUE_UNITS;
  const ledger = ledgers.get(issues);
  if (!ledger || ledger.connections !== model.connections || ledger.settings !== model.settings) return null;
  return { connections: [...ledger.byConnection.keys()].map((c) => c.id), elements: [...ledger.byElement.keys()], groups: [...ledger.byGroup.keys()], whole: ledger.whole !== null };
}

function sameIssues(a: readonly ValidationIssue[], b: readonly ValidationIssue[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.code === y.code && x.message === y.message && x.elementIds.length === y.elementIds.length && x.elementIds.every((id, k) => y.elementIds[k] === id);
  });
}

/**
 * `model`'s issues from the checks that held them in a persisted state: those
 * checks run again (into a sparse ledger, every other check known valid), and
 * the answer counts only if it is exactly `expected`; null otherwise.
 */
export function issuesFromUnits(model: ModelState, units: IssueUnits, expected: readonly ValidationIssue[]): readonly ValidationIssue[] | null {
  if (expected.length === 0) return units === NO_ISSUE_UNITS || (units.connections.length === 0 && units.elements.length === 0 && units.groups.length === 0 && !units.whole) ? [] : null;
  const wanted = new Set(units.connections);
  const ends: ElementId[] = [];
  if (wanted.size > 0) for (const c of model.connections) if (wanted.has(c.id)) ends.push(c.a.elementId);
  if (ends.length !== wanted.size) return null;
  const ledger = seedSparseLedger(model, UNIT_CHECKS, { elements: units.elements, connectionsAt: ends, allConnections: false, groups: units.groups, allGroups: false, whole: units.whole });
  if (!ledger || !sameIssues(ledger.issues, expected)) return null;
  ledgers.set(ledger.issues, ledger);
  return ledger.issues;
}

// A new revision keeps its predecessor's point index, with what the edit changed (and can reach) marked to re-run on a switch.
registerRevisionCarry("validate.point-reads", (from, to, changedIds) => {
  if (!hasPointReads(from)) {
    // An index still to be built is wanted on the head the edit made: the host builds it there.
    if (pointReadsWanted.has(from) && !hasPointReads(to)) pointReadsWanted.add(to);
    return;
  }
  const net = knownNetworkOf(from);
  carryPointReads(from, to, net && sameTopology(from, to, changedIds) ? [...affectedElements(net, from, to, changedIds)] : null);
});
