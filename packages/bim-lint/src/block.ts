import { partLabelOf, routingIssues, runLabel, type ModelState, type RunIssue } from "@permitzip/bim-kernel";
import { LintDeadline, type LintEngine, type LintRunOptions } from "./engine";
import type { Finding, LintConfig } from "./types";

/**
 * The `lint` block every saved modeling, drafting, view and sheet edit
 * returns: what the edit newly clashes with or broke, what it fixed, and
 * what is around it. Capped (8 findings, 6 nearby things, 160-character
 * messages, 2 KB serialized) so a big model's old findings never flood a
 * tool result; `bim_lint_check` is the full read.
 */

const MM_PER_FT = 304.8;
export const LINT_BLOCK_MAX_BYTES = 2048;
const MAX_NEAR = 6;
/** Past this the block is skipped, never the save: the next call or bim_lint_check picks it up. */
export const LINT_BUDGET_MS = 50;

export interface LintBlockFinding {
  readonly rule: string;
  readonly sev: Finding["severity"];
  readonly ids: readonly string[];
  readonly msg: string;
  readonly fix?: string;
}

export interface LintBlock {
  readonly status: "ok" | "deferred";
  readonly ruleset: LintConfig["ruleset"];
  readonly rev: number;
  readonly ms: number;
  readonly new: readonly LintBlockFinding[];
  readonly resolved: readonly string[];
  readonly near: { readonly level: string | null; readonly room: string | null; readonly host: string | null; readonly radius_ft: number; readonly within: readonly string[] };
  /** Errors open around the edit now: clashes involving what it changed, and other findings in its scope (new and old). */
  readonly open_errors: number;
  readonly truncated: boolean;
  readonly reason?: string;
}

export function blockFinding(f: Finding): LintBlockFinding {
  return {
    rule: f.rule,
    sev: f.severity,
    ids: [...f.elementIds, ...(f.linked ?? []).map((l) => `linked:${l.globalId}`)],
    msg: f.message.length > 160 ? `${f.message.slice(0, 159)}…` : f.message,
    ...(f.fix ? { fix: `${f.fix.tool}: ${f.fix.hint}` } : {}),
  };
}

function byNearness(findings: readonly Finding[], cx: number, cy: number): Finding[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const dist = (f: Finding) => Math.hypot(f.at.x_ft * MM_PER_FT - cx, f.at.y_ft * MM_PER_FT - cy);
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || dist(a) - dist(b) || (a.id < b.id ? -1 : 1));
}

/** Fits the block into the byte cap by dropping the farthest findings, then nearby things. */
export function capBlock(block: LintBlock): LintBlock {
  let out = block;
  const size = (b: LintBlock) => new TextEncoder().encode(JSON.stringify(b)).length;
  while (size(out) > LINT_BLOCK_MAX_BYTES && (out.new.length > 0 || out.resolved.length > 0 || out.near.within.length > 0)) {
    if (out.resolved.length > 4) out = { ...out, resolved: out.resolved.slice(0, -1), truncated: true };
    else if (out.new.length > 1) out = { ...out, new: out.new.slice(0, -1), truncated: true };
    else if (out.near.within.length > 0) out = { ...out, near: { ...out.near, within: out.near.within.slice(0, -1) }, truncated: true };
    else if (out.resolved.length > 0) out = { ...out, resolved: out.resolved.slice(0, -1), truncated: true };
    else out = { ...out, new: [], truncated: true };
  }
  return out;
}

export interface LintEditInput {
  readonly before: ModelState;
  readonly after: ModelState;
  readonly changedIds: readonly string[];
  readonly options: Omit<LintRunOptions, "deadline" | "previous" | "editedByAgent"> & { readonly editedByAgent?: boolean };
  /** Default LINT_BUDGET_MS. */
  readonly budgetMs?: number;
}

/**
 * Lints one saved edit: the engine must hold `before` (callers build it
 * cold when it doesn't); it ends holding `after` either way.
 */
export function lintEdit(engine: LintEngine, input: LintEditInput): LintBlock {
  const t0 = performance.now();
  const { before, after, changedIds, options } = input;
  const config = options.config;
  const budget = input.budgetMs ?? LINT_BUDGET_MS;
  const deadline = t0 + budget;
  const radius = config.scope_radius_ft * MM_PER_FT;
  if (engine.revision !== before.revision) engine.build(before);
  const beforeBoxes = engine.boxesIn(before, changedIds);
  const afterBoxes = engine.boxesIn(after, changedIds);
  const docKinds = new Set(["view", "sheet", "viewport", "drawing_item"]);
  const base = engine.scopeFor(changedIds, beforeBoxes, afterBoxes, radius);
  const documents = changedIds.filter((id) => docKinds.has(before.elements[id]?.kind ?? "") || docKinds.has(after.elements[id]?.kind ?? ""));
  const scope = { ...base, documents, pairsFrom: changedIds };
  const deferred = (reason: string): LintBlock => ({
    status: "deferred",
    ruleset: config.ruleset,
    rev: after.revision,
    ms: Math.round(performance.now() - t0),
    new: [],
    resolved: [],
    near: { level: null, room: null, host: null, radius_ft: config.scope_radius_ft, within: [] },
    open_errors: 0,
    truncated: false,
    reason,
  });
  let beforeFindings: Finding[];
  try {
    beforeFindings = engine.run(scope, { ...options, deadline, previous: null, editedByAgent: false });
  } catch (err) {
    engine.advance(after, changedIds);
    if (err instanceof LintDeadline) return deferred(`Over the ${budget} ms lint budget; call bim_lint_check for this area`);
    throw err;
  }
  engine.advance(after, changedIds);
  let afterFindings: Finding[];
  try {
    afterFindings = engine.run(scope, { ...options, deadline, previous: before, editedByAgent: options.editedByAgent ?? true });
  } catch (err) {
    if (err instanceof LintDeadline) return deferred(`Over the ${budget} ms lint budget; call bim_lint_check for this area`);
    throw err;
  }
  const had = new Set(beforeFindings.map((f) => f.id));
  const has = new Set(afterFindings.map((f) => f.id));
  const box = scope.box;
  const cx = box ? (box.min.x + box.max.x) / 2 : 0;
  const cy = box ? (box.min.y + box.max.y) / 2 : 0;
  const fresh = byNearness(afterFindings.filter((f) => !had.has(f.id)), cx, cy);
  const near = engine.near(changedIds, radius, MAX_NEAR);
  const block: LintBlock = {
    status: "ok",
    ruleset: config.ruleset,
    rev: after.revision,
    ms: 0,
    new: fresh.slice(0, config.max_findings).map(blockFinding),
    resolved: beforeFindings.filter((f) => !has.has(f.id)).map((f) => f.id).sort(),
    near: { level: near.level, room: near.room, host: near.host, radius_ft: config.scope_radius_ft, within: near.within.map((w) => `${w.name} (${w.distanceFt} ft ${w.direction})`) },
    open_errors: afterFindings.filter((f) => f.severity === "error").length,
    truncated: fresh.length > config.max_findings,
  };
  const capped = capBlock(block);
  return { ...capped, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

/** For a refused or conflicting edit: the open issues on the elements the refusal names (what blocks it). */
export function refusalContext(model: ModelState, elementIds: readonly string[]): { readonly blocking: readonly string[] } {
  const issues: RunIssue[] = [];
  for (const id of elementIds.slice(0, 20)) {
    const el = model.elements[id];
    if (el) routingIssues(model.elements, el, model.settings, issues);
  }
  const name = (id: string) => {
    const el = model.elements[id];
    if (el?.kind === "part") return partLabelOf(model.elements, el);
    if (el?.kind === "run_segment" || el?.kind === "run_fitting") return runLabel(model.elements, el);
    return id;
  };
  const seen = new Set<string>();
  const blocking: string[] = [];
  for (const i of issues) {
    if (seen.has(i.message)) continue;
    seen.add(i.message);
    blocking.push(`${i.elementIds.map(name).slice(0, 2).join(", ")}: ${i.message}`.slice(0, 200));
    if (blocking.length >= 4) break;
  }
  return { blocking };
}
