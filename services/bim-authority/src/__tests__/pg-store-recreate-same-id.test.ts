/**
 * @jest-environment node
 *
 * Regression test for delete+recreate same-id post-restart data loss:
 * when a single batch deleted and recreated an element under the same id (e.g. re-hosted
 * exterior walls or refreshed part_type definitions), the old batch builder left the id in
 * both `changeset.elements` and `changeset.removedIds`, and `pg-store.ts` applied
 * `removedIds` after/alongside `elements` — silently deleting the row from `bim.elements`
 * while in-memory `applyChangeset` kept it alive until the next authority restart reloaded from Postgres.
 */
import {
  DEFAULT_SETTINGS,
  asElementId,
  asRevision,
  commandSchema,
  planCommit,
  withUpgradePolicy,
  type BimElement,
  type Changeset,
  type ModelState,
  type Revision,
} from "@permitzip/bim-kernel";
import type { DecidedCommit } from "@permitzip/bim-sync";
import { PostgresCommitStore, loadHeadTimed, planRuns, removedElementIds, type Sql } from "../pg-store";

jest.mock("postgres", () => ({ __esModule: true, default: jest.fn() }), { virtual: true });

const NOW = () => "2026-11-24T13:00:00.000Z";
const EPOCH = "2026-11-24 00:00:00+00";
const ACTOR = { id: "agent-1", name: "Agent", kind: "agent" as const };

/** Minimal in-memory simulation of the Postgres `bim.models` + `bim.elements` tables for `writeRun` and `loadHeadTimed`. */
function inMemoryPg(modelId: string, initialRevision: number, initialElements: readonly BimElement[]) {
  let revision = initialRevision;
  const elements = new Map<string, BimElement>(initialElements.map((el) => [el.id, el]));

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();

    // Nested SQL fragments composed inside writeRun / guardedWrite (never awaited directly).
    if (
      text === "" ||
      text === "guard" ||
      text === "fence" ||
      text === ", patch" ||
      text === ", r->'p'" ||
      text.startsWith("and (m.branch_state") ||
      text.startsWith("insert into bim.connections")
    ) {
      return { __fragment: text };
    }

    // writeRun: apply upserts (els CTE) and deletes (dels CTE) exactly as Postgres executes them.
    if (text.includes("with guard as") && text.includes("insert into bim.elements") && text.includes("delete from bim.elements")) {
      const jsonValues = values.filter((v): v is { readonly __json: unknown } => typeof v === "object" && v !== null && "__json" in v);
      // Order in writeRun: upserts, removed, cut, logged, answers
      const upserts = (jsonValues[0]?.__json ?? []) as BimElement[];
      const removed = (jsonValues[1]?.__json ?? []) as string[];
      for (const el of upserts) elements.set(el.id, el);
      for (const id of removed) elements.delete(id);
      const revIdx = strings.findIndex((s) => s.toLowerCase().includes("update bim.models set revision ="));
      if (revIdx >= 0 && typeof values[revIdx] === "number") revision = values[revIdx] as number;
      return Promise.resolve([{ applied: "1" }]);
    }

    // loadHeadTimed: bim.models
    if (text.includes("select revision, lease_generation, settings, created_at::text as epoch from bim.models")) {
      return Promise.resolve([{ revision: String(revision), lease_generation: "1", settings: DEFAULT_SETTINGS, epoch: EPOCH }]);
    }

    // loadHeadTimed: paged bim.elements
    if (text.includes("select element_id, body from bim.elements")) {
      const sorted = [...elements.entries()].sort(([a], [b]) => a.localeCompare(b));
      const hasAfter = text.includes("and element_id >");
      const after = hasAfter ? String(values[1]) : null;
      const page = after === null ? sorted : sorted.filter(([id]) => id > after);
      return Promise.resolve(page.map(([element_id, body]) => ({ element_id, body })));
    }

    // loadHeadTimed: bim.connections
    if (text.includes("from bim.connections")) {
      return Promise.resolve([]);
    }

    return Promise.reject(new Error(`unexpected query: ${text.slice(0, 120)}`));
  }) as unknown as Sql;

  Object.assign(sql, {
    json: (value: unknown) => ({ __json: value }),
    array: (value: unknown[]) => value,
  });

  return { sql, elements, revision: () => revision };
}

type StoreInternals = {
  term: { owner: string; generation: number; expiresAt: Date };
  cache: { model: ModelState; epoch: string } | null;
  durable: number;
  loaded: number;
};

function makeEmptyModel(modelId: string, revision = 1): ModelState {
  return { modelId, revision: revision as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

function commitOn(head: ModelState, key: string, command: unknown): { model: ModelState; changeset: Changeset } {
  const decision = withUpgradePolicy(() => true, () =>
    planCommit(head, [], { idempotencyKey: key, baseRevision: head.revision, actor: ACTOR, command: commandSchema.parse(command), clientSessionId: "s" }, NOW, []),
  );
  if (!decision.ok) throw new Error(decision.error.message);
  return { model: decision.model, changeset: decision.changeset };
}

describe("pg-store persistence for delete + recreate under the same element id", () => {
  it("planRuns and removedElementIds keep an element present in both elements and removedIds (matching applyChangeset)", () => {
    const lvl = commitOn(makeEmptyModel("m"), "k-lvl", { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const w1 = commitOn(lvl.model, "k-w1", {
      type: "create_element",
      elementId: "EXT-W1-LOW-1",
      levelId: "lvl-1",
      kind: "wall",
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 5000, y: 0 } },
      size: { widthMm: 200, heightMm: 3000 },
    });
    const recreatedWall = w1.model.elements["EXT-W1-LOW-1"]!;

    // Synthetic legacy overlapping changeset (what older kernels emitted before batch.ts fixed executeSteps)
    const legacyOverlap: Changeset = {
      ...w1.changeset,
      revision: asRevision(w1.model.revision + 1),
      elements: [recreatedWall],
      removedIds: [asElementId("EXT-W1-LOW-1"), asElementId("ORPHAN-OLD-WIN")],
    };

    const runs = planRuns([
      {
        idempotencyKey: "k-legacy",
        actorId: ACTOR.id,
        outcome: { status: "committed", revision: legacyOverlap.revision, rebased: false },
        changeset: legacyOverlap,
        before: w1.model,
        after: w1.model,
      },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.upserts.has("EXT-W1-LOW-1")).toBe(true);
    expect(runs[0]?.removed.has("EXT-W1-LOW-1")).toBe(false);
    expect(runs[0]?.removed.has("ORPHAN-OLD-WIN")).toBe(true);

    // guardedWrite / lockedTransact helper must also strip upserted ids from the DELETE CTE.
    expect(removedElementIds(legacyOverlap)).toEqual(["ORPHAN-OLD-WIN"]);
  });

  it("planRuns preserves net order across separate commits in one group-commit batch", () => {
    const lvl = commitOn(makeEmptyModel("m"), "k-lvl", { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const w1 = commitOn(lvl.model, "k-w1", {
      type: "create_element",
      elementId: "W1",
      levelId: "lvl-1",
      kind: "wall",
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } },
      size: { widthMm: 200, heightMm: 3000 },
    });
    const delW1 = commitOn(w1.model, "k-del-w1", { type: "delete_elements", ids: ["W1"], policy: "cascade" });
    const addW1 = commitOn(delW1.model, "k-add-w1", {
      type: "create_element",
      elementId: "W1",
      levelId: "lvl-1",
      kind: "wall",
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } },
      size: { widthMm: 200, heightMm: 4000 },
    });

    const commits: DecidedCommit[] = [
      { idempotencyKey: "k-del-w1", actorId: ACTOR.id, outcome: { status: "committed", revision: delW1.changeset.revision, rebased: false }, changeset: delW1.changeset, before: w1.model, after: delW1.model },
      { idempotencyKey: "k-add-w1", actorId: ACTOR.id, outcome: { status: "committed", revision: addW1.changeset.revision, rebased: false }, changeset: addW1.changeset, before: delW1.model, after: addW1.model },
    ];
    const [run] = planRuns(commits);
    expect(run?.upserts.get("W1")?.kind).toBe("wall");
    expect(run?.removed.has("W1")).toBe(false);
  });

  it("a delete+recreate same-id batch survives flush and cold reload (simulated authority restart)", async () => {
    const lvl = commitOn(makeEmptyModel("demo-site"), "k-lvl", { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const initial = commitOn(lvl.model, "k-w1", {
      type: "create_element",
      elementId: "EXT-W1-LOW-1",
      levelId: "lvl-1",
      kind: "wall",
      placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 7500, y: 0 } },
      size: { widthMm: 200, heightMm: 2700 },
    });

    const db = inMemoryPg("demo-site", initial.model.revision, Object.values(initial.model.elements));
    const store = new PostgresCommitStore(db.sql, { modelId: "demo-site", owner: "auth-1", ownerMachine: "m1", leaseTtlMs: 10_000 });
    const inner = store as unknown as StoreInternals;
    inner.term = { owner: "auth-1", generation: 1, expiresAt: new Date(Date.now() + 60_000) };
    inner.cache = { model: initial.model, epoch: EPOCH };
    inner.durable = inner.loaded = initial.model.revision;

    const batchCommand = commandSchema.parse({
      type: "batch_edits",
      label: "Re-host exterior wall under same id",
      commands: [
        { type: "delete_elements", ids: ["EXT-W1-LOW-1"], policy: "cascade" },
        {
          type: "create_element",
          elementId: "EXT-W1-LOW-1",
          levelId: "lvl-1",
          kind: "wall",
          placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 7500, y: 0 } },
          size: { widthMm: 200, heightMm: 4200 },
        },
      ],
    });

    const decided = store.decideLocal(
      1,
      "k-rebuild",
      initial.model.revision,
      (head) => withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: "k-rebuild", baseRevision: head.revision, actor: ACTOR, command: batchCommand, clientSessionId: "s" }, NOW, [])),
      ACTOR.id,
    );
    expect(decided.kind).toBe("decided");
    if (decided.kind !== "decided") return;

    await store.flush(1, [decided.commit]);

    // Simulate an authority restart: cold-load the model from Postgres bim.elements into a fresh head.
    const { head: reloaded } = await loadHeadTimed(db.sql, "demo-site");
    expect(reloaded.model.revision).toBe(initial.model.revision + 1);
    const wall = reloaded.model.elements["EXT-W1-LOW-1"];
    expect(wall?.kind).toBe("wall");
    if (wall?.kind === "wall") {
      expect(wall.height).toBe(4200);
      expect(wall.version).toBe(initial.model.elements["EXT-W1-LOW-1"]!.version + 1);
    }
  });
});
