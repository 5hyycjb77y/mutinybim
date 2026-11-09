/**
 * @jest-environment node
 *
 * Nov 8 red main (copy-rights, 1 run in 4): a session joining a model asks for
 * its head while an edit is being decided. `head()` read the model's revision
 * from the database, and while that read was out this authority decided the
 * edit on its cached head (revision 3, queued to write). The answer (still 2)
 * was then compared with the cache as it now stood: "head moved outside this
 * authority", a reload that dropped the queued edit, and the next group write
 * refused, so the model was handed off and the edit came back "not saved yet".
 *
 * The read here is held open by hand, so the interleaving is the same every
 * run. On the old code `head()` reloads (and the queued edit is gone).
 */
import { DEFAULT_SETTINGS, planCommit, withUpgradePolicy, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { PostgresCommitStore, type Sql } from "../pg-store";

// The Postgres client is the stand-in below; the driver itself is never loaded (it may not be installed where unit tests run).
jest.mock("postgres", () => ({ __esModule: true, default: jest.fn() }), { virtual: true });

const NOW = () => "2026-11-08T00:00:00.000Z";
const EPOCH = "2026-11-08 00:00:00+00";

/** A stand-in for the Postgres client: the head's revision read waits until the test answers it; a reload fails the test. */
function fakeSql() {
  let answer: ((rows: { revision: string; epoch: string }[]) => void) | null = null;
  let reloads = 0;
  const sql = ((strings: TemplateStringsArray) => {
    if (strings.join("?").includes("select revision, created_at::text as epoch from bim.models")) {
      return new Promise<{ revision: string; epoch: string }[]>((resolve) => {
        answer = resolve;
      });
    }
    return Promise.reject(new Error(`unexpected query: ${strings.join("?").slice(0, 80)}`));
  }) as unknown as Sql;
  Object.assign(sql, {
    begin: () => {
      reloads += 1;
      return Promise.reject(new Error("the head was reloaded"));
    },
  });
  return {
    sql,
    answer: (revision: number) => answer?.([{ revision: String(revision), epoch: EPOCH }]),
    reloads: () => reloads,
  };
}

type Internals = {
  term: { owner: string; generation: number; expiresAt: Date };
  cache: { model: ModelState; epoch: string };
  durable: number;
  loaded: number;
  unflushed: { revision: number }[];
};

function storeAt(revision: number) {
  const db = fakeSql();
  const store = new PostgresCommitStore(db.sql, { modelId: "m", owner: "authority-1", ownerMachine: null, leaseTtlMs: 10_000 });
  const model: ModelState = { modelId: "m", revision: revision as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const inner = store as unknown as Internals;
  inner.term = { owner: "authority-1", generation: 1, expiresAt: new Date(Date.now() + 60_000) };
  inner.cache = { model, epoch: EPOCH };
  inner.durable = inner.loaded = revision;
  return { store, db, inner };
}

function decideLevel(store: PostgresCommitStore, key: string) {
  return store.decideLocal(1, key, 2, (head) =>
    withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: key, baseRevision: head.revision, actor: { id: "seed", name: "Seed", kind: "agent" }, command: { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 }, clientSessionId: "s" }, NOW, [])),
  "seed");
}

describe("head() while this authority decides an edit", () => {
  it("the edit decided during the read keeps its place: no reload, still queued, the head is the decided one", async () => {
    const { store, db, inner } = storeAt(2);
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const reading = store.head();
    const decided = decideLevel(store, "k-1");
    expect(decided.kind).toBe("decided");
    expect(inner.unflushed.map((c) => c.revision)).toEqual([3]);
    db.answer(2);
    const head = await reading;
    expect(head.revision).toBe(3);
    expect(db.reloads()).toBe(0);
    expect(inner.unflushed.map((c) => c.revision)).toEqual([3]);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("head moved outside this authority"), expect.anything());
    errors.mockRestore();
  });

  it("a head the database really moved still reloads", async () => {
    const { store, db } = storeAt(2);
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const reading = store.head();
    db.answer(5);
    await expect(reading).rejects.toThrow("the head was reloaded");
    expect(db.reloads()).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("head moved outside this authority"), expect.objectContaining({ cached: 2, database: 5 }));
    errors.mockRestore();
  });
});
