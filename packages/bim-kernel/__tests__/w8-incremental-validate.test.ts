/**
 * @jest-environment node
 *
 * Round 8 lane W: validation after an edit is incremental, and its answer is
 * the full validation's, issue for issue, in the same order.
 *
 * - w8-equivalence: on seeded models that already have open issues, hundreds
 *   of random edits (moves, deletes, re-hosting, re-targeting, connection
 *   cuts and joins, level and type changes, run link edits, put-backs that
 *   fix issues, additions that create them, settings changes), each checked
 *   against `validateModel(after)`, chained through drafts and committed
 *   records, and forked from older revisions.
 * - w8-check-edit-same-answer: `checkEdit` refuses or accepts exactly as the
 *   round-7 algorithm (full validation plus a linear earlier-report search).
 * - w8-commands: real commands on a model with open issues report exactly the
 *   issues full validation finds on their result, and commit.
 *
 * Fails on round 7: there is no `issuesAfterEdit`; `checkEdit` re-validated
 * the whole model on every edit of a model with open issues.
 */
import {
  checkEdit,
  executeCommand,
  incrementalValidationStats,
  isFullyDerived,
  issuesAfterEdit,
  issuesOf,
  planCommit,
  recomputeDerived,
  validateModel,
  type BimElement,
  type Command,
  type Connection,
  type ElementId,
  type ModelState,
  type ValidationIssue,
} from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { knownConsistent, markKnownIssues } from "../src/network";
import { draftElements, freezeElements } from "../src";

const FT = 304.8;
const IN = 25.4;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = { readonly ok: true; readonly issues: readonly ValidationIssue[] } | { readonly ok: false; readonly error: string };

function outcome(fn: () => readonly ValidationIssue[]): Outcome {
  try {
    return { ok: true, issues: fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function plain(o: Outcome): unknown {
  return o.ok ? o.issues.map((i) => ({ code: i.code, message: i.message, elementIds: [...i.elementIds] })) : { error: o.error };
}

function commitLike(model: ModelState): ModelState {
  return { ...model, elements: freezeElements(model.elements) };
}

/** The XS building, plus a level, routed runs and parts with broken references: a model with open issues. */
function seed(modelId: string): ModelState {
  let m: ModelState = { ...createFullBimModel(FULL_BIM_TIERS.XS), modelId };
  const run = (c: Command) => {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    m = r.model;
  };
  const SA = { id: "w8-sys-sa", kind: "supply_air" as const, name: "Supply Air W8" };
  const size = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
  run({ type: "create_level", levelId: "w8-lvl", name: "Level W8", elevationMm: 0 });
  run({ type: "route_run", idPrefix: "w8a", levelId: "w8-lvl", domain: "duct", size, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 20 * FT }] });
  run({ type: "route_run", idPrefix: "w8b", levelId: "w8-lvl", domain: "duct", size, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 40 * FT }, { x: 30 * FT, y: 40 * FT }] });
  const els = draftElements(m.elements);
  const part = (id: string, typeId: string, levelId: string, extra: Record<string, unknown> = {}): BimElement =>
    ({ version: 1, authoredRev: {}, id, kind: "part", typeId, levelId, position: { x: 1000, y: 1000 }, offsetMm: 0, rotationDeg: 0, mark: id, values: {}, ...extra }) as unknown as BimElement;
  for (let i = 0; i < 12; i++) els[`w8-p${i}`] = part(`w8-p${i}`, "w8-no-type", "w8-lvl");
  els["w8-p-nolevel"] = part("w8-p-nolevel", "w8-no-type", "w8-gone-level");
  els["w8-p-served"] = part("w8-p-served", "w8-no-type", "w8-lvl", { served: { c1: "w8-link" }, feeds: ["w8-link-2"] });
  els["w8-link"] = {
    version: 1,
    authoredRev: {},
    id: "w8-link",
    kind: "service_link",
    trade: "plumbing",
    adapter: "w8.loop",
    role: "loop",
    source: { elementId: "w8-p0", positions: [1, 1] },
    members: [{ elementId: "w8-p-served", connector: "c1" }, { elementId: "w8-p1", connector: "c1" }],
    description: "W8 loop",
  } as unknown as BimElement;
  const firstTag = Object.values(m.elements).find((e) => e.kind === "tag");
  if (firstTag) els["w8-tag-missing"] = { ...firstTag, id: "w8-tag-missing", targetId: "w8-nothing" } as unknown as BimElement;
  const out: ModelState = { ...m, elements: els };
  return commitLike(recomputeDerived(out).model);
}

function ids(model: ModelState, kinds: readonly string[]): ElementId[] {
  return Object.values(model.elements)
    .filter((e) => kinds.includes(e.kind))
    .map((e) => e.id);
}

interface Edit {
  readonly label: string;
  readonly after: ModelState;
  readonly changed: readonly ElementId[];
}

const NETWORK_KINDS = ["equipment", "duct_segment", "tap", "elbow", "terminal"];

/** One random edit of `m` (one to three operations), as a draft over its record. */
function randomEdit(m: ModelState, original: ModelState, next: () => number): Edit {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(next() * list.length)];
  const els = draftElements(m.elements);
  let connections: readonly Connection[] = m.connections;
  let settings = m.settings;
  const changed = new Set<ElementId>();
  const labels: string[] = [];
  const put = (el: BimElement) => {
    els[el.id] = el;
    changed.add(el.id);
  };
  const ops = 1 + Math.floor(next() * 3);
  for (let k = 0; k < ops; k++) {
    const roll = next();
    const all = Object.keys(els) as ElementId[];
    if (roll < 0.14) {
      const id = pick(ids({ ...m, elements: els }, ["wall", "duct_segment", "run_segment"]));
      const el = id ? els[id] : undefined;
      if (!el) continue;
      const d = (next() - 0.5) * 3000;
      if (el.kind === "wall" || el.kind === "duct_segment") put({ ...el, end: { ...el.end, x: el.end.x + d } } as BimElement);
      else if (el.kind === "run_segment") put({ ...el, end: { ...el.end, x: el.end.x + d, z: el.end.z + (next() < 0.3 ? 5 : 0) } } as BimElement);
      labels.push(`move ${el.id}`);
    } else if (roll < 0.24) {
      const id = pick(ids({ ...m, elements: els }, ["equipment", "terminal", "elbow", "part"]));
      const el = id ? els[id] : undefined;
      if (!el || !("position" in el)) continue;
      put({ ...el, position: { ...el.position, x: el.position.x + (next() - 0.5) * 2000 } } as BimElement);
      labels.push(`nudge ${el.id}`);
    } else if (roll < 0.36) {
      const id = pick(all);
      const el = id ? els[id] : undefined;
      if (!el) continue;
      delete els[el.id];
      changed.add(el.id);
      // Usually the connections at a deleted end go with it; sometimes they dangle (validation then throws, both ways).
      if (next() < 0.8) connections = connections.filter((c) => c.a.elementId !== el.id && c.b.elementId !== el.id);
      labels.push(`delete ${el.kind} ${el.id}`);
    } else if (roll < 0.46) {
      const id = pick(ids({ ...m, elements: els }, ["opening", "tap"]));
      const el = id ? els[id] : undefined;
      if (!el) continue;
      if (el.kind === "opening") {
        const host = next() < 0.8 ? pick(ids({ ...m, elements: els }, ["wall"])) : ("w8-no-wall" as ElementId);
        if (host) put({ ...el, hostId: host, offset: next() < 0.5 ? el.offset : el.offset + (next() - 0.5) * 4000 } as BimElement);
      } else if (el.kind === "tap") {
        const host = next() < 0.85 ? pick(ids({ ...m, elements: els }, ["duct_segment"])) : ("w8-no-host" as ElementId);
        if (host) put({ ...el, hostId: next() < 0.4 ? el.hostId : host, s: Math.max(0, el.s + (next() - 0.5) * 6000) } as BimElement);
      }
      labels.push(`re-host ${el.id}`);
    } else if (roll < 0.53) {
      const id = pick(ids({ ...m, elements: els }, ["tag", "dimension"]));
      const el = id ? els[id] : undefined;
      if (!el) continue;
      const target = next() < 0.8 ? pick(all) : ("w8-nothing" as ElementId);
      if (!target) continue;
      if (el.kind === "tag") put({ ...el, targetId: target } as BimElement);
      else if (el.kind === "dimension") put({ ...el, aId: target } as BimElement);
      labels.push(`re-target ${el.id}`);
    } else if (roll < 0.6) {
      const id = pick(ids({ ...m, elements: els }, ["part"]));
      const el = id ? els[id] : undefined;
      if (!el || el.kind !== "part") continue;
      const level = next() < 0.6 ? "w8-lvl" : "w8-gone-level";
      put({ ...el, levelId: level as ElementId, typeId: (next() < 0.5 ? el.typeId : "w8-other-type") as ElementId } as BimElement);
      labels.push(`re-type ${el.id}`);
    } else if (roll < 0.68) {
      if (next() < 0.5 && connections.length > 0) {
        const at = Math.floor(next() * connections.length);
        const cut = connections[at];
        connections = connections.filter((_, i) => i !== at);
        labels.push(`cut ${cut?.id ?? "?"}`);
      } else {
        const net = ids({ ...m, elements: els }, NETWORK_KINDS);
        const a = pick(net);
        const b = pick(net);
        if (!a || !b) continue;
        const endFor = (id: ElementId) => {
          const kind = els[id]?.kind;
          return kind === "equipment" ? "out" : kind === "duct_segment" ? (next() < 0.5 ? "start" : "end") : kind === "tap" ? (next() < 0.5 ? "branch" : "host") : kind === "elbow" ? (next() < 0.5 ? "in" : "out") : "in";
        };
        const c = { id: `w8-c-${Math.floor(next() * 1e9)}`, a: { elementId: a, end: endFor(a) }, b: { elementId: b, end: endFor(b) } } as unknown as Connection;
        connections = next() < 0.7 ? [...connections, c] : [c, ...connections];
        labels.push(`join ${a}-${b}`);
      }
    } else if (roll < 0.76) {
      // Put an original element back (fixes what the edits broke; may refill a deleted id).
      const id = pick(Object.keys(original.elements) as ElementId[]);
      const el = id ? original.elements[id] : undefined;
      if (!el || els[el.id] === el) continue;
      put(el);
      if (next() < 0.5) {
        const back = original.connections.filter((c) => (c.a.elementId === el.id || c.b.elementId === el.id) && !connections.includes(c));
        if (back.length > 0) connections = [...connections, ...back];
      }
      labels.push(`restore ${el.id}`);
    } else if (roll < 0.84) {
      const n = Math.floor(next() * 1e9);
      const kind = next();
      const target = pick(all);
      if (!target) continue;
      if (kind < 0.3) {
        const tag = Object.values(els).find((e) => e.kind === "tag");
        if (tag) put({ ...tag, id: `w8-new-tag-${n}`, targetId: target } as BimElement);
      } else if (kind < 0.55) {
        const wall = Object.values(els).find((e) => e.kind === "wall");
        if (wall && wall.kind === "wall") put({ ...wall, id: `w8-new-wall-${n}`, end: { x: wall.start.x + (next() < 0.5 ? 50 : 3000), y: wall.start.y } } as BimElement);
      } else if (kind < 0.8) {
        const tap = Object.values(els).find((e) => e.kind === "tap");
        const host = pick(ids({ ...m, elements: els }, ["duct_segment"]));
        if (tap && host) put({ ...tap, id: `w8-new-tap-${n}`, hostId: host, s: 500 + next() * 3000 } as BimElement);
      } else {
        put({ version: 1, authoredRev: {}, id: `w8-new-part-${n}`, kind: "part", typeId: "w8-no-type", levelId: "w8-lvl", position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: "", values: {} } as unknown as BimElement);
      }
      labels.push(`add near ${target}`);
    } else if (roll < 0.9) {
      const level = els["w8-lvl"];
      if (level && level.kind === "level") {
        if (next() < 0.7) put({ ...level, elevationMm: level.elevationMm + 100 } as BimElement);
        else {
          delete els["w8-lvl"];
          changed.add("w8-lvl" as ElementId);
        }
      } else {
        const back = original.elements["w8-lvl"];
        if (back) put(back);
      }
      labels.push("level");
    } else if (roll < 0.96) {
      const id = pick(ids({ ...m, elements: els }, ["run_segment", "run_fitting"]));
      const el = id ? els[id] : undefined;
      if (!el) continue;
      if (el.kind === "run_segment") {
        const other = pick(ids({ ...m, elements: els }, ["run_segment", "run_fitting", "part"]));
        put({ ...el, links: { ...el.links, start: other ? { elementId: other, port: "end" } : undefined } } as BimElement);
      } else if (el.kind === "run_fitting") {
        delete els[el.id];
        changed.add(el.id);
      }
      labels.push(`link ${el.id}`);
    } else {
      settings = { ...settings, minStraightMm: settings.minStraightMm + 50 };
      labels.push("settings");
    }
  }
  return { label: labels.join("; "), after: { ...m, elements: els, connections, settings }, changed: [...changed] };
}

/** Round 7's checkEdit, verbatim but for the names: full validation and a linear search. */
function roundSevenCheck(prior: ModelState, after: ModelState, changed: readonly ElementId[], touched: readonly ElementId[]): { refusal: ValidationIssue | null; open: readonly ValidationIssue[] } {
  const earlier = (before: readonly ValidationIssue[], issue: ValidationIssue) => before.find((b) => b.code === issue.code && issue.elementIds.every((id) => b.elementIds.includes(id)));
  if (issuesOf(prior).length === 0) return { refusal: validateModel(after)[0] ?? null, open: [] };
  const settled = knownConsistent(prior, () => isFullyDerived(prior)) ? prior : recomputeDerived(prior).model;
  const before = issuesOf(settled);
  if (before.length === 0) return { refusal: validateModel(after)[0] ?? null, open: [] };
  const all = validateModel(after);
  const edited = new Set<ElementId>(touched);
  for (const issue of all) {
    const e = earlier(before, issue);
    if (!e) return { refusal: issue, open: [] };
    if (issue.elementIds.some((id) => edited.has(id))) {
      const now = e.message === issue.message ? "" : ` (after this edit: "${issue.message}")`;
      return { refusal: { code: issue.code, message: `This edit changes an element with an open issue: "${e.message}"${now}. Fix that issue first, or fix it in this same edit.`, elementIds: issue.elementIds }, open: [] };
    }
  }
  void changed;
  return { refusal: null, open: all };
}

describe("w8 incremental validation", () => {
  it("w8-equivalence: random edits on models with open issues match full validation, issue for issue", () => {
    const original = seed("w8-eq");
    const open = validateModel(original);
    expect(open.length).toBeGreaterThan(10);
    let checked = 0;
    let threw = 0;
    let emptied = 0;
    let settingsEdits = 0;
    const stats0 = incrementalValidationStats();
    for (const s of [1, 2, 3, 4]) {
      const next = rng(s * 7919);
      let head = original;
      const history: ModelState[] = [original];
      for (let step = 0; step < 120; step++) {
        // Sometimes fork from an older revision: what one branch recorded must not mislead another.
        const base = next() < 0.1 ? (history[Math.floor(next() * history.length)] ?? head) : head;
        const edit = randomEdit(base, original, next);
        const expected = outcome(() => validateModel(edit.after));
        const got = outcome(() => issuesAfterEdit(base, edit.after, edit.changed).issues);
        if (JSON.stringify(plain(got)) !== JSON.stringify(plain(expected))) {
          throw new Error(`seed ${s} step ${step} (${edit.label}): incremental ${JSON.stringify(plain(got)).slice(0, 2000)} vs full ${JSON.stringify(plain(expected)).slice(0, 2000)}`);
        }
        checked += 1;
        if (edit.after.settings !== base.settings) settingsEdits += 1;
        if (!got.ok) {
          threw += 1;
          continue;
        }
        if (got.issues.length === 0) emptied += 1;
        // Carry on from the edit, as a draft or as a committed record (with the issues the commit would record).
        const nextHead = next() < 0.5 ? edit.after : commitLike(edit.after);
        markKnownIssues(nextHead, got.issues);
        head = nextHead;
        history.push(head);
        // A head with no open issues takes the valid path; bring the broken seed back now and then.
        if (got.issues.length === 0) head = original;
      }
    }
    const stats1 = incrementalValidationStats();
    const fullPasses = stats1.fullPasses - stats0.fullPasses;
    const updates = stats1.updates - stats0.updates;
    const perUpdate = (stats1.unitsRerun - stats0.unitsRerun) / Math.max(1, updates);
    const size = Object.keys(original.elements).length + original.connections.length;
    process.stderr.write(`[w8 equivalence] ${checked} edits compared (${threw} threw both ways, ${emptied} left no issues, ${settingsEdits} changed settings); ${fullPasses} full passes, ${updates} updates re-running ${perUpdate.toFixed(1)} of ${size} checks each\n`);
    expect(checked).toBe(480);
    // Incremental, not a full pass in disguise: full passes only for settings changes, throwing edits and the first ledger.
    expect(fullPasses).toBeLessThanOrEqual(settingsEdits + threw + 2);
    expect(perUpdate).toBeLessThan(size / 20);
  });

  it("w8-check-edit-same-answer: refusals and open issues are round 7's", () => {
    const original = seed("w8-check");
    const next = rng(424242);
    let head = original;
    let refused = 0;
    let accepted = 0;
    for (let step = 0; step < 200; step++) {
      const edit = randomEdit(head, original, next);
      const touched = edit.changed.filter(() => next() < 0.7);
      const base: ModelState = { ...head, connections: edit.after.connections };
      const run = (fn: () => { refusal: ValidationIssue | null; open: readonly ValidationIssue[] }) => {
        try {
          const r = fn();
          return { refusal: r.refusal ? { ...r.refusal, elementIds: [...r.refusal.elementIds] } : null, open: r.open.map((i) => ({ ...i, elementIds: [...i.elementIds] })) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      };
      const expected = run(() => roundSevenCheck(head, edit.after, edit.changed, touched));
      const got = run(() => checkEdit(head, base, edit.after, edit.changed, touched));
      expect({ step, label: edit.label, got }).toEqual({ step, label: edit.label, got: expected });
      if ("refusal" in got && got.refusal === null && got.open.length > 0) {
        accepted += 1;
        const committed = commitLike(edit.after);
        const opened = issuesAfterEdit(head, edit.after, edit.changed).issues;
        markKnownIssues(committed, opened);
        head = committed;
      } else refused += 1;
    }
    process.stderr.write(`[w8 check-edit] ${accepted} accepted, ${refused} refused or no longer broken\n`);
    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(20);
  });

  it("w8-commands: real commands on a broken model report exactly the open issues and commit", () => {
    let head = seed("w8-commands");
    const walls = ids(head, ["wall"]);
    const tags = ids(head, ["tag"]).filter((id) => id !== "w8-tag-missing");
    const taps = ids(head, ["tap"]);
    const equipment = ids(head, ["equipment"]);
    const terminals = ids(head, ["terminal"]);
    const next = rng(99);
    let n = 0;
    let ok = 0;
    for (let step = 0; step < 60; step++) {
      const pick = (list: readonly ElementId[]) => list[Math.floor(next() * list.length)] ?? "";
      const roll = next();
      const command: Command =
        roll < 0.25
          ? { type: "move_wall", wallId: pick(walls), delta: { x: (next() - 0.5) * 400, y: 0 } }
          : roll < 0.45
            ? { type: "move_tag", tagId: pick(tags), offset: { x: 30, y: 30 } }
            : roll < 0.6
              ? { type: "slide_branch", tapId: pick(taps), s: 2000 + next() * 4000 }
              : roll < 0.75
                ? { type: "move_equipment", equipmentId: pick(equipment), delta: { x: 20, y: 0 } }
                : roll < 0.9
                  ? { type: "set_terminal_cfm", terminalId: pick(terminals), cfm: 100 + Math.floor(next() * 400) }
                  : { type: "delete_elements", ids: [pick(tags)], policy: "refuse" };
      const r = executeCommand(head, command);
      if (!r.ok) continue;
      expect(JSON.stringify(r.openIssues ?? [])).toBe(JSON.stringify(validateModel(r.model)));
      n += 1;
      const d = planCommit(head, [], { idempotencyKey: `w8-${n}`, baseRevision: head.revision, actor: { id: "agent", name: "Agent", kind: "agent" }, command }, () => "2026-11-01T00:00:00.000Z", []);
      if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
      expect(JSON.stringify(issuesOf(d.model))).toBe(JSON.stringify(validateModel(d.model)));
      head = d.model;
      ok += 1;
    }
    expect(ok).toBeGreaterThan(30);
    expect(validateModel(head).length).toBeGreaterThan(0);
  });
});

