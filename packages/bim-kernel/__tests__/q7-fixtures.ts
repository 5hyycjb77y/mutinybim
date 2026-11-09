/**
 * Round 7 lane Q fixtures: records built directly (walls with doors and
 * windows, a ceiling with a hole, an element type), and commands sent through
 * `planCommit` (the commit path every host uses) with every peer reading every
 * feature unless a test says otherwise. Codes are synthetic (`TEST-0100`),
 * never a licensed list's.
 */
import { asElementId, commandSchema, DEFAULT_SETTINGS, planCommit, withUpgradePolicy, type BimElement, type Changeset, type ModelState, type Vec2 } from "../src";

export const FT = 304.8;
export type Policy = (feature: string) => boolean;
export const ALL: Policy = () => true;

let seq = 0;

export function tryCommit(head: ModelState, command: unknown, policy: Policy = ALL): { ok: true; model: ModelState; changeset: Changeset } | { ok: false; message: string } {
  seq += 1;
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
  const d = withUpgradePolicy(policy, () => planCommit(head, [], { idempotencyKey: `q7-${seq}`, baseRevision: head.revision, actor: { id: "user:test", name: "Test", kind: "human" }, command: parsed.data }, () => "2026-10-30T00:00:00.000Z"));
  return d.ok ? { ok: true, model: d.model, changeset: d.changeset } : { ok: false, message: d.error.message };
}

export function commit(head: ModelState, command: { readonly type: string } & Readonly<Record<string, unknown>>, policy: Policy = ALL): ModelState {
  const r = tryCommit(head, command, policy);
  if (!r.ok) throw new Error(`${command.type}: ${r.message}`);
  return r.model;
}

export function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

const P = { level: "Level 1", zone: "Z1", discipline: "architecture" } as const;

export function wallRecord(id: string, start: Vec2, end: Vec2, extra: Record<string, unknown> = {}): BimElement {
  const record: unknown = { id: asElementId(id), kind: "wall", version: 1, authoredRev: {}, partition: P, start, end, thickness: 150, height: 10 * FT, wallType: "Partition", ...extra };
  return record as BimElement;
}

export function openingRecord(id: string, hostId: string, type: "door" | "window", widthMm: number, heightMm: number, offset = 5 * FT): BimElement {
  const record: unknown = { id: asElementId(id), kind: "opening", version: 1, authoredRev: {}, partition: P, openingType: type, mark: id.toUpperCase(), hostId: asElementId(hostId), offset, width: widthMm, height: heightMm, position: { x: offset, y: 0 } };
  return record as BimElement;
}

export function typeRecord(id: string, name: string, extra: Record<string, unknown> = {}): BimElement {
  const record: unknown = { id: asElementId(id), kind: "element_type", version: 1, authoredRev: {}, partition: P, name, forKinds: ["wall"], ...extra };
  return record as BimElement;
}

export function ceilingRecord(id: string, outline: Vec2[], holes: Vec2[][] = []): BimElement {
  const record: unknown = { id: asElementId(id), kind: "ceiling", version: 1, authoredRev: {}, partition: P, levelId: asElementId("lvl-1"), outline, ...(holes.length ? { holes } : {}), form: "flat", heightMm: 9 * FT };
  return record as BimElement;
}

export function levelRecord(id = "lvl-1"): BimElement {
  const record: unknown = { id: asElementId(id), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  return record as BimElement;
}

export function modelOf(records: readonly BimElement[], modelId = "q7"): ModelState {
  const elements: Record<string, BimElement> = {};
  for (const r of records) elements[r.id] = r;
  return { modelId, revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

/**
 * Three offices along a corridor, divided by walls W-11..W-15; W-12, W-13
 * and W-14 each have a 3 x 7 ft door. Every wall is 15 ft long, 10 ft high,
 * of the "1-hour wall" type.
 */
export function threeOffices(): ModelState {
  const records: BimElement[] = [levelRecord(), typeRecord("t-1hr", "1-hour wall")];
  for (let i = 11; i <= 15; i++) records.push(wallRecord(`W-${i}`, { x: (i - 11) * 12 * FT, y: 0 }, { x: (i - 11) * 12 * FT, y: 15 * FT }, { typeId: asElementId("t-1hr") }));
  for (const i of [12, 13, 14]) records.push(openingRecord(`D-${i}`, `W-${i}`, "door", 3 * FT, 7 * FT));
  return modelOf(records);
}
