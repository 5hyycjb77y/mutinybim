/**
 * @jest-environment node
 *
 * Round 15 SC15: a schedule is changed column by column through one kernel
 * command, `edit_schedule` (the grid's column menu, the agent's schedule tool
 * and a script's `documents.editSchedule` all send it). Each command is one
 * undo step; an old (v1) list schedule is stored as v2 by its first edit and
 * Undo puts the old one back; a form schedule refuses in words.
 *
 * Fails on the code before SC15: every `edit_schedule` was refused with
 * "Editing a schedule step by step isn't built yet", and there was no
 * `rename_column` step.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  canonicalJson,
  commandSchema,
  planCommit,
  withUpgradePolicy,
  type Changeset,
  type ModelState,
  type ScheduleDefinitionV2,
} from "../src";
import { applyScheduleSteps, scheduleStepsBetween } from "../src/schedules/engine";

const NOW = () => "2026-11-05T12:00:00.000Z";

function session() {
  let head: ModelState = { modelId: "sc15-steps", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const log: Changeset[] = [];
  let seq = 0;
  const submit = (command: unknown): string | null => {
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "unparsed";
    const d = withUpgradePolicy(
      () => true,
      () => planCommit(head, [], { idempotencyKey: `sc15-${++seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: parsed.data }, NOW, log),
    );
    if (!d.ok) return d.error.message;
    expect(canonicalJson(applyChangeset(head, d.changeset))).toBe(canonicalJson(d.model));
    head = d.model;
    log.push(d.changeset);
    return null;
  };
  const undo = () => submit({ type: "undo", revision: log[log.length - 1]?.revision ?? 0 });
  return { submit, undo, head: () => head, revisions: () => log.length };
}

function schedule(m: ModelState, id: string): { readonly v1: unknown; readonly v2: ScheduleDefinitionV2 | undefined } {
  const el = m.elements[id];
  if (el?.kind !== "view") throw new Error(`no view ${id}`);
  return { v1: el.props?.schedule, v2: el.props?.scheduleV2 };
}

const V2: ScheduleDefinitionV2 = {
  name: "Air devices",
  source: { kind: "classes", classes: ["mep.air_terminal"], includeSubclasses: true },
  columns: [
    { id: "mark", kind: "field", path: "mark" },
    { id: "cfm", kind: "field", path: "type", heading: "CFM" },
    { id: "level", kind: "field", path: "level" },
  ],
  filters: [],
  sort: [],
  groups: [],
  grandTotals: false,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

describe("sc15 edit_schedule: one command for column-by-column edits", () => {
  it("adds, moves, renames, totals, sorts, groups, filters and removes columns, each command one undo step", () => {
    const s = session();
    expect(s.submit({ type: "create_view", viewId: "v-air", name: "Air devices", viewType: "schedule", props: { scheduleV2: V2 } })).toBeNull();

    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "add_column", column: { id: "room", kind: "field", path: "family", heading: "ROOM" }, at: 1 }] })).toBeNull();
    expect(schedule(s.head(), "v-air").v2?.columns.map((c) => c.id)).toEqual(["mark", "room", "cfm", "level"]);

    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "move_column", columnId: "level", to: 0 }] })).toBeNull();
    expect(schedule(s.head(), "v-air").v2?.columns.map((c) => c.id)).toEqual(["level", "mark", "room", "cfm"]);

    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "rename_column", columnId: "cfm", heading: "AIRFLOW (CFM)" }, { op: "totals", columnId: "cfm", show: true }, { op: "totals", show: true }] })).toBeNull();
    const renamed = schedule(s.head(), "v-air").v2;
    expect(renamed?.columns.find((c) => c.id === "cfm")).toMatchObject({ heading: "AIRFLOW (CFM)", total: true });
    expect(renamed?.grandTotals).toBe(true);

    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "sort", sort: [{ path: "mark", direction: "desc" }] }, { op: "group", groups: [{ path: "level", header: true, footer: true, totals: true }] }, { op: "filter", filters: [{ path: "level", op: "equals", value: "L1" }] }] })).toBeNull();
    expect(schedule(s.head(), "v-air").v2).toMatchObject({ sort: [{ path: "mark", direction: "desc" }], groups: [{ path: "level" }], filters: [{ path: "level", value: "L1" }] });

    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "remove_column", columnId: "room" }] })).toBeNull();
    expect(schedule(s.head(), "v-air").v2?.columns.map((c) => c.id)).toEqual(["level", "mark", "cfm"]);

    // Each command undoes on its own, newest first: the removed column comes back, nothing else moves.
    const before = s.revisions();
    expect(s.undo()).toBeNull();
    expect(schedule(s.head(), "v-air").v2?.columns.map((c) => c.id)).toEqual(["level", "mark", "room", "cfm"]);
    expect(s.revisions()).toBe(before + 1);
    expect(schedule(s.head(), "v-air").v2?.sort).toEqual([{ path: "mark", direction: "desc" }]);
  });

  it("an old list schedule opens as v2 for its first edit; Undo puts the old one back unchanged", () => {
    const s = session();
    const v1 = { category: "air_terminal", title: "Air devices", columns: [{ field: "mark" }, { field: "cfm", heading: "CFM" }] };
    expect(s.submit({ type: "create_view", viewId: "v-old", name: "Air devices", viewType: "schedule", props: { schedule: v1 } })).toBeNull();
    const stored = canonicalJson(schedule(s.head(), "v-old").v1);

    expect(s.submit({ type: "edit_schedule", viewId: "v-old", steps: [{ op: "rename_column", columnId: "mark", heading: "TAG" }] })).toBeNull();
    const converted = schedule(s.head(), "v-old");
    expect(converted.v1).toBeUndefined();
    expect(converted.v2?.columns.map((c) => [c.id, c.heading ?? null])).toEqual([["mark", "TAG"], ["cfm", "CFM"]]);

    expect(s.undo()).toBeNull();
    const back = schedule(s.head(), "v-old");
    expect(back.v2).toBeUndefined();
    expect(canonicalJson(back.v1)).toBe(stored);
  });

  it("refuses in words, and changes nothing: missing view, not a schedule, a form, a missing column, the last column", () => {
    const s = session();
    expect(s.submit({ type: "edit_schedule", viewId: "nope", steps: [{ op: "totals", show: true }] })).toBe("There is no view nope.");
    expect(s.submit({ type: "create_view", viewId: "v-plan", name: "Level 1", viewType: "floor_plan", props: { level: "L1" } })).toBeNull();
    expect(s.submit({ type: "edit_schedule", viewId: "v-plan", steps: [{ op: "totals", show: true }] })).toBe('"Level 1" isn\'t a schedule.');

    const form: ScheduleDefinitionV2 = { ...V2, name: "Panel LP-1", columns: [{ id: "x", kind: "field", path: "mark" }], presentation: { kind: "form", template: "panel" } };
    expect(s.submit({ type: "create_view", viewId: "v-form", name: "Panel LP-1", viewType: "schedule", props: { scheduleV2: form } })).toBeNull();
    expect(s.submit({ type: "edit_schedule", viewId: "v-form", steps: [{ op: "remove_column", columnId: "x" }] })).toMatch(/laid out by its form/);

    expect(s.submit({ type: "create_view", viewId: "v-air", name: "Air devices", viewType: "schedule", props: { scheduleV2: { ...V2, columns: [V2.columns[0]] } } })).toBeNull();
    const head = canonicalJson(s.head());
    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "totals", show: true }, { op: "move_column", columnId: "gone", to: 0 }] })).toBe('Step 2: There is no column "gone" to move.');
    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "remove_column", columnId: "mark" }] })).toMatch(/keeps at least one column/);
    expect(s.submit({ type: "edit_schedule", viewId: "v-air", steps: [{ op: "add_column", column: { id: "mark", kind: "field", path: "mark" } }] })).toMatch(/already has a column "mark"/);
    expect(canonicalJson(s.head())).toBe(head);
  });

  it("the builder's Save is the same steps: scheduleStepsBetween turns a before/after into steps that rebuild the after", () => {
    const after: ScheduleDefinitionV2 = {
      ...V2,
      columns: [
        { id: "level", kind: "field", path: "level" },
        { id: "cfm", kind: "field", path: "type", heading: "AIRFLOW", total: true },
        { id: "room", kind: "field", path: "family" },
      ],
      sort: [{ path: "mark", direction: "asc" }],
      grandTotals: true,
    };
    const steps = scheduleStepsBetween(V2, after);
    expect(steps?.map((st) => st.op)).toEqual(["remove_column", "add_column", "move_column", "rename_column", "totals", "sort", "totals"]);
    const rebuilt = steps ? applyScheduleSteps(V2, steps) : null;
    expect(rebuilt && rebuilt.ok ? canonicalJson(rebuilt.definition) : rebuilt).toBe(canonicalJson(after));
    // A new source is a new definition, not column steps.
    expect(scheduleStepsBetween(V2, { ...V2, source: { kind: "classes", classes: ["mep.pump"], includeSubclasses: true } })).toBeNull();
  });
});
