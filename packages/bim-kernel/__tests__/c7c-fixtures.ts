/**
 * Round 7 lane C fixtures: a two-storey model with Office 101 (20 x 15 ft)
 * on Level 1, its stated ceiling height 9 ft, Level 2 at 13 ft. Commands go
 * through `planCommit` (the commit path every host uses) under an upgrade
 * policy: by default every peer reads every feature. `summaryOf` runs the
 * command alone to read what it says.
 */
import { commandSchema, DEFAULT_SETTINGS, executeCommand, planCommit, withUpgradePolicy, type ModelState, type Vec2 } from "../src";

export const FT = 304.8;
export type Policy = (feature: string) => boolean;
export const ALL: Policy = () => true;

let seq = 0;

export function tryCommit(head: ModelState, command: unknown, policy: Policy = ALL): { ok: true; model: ModelState } | { ok: false; message: string } {
  seq += 1;
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
  const d = withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `c7c-${seq}`, baseRevision: head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command: parsed.data }, () => "2026-10-30T00:00:00.000Z"));
  return d.ok ? { ok: true, model: d.model } : { ok: false, message: d.error.message };
}

export function commit(head: ModelState, command: { readonly type: string } & Readonly<Record<string, unknown>>, policy: Policy = ALL): ModelState {
  const r = tryCommit(head, command, policy);
  if (!r.ok) throw new Error(`${command.type}: ${r.message}`);
  return r.model;
}

/** What a command says when it runs (its summary lines), or its refusal. */
export function summaryOf(head: ModelState, command: unknown, policy: Policy = ALL): readonly string[] {
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "unparsed");
  const r = withUpgradePolicy(policy, () => executeCommand(head, parsed.data));
  if (!r.ok) throw new Error(r.error.message);
  return r.summary ?? [];
}

export function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export const OFFICE = rect(0, 0, 20 * FT, 15 * FT);

export function officeModel(modelId = "c7c"): ModelState {
  let m: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 13 * FT });
  return commit(m, { type: "create_space", spaces: [{ spaceId: "s101", number: "101", name: "Office", levelId: "lvl-1", outline: OFFICE, ceilingHeightMm: 9 * FT }] });
}
