/**
 * @jest-environment node
 *
 * `batch_edits`: many model edits committed as one changeset, one revision
 * and one undo step (a 500-cell schedule paste). Before it, a paste was 500
 * commands: 500 revisions, and undo took back one cell.
 */
import { MAX_EDIT_BATCH_STEPS, canonicalJson, commandSchema, executeCommand, planCommit, type Changeset, type Command, type ModelState, type ScheduleDefinition } from "../src";
import { openSchedule, scheduleV1ToV2, type RowSet } from "../src/schedules/engine";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown, history: readonly Changeset[] = []): { model: ModelState; changeset: Changeset } {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `edit-batch-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-25T00:00:00.000Z", history);
  if (!d.ok) throw new Error(d.error.message);
  return { model: d.model, changeset: d.changeset };
}

function terminals(model: ModelState): string[] {
  return Object.values(model.elements)
    .filter((el) => el.kind === "terminal")
    .map((el) => el.id)
    .sort();
}

const cfmOf = (model: ModelState, id: string): number | undefined => {
  const el = model.elements[id];
  return el?.kind === "terminal" ? el.cfm : undefined;
};

function paste(ids: readonly string[], base: number): Command {
  return commandSchema.parse({ type: "batch_edits", label: `Paste ${ids.length} CFM values`, commands: ids.map((terminalId, i) => ({ type: "set_terminal_cfm", terminalId, cfm: base + (i % 40) * 5 })) });
}

/** A RowSet as plain data: row keys, element ids and every column's values. */
function comparable(set: RowSet) {
  return {
    rowCount: set.rowCount,
    elementIds: [...set.elementIds],
    values: set.columns.map((c) => {
      const v = set.values.get(c.id);
      return [c.id, v ? Array.from(v.values as ArrayLike<unknown>) : null];
    }),
  };
}

describe("batch_edits", () => {
  const start = createFullBimModel(FULL_BIM_TIERS.XS);
  const ids = terminals(start);

  it("is a command: the schema reads it and caps it at 500 steps", () => {
    expect(ids.length).toBeGreaterThan(20);
    expect(commandSchema.safeParse({ type: "batch_edits", commands: [{ type: "set_terminal_cfm", terminalId: ids[0], cfm: 150 }] }).success).toBe(true);
    const tooMany = Array.from({ length: MAX_EDIT_BATCH_STEPS + 1 }, () => ({ type: "set_terminal_cfm", terminalId: ids[0], cfm: 150 }));
    expect(commandSchema.safeParse({ type: "batch_edits", commands: tooMany }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "batch_edits", commands: [{ type: "batch_edits", commands: [] }] }).success).toBe(false);
  });

  it("commits every cell as one revision and one changeset", () => {
    const { model, changeset } = commit(start, paste(ids, 200));
    expect(model.revision).toBe(start.revision + 1);
    expect(changeset.revision).toBe(model.revision);
    for (const [i, id] of ids.entries()) expect(cfmOf(model, id)).toBe(200 + (i % 40) * 5);
    expect(new Set(changeset.authored.map((a) => a.elementId))).toEqual(new Set(ids));
    expect(changeset.elements.map((el) => el.id)).toEqual(expect.arrayContaining(ids));
  });

  it("undoes the whole paste in one step", () => {
    const pasted = commit(start, paste(ids, 300));
    const undone = commit(pasted.model, { type: "undo", revision: pasted.changeset.revision }, [pasted.changeset]);
    expect(undone.model.revision).toBe(pasted.model.revision + 1);
    for (const id of ids) expect(cfmOf(undone.model, id)).toBe(cfmOf(start, id));
  });

  it("is all or nothing, naming the step that was refused", () => {
    const bad = commandSchema.parse({ type: "batch_edits", commands: [{ type: "set_terminal_cfm", terminalId: ids[0], cfm: 150 }, { type: "set_terminal_cfm", terminalId: "no-such-terminal", cfm: 150 }] });
    const d = planCommit(start, [], { idempotencyKey: "edit-batch-bad-1", baseRevision: start.revision, actor, command: bad });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.message).toMatch(/^Step 2 of 2 \(set terminal cfm\)/);
  });

  it("refuses an undo inside a batch", () => {
    const d = planCommit(start, [], { idempotencyKey: "edit-batch-undo-1", baseRevision: start.revision, actor, command: commandSchema.parse({ type: "batch_edits", commands: [{ type: "undo", revision: 1 }] }) });
    expect(d.ok ? "" : d.error.message).toContain("undo the batch's revision on its own");
  });

  it("decides the same way twice: a retried request writes the same values", () => {
    const command = paste(ids, 400);
    const a = planCommit(start, [], { idempotencyKey: "edit-batch-retry", baseRevision: start.revision, actor, command }, () => "t");
    const b = planCommit(start, [], { idempotencyKey: "edit-batch-retry", baseRevision: start.revision, actor, command }, () => "t");
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(b.changeset.elements).toEqual(a.changeset.elements);
    expect(b.changeset.readSet).toEqual(a.changeset.readSet);
  });

  it("lands on the same model as the same steps sent one after another, repeats included", () => {
    const steps = [...ids.map((terminalId, i) => ({ type: "set_terminal_cfm" as const, terminalId, cfm: 120 + i })), { type: "set_terminal_cfm" as const, terminalId: ids[0] as string, cfm: 999 }];
    const batch = executeCommand(start, commandSchema.parse({ type: "batch_edits", commands: steps }));
    let one = start;
    const changed = new Set<string>();
    for (const step of steps) {
      const r = executeCommand(one, commandSchema.parse(step));
      if (!r.ok) throw new Error(r.error.message);
      one = r.model;
      for (const id of r.changedIds) changed.add(id);
    }
    if (!batch.ok) throw new Error(batch.error.message);
    expect(new Set(batch.changedIds)).toEqual(changed);
    for (const id of changed) expect(canonicalJson(batch.model.elements[id])).toBe(canonicalJson(one.elements[id]));
    expect(cfmOf(batch.model, ids[0] as string)).toBe(999);
    expect(batch.authored.filter((a) => a.elementId === ids[0])).toEqual([{ elementId: ids[0], field: "cfm", value: 999 }]);
  });

  it("runs other edits step by step in the same batch", () => {
    const equipment = Object.values(start.elements).find((el) => el.kind === "equipment");
    if (!equipment) throw new Error("the XS model has no equipment");
    const { model, changeset } = commit(start, { type: "batch_edits", commands: [{ type: "set_terminal_cfm", terminalId: ids[0], cfm: 210 }, { type: "move_equipment", equipmentId: equipment.id, delta: { x: 100, y: 0 } }] });
    expect(changeset.revision).toBe(start.revision + 1);
    expect(cfmOf(model, ids[0] as string)).toBe(210);
    const moved = model.elements[equipment.id];
    expect(moved?.kind === "equipment" && equipment.kind === "equipment" ? moved.position.x - equipment.position.x : NaN).toBeCloseTo(100);
  });

  it("an open schedule patched by the batch's changed ids equals a rebuild", () => {
    const def: ScheduleDefinition = { category: "air_terminal", title: "Air terminals", columns: [{ field: "mark" }, { field: "type" }, { field: "level" }, { field: "cfm" }] };
    const session = openSchedule(start, scheduleV1ToV2(def), { viewId: "t", revision: 1 });
    session.rows();
    const { model, changeset } = commit(start, paste(ids, 500));
    session.apply({ model, revision: 2, changedIds: [...changeset.elements.map((el) => el.id), ...(changeset.removedIds ?? [])] });
    const rebuilt = openSchedule(model, scheduleV1ToV2(def), { viewId: "t", revision: 2 });
    expect(comparable(session.rows())).toEqual(comparable(rebuilt.rows()));
  });
});
