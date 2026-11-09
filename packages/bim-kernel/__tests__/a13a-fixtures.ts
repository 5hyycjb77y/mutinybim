/**
 * Round 13 lane A13a fixtures: an empty two-level model, and a log that
 * commits through `planCommit` (the path every host uses), checks each
 * changeset replays to the same model, and can undo. Every peer reads every
 * feature unless a test passes its own policy.
 */
import { applyChangeset, canonicalJson, commandSchema, DEFAULT_SETTINGS, planCommit, withUpgradePolicy, type BimElement, type Changeset, type ModelState } from "../src";

export type Policy = (feature: string) => boolean;
export const ALL: Policy = () => true;
type RawCommand = { readonly type: string } & Readonly<Record<string, unknown>>;

const NOW = () => "2026-11-04T00:00:00.000Z";
let seq = 0;

export class Log {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }

  submit(command: RawCommand, policy: Policy = ALL): { ok: true; changeset: Changeset } | { ok: false; message: string } {
    seq += 1;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
    const req = { idempotencyKey: `a13a-${seq}`, baseRevision: this.head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" as const }, command: parsed.data };
    const d = withUpgradePolicy(policy, () => planCommit(this.head, [], req, NOW, this.log));
    if (!d.ok) return { ok: false, message: d.error.message };
    expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
    this.head = d.model;
    this.log.push(d.changeset);
    return { ok: true, changeset: d.changeset };
  }

  ok(command: RawCommand, policy: Policy = ALL): Changeset {
    const r = this.submit(command, policy);
    if (!r.ok) throw new Error(`${command.type} refused: ${r.message}`);
    return r.changeset;
  }

  refused(command: RawCommand, policy: Policy = ALL): string {
    const r = this.submit(command, policy);
    if (r.ok) throw new Error(`${command.type} was accepted`);
    return r.message;
  }
}

/** Level 1 at 0, Level 2 at 4 m. */
export function twoLevels(modelId = "a13a"): Log {
  const m = new Log({ modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 4000 });
  return m;
}

/** The element with this id, or a thrown error naming it. */
export function element(m: ModelState, id: string): BimElement {
  const el = m.elements[id];
  if (!el) throw new Error(`no element ${id}`);
  return el;
}
