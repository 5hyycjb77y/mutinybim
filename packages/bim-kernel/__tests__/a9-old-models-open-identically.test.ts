/**
 * @jest-environment node
 *
 * Round 9 lane A9: airflow moved into the Mechanical add-on, and every model
 * stored before it opens and totals exactly as it did. The fixtures in
 * `fixtures/stored-changesets/` were written by round 8b's kernel (commit
 * 42e1ac5de, `git archive` into a scratch directory; generator described in
 * an internal design note): the round 1 demo, the demo after
 * every stored airflow edit (set_terminal_cfm alone and batched,
 * set_parameters { cfm }, slide_branch, with their `field_equals cfm`
 * intents), the round 3 heavy model and the round 5 full-BIM trees, each
 * with 8b's own airflow per element, schedule, issues and the totals after
 * one more edit.
 *
 * Fails on round 8b's code: `kinds/` (`lowerKindRecord`,
 * `KINDS_ADDON_OWNED_FEATURE`) and the Mechanical rows don't exist, and an
 * upgraded record had nowhere to keep its airflow.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  KINDS_ADDON_OWNED_FEATURE,
  commandSchema,
  elementKindTable,
  evaluateEquipmentSchedule,
  intentHolds,
  liftKindRecord,
  lowerKindRecord,
  planCommit,
  recomputeDerived,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type Changeset,
  type ModelState,
  type ScheduleRow,
  type ValidationIssue,
} from "@permitzip/bim-kernel";
import { AIRFLOW_KEY, airflowOf, carriesAir, computeAirflow, storedAirflowOf } from "@permitzip/bim-pack-mechanical";

interface Fixture {
  readonly scenario: string;
  readonly round: string;
  readonly base?: ModelState;
  readonly changesets: readonly Changeset[];
  readonly head: ModelState;
  readonly expected: {
    readonly airflow: Readonly<Record<string, number>>;
    readonly schedule: readonly ScheduleRow[];
    readonly issues: readonly ValidationIssue[];
    readonly derivedChanged: number;
    readonly after?: { readonly command: unknown; readonly airflow: Readonly<Record<string, number>> };
  };
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
const FIXTURES: readonly Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("pipe-"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Fixture);
/** The shared-tree fixture is the one model whose air total changes (a9-pipe-not-in-air-total). */
const IDENTICAL = FIXTURES.filter((f) => f.scenario !== "r8-shared-tree");

const actor = { id: "u-a9", name: "A9", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `a9-open-${seq}-xxxxxxxx`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-01T12:00:00.000Z");
  if (!d.ok) throw new Error(`refused: ${d.error.message}`);
  const elements: Record<string, BimElement> = { ...head.elements };
  for (const el of d.changeset.elements) elements[el.id] = el;
  for (const id of d.changeset.removedIds ?? []) delete elements[id];
  return { ...head, revision: d.changeset.revision, elements, connections: d.model.connections };
}

/** The air elements' airflow, as round 8b's kernel computed it (8b summed every leaf; on these models only air leaves feed air nodes). */
function airExpectations(airflow: Readonly<Record<string, number>>, head: ModelState): Array<[string, number]> {
  return Object.entries(airflow).filter(([id]) => {
    const el = head.elements[id];
    return el !== undefined && carriesAir(el);
  });
}

describe("a9 old models open identically", () => {
  it("has a fixture written by round 8b for every round the stored fields span", () => {
    expect(FIXTURES.map((f) => f.scenario)).toEqual(["r1-demo", "r2-demo-edited", "r3-heavy", "r5-fullbim-xs", "r8-shared-tree"]);
    for (const f of FIXTURES) expect(Object.keys(f.head.elements).length).toBeGreaterThan(0);
  });

  it.each(IDENTICAL.map((f) => [f.scenario, f] as const))("%s: replaying its stored changesets gives the stored head, record for record", (_name, f) => {
    if (f.changesets.length === 0) return;
    const elements: Record<string, BimElement> = { ...(f.base?.elements ?? {}) };
    for (const cs of f.changesets) {
      for (const el of cs.elements) elements[el.id] = el;
      for (const id of cs.removedIds ?? []) delete elements[id];
    }
    expect(elements).toEqual(f.head.elements);
  });

  it.each(IDENTICAL.map((f) => [f.scenario, f] as const))("%s: every stored airflow reads the same through the add-on's reader", (_name, f) => {
    for (const el of Object.values(f.head.elements)) {
      const flat = el.kind === "terminal" ? el.cfm : el.kind === "duct_segment" ? el.flowCfm : el.kind === "equipment" ? el.totalCfm : undefined;
      expect(storedAirflowOf(el)).toBe(flat ?? null);
      expect(airflowOf(el)).toBe(carriesAir(el) ? (flat ?? null) : null);
    }
  });

  it.each(IDENTICAL.map((f) => [f.scenario, f] as const))("%s: is fully derived as stored, and totals the same element by element", (_name, f) => {
    expect(recomputeDerived(f.head).changedIds.length).toBe(f.expected.derivedChanged);
    const now = computeAirflow(f.head);
    expect(airExpectations(f.expected.airflow, f.head).length).toBeGreaterThan(0);
    for (const [id, value] of airExpectations(f.expected.airflow, f.head)) expect([id, now.get(id as BimElement["id"])]).toEqual([id, value]);
  });

  it.each(IDENTICAL.map((f) => [f.scenario, f] as const))("%s: the same schedule rows and the same issues", (_name, f) => {
    expect(evaluateEquipmentSchedule(f.head)).toEqual(f.expected.schedule);
    expect(validateModel(f.head)).toEqual(f.expected.issues);
  });

  it("r2-demo-edited: every stored `field_equals cfm` intent holds on the model it was recorded on", () => {
    const f = FIXTURES.find((x) => x.scenario === "r2-demo-edited");
    if (!f?.base) throw new Error("fixture r2-demo-edited missing its base");
    const elements: Record<string, BimElement> = { ...f.base.elements };
    let checked = 0;
    for (const cs of f.changesets) {
      for (const el of cs.elements) elements[el.id] = el;
      const model: ModelState = { ...f.head, elements: { ...elements } };
      for (const intent of cs.intents) {
        expect(intentHolds(model, intent)).toBe(true);
        if (intent.kind === "field_equals" && intent.field === "cfm") checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it.each(IDENTICAL.filter((f) => f.expected.after).map((f) => [f.scenario, f] as const))("%s: one more airflow edit totals as round 8b's did, on an older server and once every peer reads the parameter", (_name, f) => {
    const after = f.expected.after;
    if (!after) throw new Error("no after");
    for (const peersRead of [false, true]) {
      const next = withUpgradePolicy((feature) => (feature === KINDS_ADDON_OWNED_FEATURE ? peersRead : true), () => commit(f.head, after.command));
      const now = computeAirflow(next);
      expect(airExpectations(after.airflow, next).length).toBeGreaterThan(0);
      for (const [id, value] of airExpectations(after.airflow, next)) expect([peersRead, id, now.get(id as BimElement["id"])]).toEqual([peersRead, id, value]);
      const edited = Object.values(next.elements).filter((el) => el.kind === "terminal" && el.version !== f.head.elements[el.id]?.version);
      expect(edited.length).toBe(1);
      for (const el of edited) {
        const values = el.kind === "terminal" ? el.values : undefined;
        if (peersRead) {
          expect(values?.[AIRFLOW_KEY]).toBe(airflowOf(el));
          expect("cfm" in el).toBe(false);
        } else {
          expect(values).toBeUndefined();
          expect("cfm" in el).toBe(true);
        }
      }
    }
  });

  it("a record lifted into the parameter lowers back to exactly what round 8b stored", () => {
    const table = elementKindTable();
    let lifted = 0;
    for (const f of IDENTICAL) {
      for (const el of Object.values(f.head.elements)) {
        const row = table.row(el.kind);
        if (!row) continue;
        const up = liftKindRecord(el, row);
        if (up !== el) lifted += 1;
        expect(lowerKindRecord(up === el ? up : Object.assign({}, up, { schemaVersion: 2 }), row)).toEqual(el);
      }
    }
    expect(lifted).toBeGreaterThan(100);
  });
});
