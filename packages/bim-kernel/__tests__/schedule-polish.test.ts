/**
 * @jest-environment node
 *
 * Schedule polish (Stream H's grid blockers and Stream I's define path):
 * - a MARK typed in the grid becomes a set_parameters that names its scope
 *   (before, the command was refused: "expected one of instance|type");
 * - set_view_properties with `scheduleV2` converts a v1 list schedule view
 *   (before: "pick one, not both"), prints the same, and undoes in one step;
 * - a v1 column named by a nameplate parameter (MCA, MOCP) opens on a model
 *   where no part declares it, reading blank (before: "mca isn't a field");
 * - an unknown field path is refused naming the path, the class and the
 *   nearest fields (before, an unknown dotted path printed blank).
 */
import { commandSchema, drawScheduleView, executeCommand, fieldProviderRegistry, planCommit, scheduleFields, scheduleTable, scheduleV2Paper, SCHEDULE_CATEGORIES, type Changeset, type ModelState, type Primitive, type ScheduleDefinition, type ScheduleDefinitionV2 } from "../src";
import { openSchedule, scheduleV1ToV2, validateScheduleDefinition } from "../src/schedules/engine";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { referenceDistribution } from "./fixtures/electrical-building";
import { threeStoreyStack } from "./fixtures/three-storey-stack";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown, history: readonly Changeset[] = []): { model: ModelState; changeset: Changeset } {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `schedule-polish-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-25T00:00:00.000Z", history);
  if (!d.ok) throw new Error(d.error.message);
  return { model: d.model, changeset: d.changeset };
}

function withStack(): ModelState {
  let m = createDemoModel();
  for (const c of threeStoreyStack().setup) {
    const r = executeCommand(m, commandSchema.parse(c));
    if (!r.ok) throw new Error(r.error.message);
    m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
  }
  return m;
}

const TERMINALS: ScheduleDefinition = { category: "air_terminal", title: "Air terminal schedule", columns: [{ field: "mark" }, { field: "cfm" }, { field: "level" }] };
const MECHANICAL_WITH_ELECTRICAL: ScheduleDefinition = { category: "mechanical_equipment", columns: [{ field: "mark" }, { field: "voltage_phase" }, { field: "mca" }, { field: "mocp" }, { field: "circuit" }] };

function viewProps(model: ModelState, viewId: string) {
  const el = model.elements[viewId];
  return el?.kind === "view" ? el.props : undefined;
}

function printed(model: ModelState, props: Parameters<typeof drawScheduleView>[2]): Primitive[] {
  const prims: Primitive[] = [];
  drawScheduleView(prims, model, props, { x: 10, y: 20 });
  return prims;
}

describe("grid edits send set_parameters with a scope", () => {
  it("a MARK cell on a v1 schedule plans a command the kernel accepts", () => {
    const m = withStack();
    const session = openSchedule(m, scheduleV1ToV2(TERMINALS), { viewId: "v", revision: m.revision });
    const rows = session.rows();
    const rowKey = rows.rowKeys[0];
    expect(rowKey).toBeDefined();
    const plan = session.planEdit({ rowKey: rowKey ?? "", columnId: "mark", value: "T-99" });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.commands[0]).toMatchObject({ type: "set_parameters", scope: "instance", mark: "T-99" });
    for (const c of plan.commands) {
      const r = executeCommand(m, c);
      expect(r.ok ? "" : r.error.message).toBe("");
    }
  });
});

describe("set_view_properties with scheduleV2 converts a v1 list schedule view", () => {
  const start = commit(withStack(), { type: "create_view", viewId: "sched-at", name: "Air terminals", viewType: "schedule", props: { schedule: TERMINALS } });

  it("drops the v1 definition, keeps the v2 one and prints the same table", () => {
    const v2 = scheduleV1ToV2(TERMINALS);
    const converted = commit(start.model, { type: "set_view_properties", viewId: "sched-at", props: { scheduleV2: v2 } });
    const props = viewProps(converted.model, "sched-at");
    expect(props?.schedule).toBeUndefined();
    expect(props?.scheduleV2).toEqual(v2);
    expect(printed(converted.model, props)).toEqual(printed(start.model, viewProps(start.model, "sched-at")));
    expect(converted.changeset.authored.map((a) => a.field)).toEqual(expect.arrayContaining(["doc.props.schedule", "doc.props.scheduleV2"]));
  });

  it("undoes back to the v1 schedule in one step", () => {
    const converted = commit(start.model, { type: "set_view_properties", viewId: "sched-at", props: { scheduleV2: scheduleV1ToV2(TERMINALS) } });
    const undone = commit(converted.model, { type: "undo", revision: converted.changeset.revision }, [start.changeset, converted.changeset]);
    expect(viewProps(undone.model, "sched-at")?.schedule).toEqual(TERMINALS);
    expect(viewProps(undone.model, "sched-at")?.scheduleV2).toBeUndefined();
  });

  it.each([
    ["demo", createDemoModel],
    ["plumbing stack", withStack],
    ["electrical building", () => referenceDistribution().head],
  ] as const)("prints every v1 category, with every field it offers, byte-identically after converting (%s model)", (_name, make) => {
    const m: ModelState = make();
    const differing: string[] = [];
    for (const category of SCHEDULE_CATEGORIES) {
      const def: ScheduleDefinition = { category, columns: scheduleFields(m, category).map((f) => ({ field: f.key })) };
      if (JSON.stringify(printed(m, { scheduleV2: scheduleV1ToV2(def) })) === JSON.stringify(printed(m, { schedule: def }))) continue;
      const v1 = scheduleTable(m, def).evaluated;
      const v2 = scheduleV2Paper(m, scheduleV1ToV2(def));
      const rows = v2.kind === "list" ? v2.table.evaluated.rows : [];
      if (JSON.stringify(v2.kind === "list" ? v2.table.evaluated.headings : []) !== JSON.stringify(v1.headings)) differing.push(`${category} headings`);
      v1.rows.forEach((r, i) => r.forEach((text, j) => {
        const other = rows[i]?.[j];
        if (other !== text) differing.push(`${category} ${v1.headings[j]}: ${text} -> ${other}`);
      }));
    }
    expect([...new Set(differing)]).toEqual([]);
  });

  it("still refuses one patch that sets two kinds of schedule", () => {
    const r = executeCommand(start.model, commandSchema.parse({ type: "set_view_properties", viewId: "sched-at", props: { schedule: TERMINALS, scheduleV2: scheduleV1ToV2(TERMINALS) } }));
    expect(r.ok ? "" : r.error.message).toContain("pick one, not both");
  });
});

describe("v1 columns named by a nameplate parameter", () => {
  it("open on a model where no part declares MCA or MOCP, and read blank", () => {
    const m = createDemoModel();
    const def = scheduleV1ToV2(MECHANICAL_WITH_ELECTRICAL);
    expect(validateScheduleDefinition(m, def, { viewId: "v", revision: m.revision })).toEqual([]);
    const rows = openSchedule(m, def, { viewId: "v", revision: m.revision }).rows();
    const mca = rows.columns.find((c) => c.id === "mca");
    expect(mca?.heading).toBe("MCA");
    const values = rows.values.get("mca");
    const filled = values?.type === "quantity" ? Array.from(values.values).filter((v) => !Number.isNaN(v)) : [];
    expect(filled).toEqual([]);
  });

  it("with the field providers, MCA reads the equipment's nameplate field and edits its type parameter", () => {
    const m = createDemoModel();
    const registry = fieldProviderRegistry();
    const def = scheduleV1ToV2(MECHANICAL_WITH_ELECTRICAL);
    expect(validateScheduleDefinition(m, def, { viewId: "v", revision: m.revision, registry })).toEqual([]);
    const rows = openSchedule(m, def, { viewId: "v", revision: m.revision, registry }).rows();
    const mca = rows.columns.find((c) => c.id === "mca");
    expect(mca).toMatchObject({ heading: "MCA", quantityKind: "current", writer: { scope: "type" } });
  });
});

describe("unknown field paths are refused when the schedule is defined", () => {
  const m = createDemoModel();
  const base: ScheduleDefinitionV2 = scheduleV1ToV2({ category: "mechanical_equipment", columns: [{ field: "mark" }] });

  it("names the path and the class, and suggests the nearest field", () => {
    const def: ScheduleDefinitionV2 = { ...base, columns: [...base.columns, { id: "mca", kind: "field", path: "own.mcaa" }] };
    const problems = validateScheduleDefinition(m, def, { viewId: "v", revision: m.revision, registry: fieldProviderRegistry() });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/^"own\.mcaa" isn't a field of Mechanical equipment\. Did you mean "own\.mca"/);
    expect(problems[0]?.columnId).toBe("mca");
  });

  it("refuses an unknown filter or sort path too", () => {
    const def: ScheduleDefinitionV2 = { ...base, sort: [{ path: "nope.at_all", direction: "asc" }] };
    const problems = validateScheduleDefinition(m, def, { viewId: "v", revision: m.revision });
    expect(problems.map((p) => p.message).join(" ")).toContain('"nope.at_all" isn\'t a field of Mechanical equipment.');
  });

  it("still opens the live electrical paths v1 schedules use", () => {
    const def: ScheduleDefinitionV2 = { ...base, columns: [...base.columns, { id: "cn", kind: "field", path: "circuit.number" }, { id: "fed", kind: "field", path: "feeder.source.name" }, { id: "p", kind: "field", path: "param.mca" }] };
    expect(validateScheduleDefinition(m, def, { viewId: "v", revision: m.revision })).toEqual([]);
  });
});
