// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { z } from "zod";
import { distance, round, roundVec, scale, sub, unit } from "../../src/geometry";
import { KernelError, TrackedReader, connectionAt, otherEnd, requireKind, tapPosition } from "./model";
import { recomputeDerived } from "./derived";
import { Propagator } from "./solver";
import { canonicalJson } from "../../src/canonical";
import { validateModel, type ValidationIssue } from "./validate";
import {
  asElementId,
  type BimElement,
  type ElementId,
  type ModelState,
  type Profile,
  type Vec2,
} from "./types";
import type { KernelErrorCode } from "./model";

const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const profileSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("rect"), width: z.number().positive(), height: z.number().positive() }),
  z.object({ shape: z.literal("round"), diameter: z.number().positive() }),
]);

/** Intent commands. Humans and agents send exactly these; nothing else. */
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("slide_branch"), tapId: z.string().min(1), s: z.number().finite() }),
  z.object({ type: z.literal("set_terminal_cfm"), terminalId: z.string().min(1), cfm: z.number().min(0).max(20000) }),
  z.object({ type: z.literal("resize_run"), segmentId: z.string().min(1), profile: profileSchema }),
  z.object({ type: z.literal("move_equipment"), equipmentId: z.string().min(1), delta: vec2Schema }),
]);
export type Command = z.infer<typeof commandSchema>;

export type AuthoredValue = number | Vec2 | Profile;

/** An explicitly chosen value. Competing authored values conflict. */
export interface AuthoredWrite {
  readonly elementId: ElementId;
  readonly field: string;
  readonly value: AuthoredValue;
}

/**
 * A serializable statement of what a command meant. Stored with the
 * changeset so later commits that propagate geometry can check they still
 * hold, and conflict instead of silently undoing someone's work.
 */
export type IntentPredicate =
  | { readonly kind: "tap_at"; readonly tapId: ElementId; readonly position: Vec2 }
  | { readonly kind: "field_equals"; readonly elementId: ElementId; readonly field: string; readonly value: AuthoredValue };

export interface CommandError {
  readonly code: KernelErrorCode | "stale_base" | "conflict" | "forbidden";
  readonly message: string;
  readonly elementIds: readonly ElementId[];
  readonly limit?: SlideLimit;
}

export interface ExecuteOk {
  readonly ok: true;
  /** New state with derived values recomputed (revision not yet bumped). */
  readonly model: ModelState;
  readonly changedIds: readonly ElementId[];
  /** Server-derived: every element read, with the version seen. */
  readonly readSet: Readonly<Record<string, number>>;
  readonly authored: readonly AuthoredWrite[];
  readonly intents: readonly IntentPredicate[];
  /** Issues open before the edit that it left alone (bug log #18). */
  readonly openIssues?: readonly ValidationIssue[];
}

export interface ExecuteErr {
  readonly ok: false;
  readonly error: CommandError;
}

export type ExecuteResult = ExecuteOk | ExecuteErr;

export interface SlideLimit {
  readonly requested: number;
  readonly accepted: number;
  readonly binding: { readonly code: CommandError["code"]; readonly message: string } | null;
}

export function authoredFieldValue(el: BimElement, field: string): AuthoredValue | undefined {
  switch (field) {
    case "s":
      return el.kind === "tap" ? el.s : undefined;
    case "cfm":
      return el.kind === "terminal" ? el.cfm : undefined;
    case "profile":
      return "profile" in el ? el.profile : undefined;
    case "position":
      return el.kind === "equipment" ? el.position : undefined;
    default:
      return undefined;
  }
}

export function sameValue(a: AuthoredValue | undefined, b: AuthoredValue | undefined): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

export function intentHolds(model: ModelState, intent: IntentPredicate): boolean {
  const el = model.elements[intent.kind === "tap_at" ? intent.tapId : intent.elementId];
  if (!el) return false;
  if (intent.kind === "tap_at") {
    return el.kind === "tap" && distance(el.position, intent.position) <= model.settings.connectorToleranceMm;
  }
  return sameValue(authoredFieldValue(el, intent.field), intent.value);
}

export function describeIntent(intent: IntentPredicate): string {
  if (intent.kind === "tap_at") return `${intent.tapId} placed at its chosen position`;
  return `${intent.elementId}.${intent.field} set explicitly`;
}

function firstIssueError(issues: ValidationIssue[]): ExecuteErr | null {
  const issue = issues[0];
  if (!issue) return null;
  return { ok: false, error: { code: issue.code, message: issue.message, elementIds: issue.elementIds } };
}

/**
 * Bug log #18 (2026-10-23): issues already open don't block an unrelated edit.
 * Refused: an issue the edit creates (no earlier report with its code naming
 * all its elements), or an issue still open on an element the command edited.
 * Written out plainly here; the kernel's `checkEdit` must decide the same.
 */
function openIssueError(before: ValidationIssue[], after: ValidationIssue[], touched: ReadonlySet<ElementId>): ExecuteErr | null {
  if (before.length === 0) return firstIssueError(after);
  for (const issue of after) {
    const earlier = before.find((b) => b.code === issue.code && issue.elementIds.every((id) => b.elementIds.includes(id)));
    if (!earlier) return firstIssueError([issue]);
    if (issue.elementIds.some((id) => touched.has(id))) {
      const now = earlier.message === issue.message ? "" : ` (after this edit: "${issue.message}")`;
      return firstIssueError([{ code: issue.code, message: `This edit changes an element with an open issue: "${earlier.message}"${now}. Fix that issue first, or fix it in this same edit.`, elementIds: issue.elementIds }]);
    }
  }
  return null;
}

function finish(
  reader: TrackedReader,
  working: Record<string, BimElement>,
  touched: Iterable<ElementId>,
  authored: AuthoredWrite[],
  intentsFor: (model: ModelState) => IntentPredicate[],
): ExecuteResult {
  const draft: ModelState = { ...reader.model, elements: working };
  const derived = recomputeDerived(draft);
  const touchedIds = new Set<ElementId>(touched);
  const after = validateModel(derived.model);
  const before = after.length === 0 ? [] : validateModel(recomputeDerived(reader.model).model);
  const err = openIssueError(before, after, touchedIds);
  if (err) return err;
  const changed = new Set<ElementId>([...touchedIds, ...derived.changedIds]);
  return {
    ok: true,
    model: derived.model,
    changedIds: [...changed],
    readSet: reader.readSet(),
    authored,
    intents: intentsFor(derived.model),
    ...(after.length > 0 ? { openIssues: after } : {}),
  };
}

function guard(fn: () => ExecuteResult): ExecuteResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KernelError) {
      return { ok: false, error: { code: err.code, message: err.message, elementIds: err.elementIds } };
    }
    throw err;
  }
}

/** Collect a run: the segment plus connected segments/elbows sharing its profile, stopping at taps, terminals, equipment. */
function collectRun(reader: TrackedReader, segmentId: ElementId): { runIds: ElementId[]; upstreamTapId: ElementId | null } {
  const start = requireKind(reader.get(segmentId), "duct_segment");
  const runIds: ElementId[] = [];
  const seen = new Set<ElementId>();
  const stack: ElementId[] = [start.id];
  let upstreamTapId: ElementId | null = null;
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const el = reader.get(id);
    if (el.kind === "tap") {
      upstreamTapId = el.id;
      continue;
    }
    if (el.kind !== "duct_segment" && el.kind !== "elbow") continue;
    runIds.push(el.id);
    for (const c of reader.connectionsOf(el.id)) {
      const mine = c.a.elementId === el.id ? c.a : c.b;
      stack.push(otherEnd(c, mine).elementId);
    }
  }
  return { runIds, upstreamTapId };
}

export function executeCommand(model: ModelState, command: Command): ExecuteResult {
  return guard(() => {
    const reader = new TrackedReader(model);
    switch (command.type) {
      case "slide_branch": {
        const tap = requireKind(reader.get(asElementId(command.tapId)), "tap");
        const host = requireKind(reader.get(tap.hostId), "duct_segment");
        const axis = unit(sub(host.end, host.start));
        const d = roundVec(scale(axis, command.s - tap.s));
        const p = new Propagator(reader);
        p.set({ ...tap, s: round(command.s) });
        p.pushAcross({ elementId: tap.id, end: "branch" }, d);
        return finish(
          reader,
          p.working,
          p.touched,
          [{ elementId: tap.id, field: "s", value: round(command.s) }],
          (m) => {
            const placed = m.elements[tap.id];
            return placed && placed.kind === "tap"
              ? [{ kind: "tap_at", tapId: tap.id, position: placed.position }]
              : [];
          },
        );
      }
      case "set_terminal_cfm": {
        const terminal = requireKind(reader.get(asElementId(command.terminalId)), "terminal");
        const working = { ...model.elements, [terminal.id]: { ...terminal, cfm: command.cfm } };
        const authored: AuthoredWrite[] = [{ elementId: terminal.id, field: "cfm", value: command.cfm }];
        return finish(reader, working, [terminal.id], authored, () => [
          { kind: "field_equals", elementId: terminal.id, field: "cfm", value: command.cfm },
        ]);
      }
      case "resize_run": {
        const { runIds, upstreamTapId } = collectRun(reader, asElementId(command.segmentId));
        const p = new Propagator(reader);
        const authored: AuthoredWrite[] = [];
        for (const id of runIds) {
          const el = reader.get(id);
          if (el.kind === "duct_segment" || el.kind === "elbow") {
            p.set({ ...el, profile: command.profile });
            authored.push({ elementId: id, field: "profile", value: command.profile });
          }
        }
        if (upstreamTapId) {
          const tap = requireKind(reader.get(upstreamTapId), "tap");
          p.set({ ...tap, profile: command.profile });
          authored.push({ elementId: tap.id, field: "profile", value: command.profile });
        }
        // A wider or narrower host moves the face its taps sit on; push that into each branch.
        for (const id of runIds) {
          const resized = p.working[id];
          if (!resized || resized.kind !== "duct_segment") continue;
          for (const other of Object.values(p.working)) {
            if (other.kind !== "tap" || other.hostId !== id) continue;
            reader.get(other.id);
            const moved = roundVec(tapPosition(resized, other));
            p.set({ ...other, position: moved });
            p.pushAcross({ elementId: other.id, end: "branch" }, roundVec(sub(moved, other.position)));
          }
        }
        return finish(reader, p.working, p.touched, authored, () =>
          authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })),
        );
      }
      case "move_equipment": {
        const eq = requireKind(reader.get(asElementId(command.equipmentId)), "equipment");
        const d = roundVec(command.delta);
        const p = new Propagator(reader);
        const position = roundVec({ x: eq.position.x + d.x, y: eq.position.y + d.y });
        p.set({ ...eq, position });
        const out = connectionAt(model, { elementId: eq.id, end: "out" });
        if (out) p.translateInto(otherEnd(out, { elementId: eq.id, end: "out" }), d);
        return finish(reader, p.working, p.touched, [{ elementId: eq.id, field: "position", value: position }], () => [
          { kind: "field_equals", elementId: eq.id, field: "position", value: position },
        ]);
      }
    }
  });
}

/**
 * The furthest valid position toward a requested slide, and the constraint
 * that stops it. Used for the drag preview: we never silently clamp; the UI
 * shows the binding constraint and commits the accepted position.
 */
export function slideLimit(model: ModelState, tapId: string, requested: number): SlideLimit {
  const tap = model.elements[tapId];
  if (!tap || tap.kind !== "tap") {
    return { requested, accepted: requested, binding: { code: "element_not_found", message: `${tapId} not found` } };
  }
  // Walk the drag path: a slide may not pass *through* an invalid stretch
  // (e.g. a run shorter than its minimum) even if the far side is valid.
  const startS = tap.s;
  const dir = Math.sign(requested - startS);
  let lastValid = startS;
  let binding: SlideLimit["binding"] = null;
  for (const step of [100, 10, 1]) {
    let s = lastValid;
    while (dir !== 0 && (dir > 0 ? s + step * dir <= requested : s + step * dir >= requested)) {
      const candidate = s + step * dir;
      const res = executeCommand(model, { type: "slide_branch", tapId, s: candidate });
      if (!res.ok) {
        binding = { code: res.error.code, message: res.error.message };
        break;
      }
      s = candidate;
    }
    lastValid = s;
  }
  if (!binding) {
    const final = executeCommand(model, { type: "slide_branch", tapId, s: requested });
    if (final.ok) return { requested, accepted: requested, binding: null };
    binding = { code: final.error.code, message: final.error.message };
  }
  return { requested, accepted: round(lastValid), binding };
}
