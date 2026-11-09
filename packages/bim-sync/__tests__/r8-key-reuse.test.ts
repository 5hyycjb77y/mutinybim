import { type Actor, type Command, type CommandRequest } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  DurableLog,
  GroupCommitMemoryStore,
  InMemoryCommitStore,
  KEY_REUSED_MESSAGE,
  Sequencer,
  commandDigest,
  type CommitStore,
} from "../src";

/**
 * A save key reused for a DIFFERENT change must be refused, not answered with
 * the first change's "saved". Fails on round 8 before the fix: the sequencer
 * replayed any answer by key alone, so a cleanup whose key collided with an
 * earlier run's was told "saved at revision 467" and deleted nothing.
 */
const actor: Actor = { id: "priya", name: "Priya", kind: "human" };
const cfm = (value: number): Command => ({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: value });
const req = (key: string, command: Command, base = 0): CommandRequest => ({ idempotencyKey: key, baseRevision: base, actor, command });

const stores: ReadonlyArray<readonly [string, () => CommitStore]> = [
  ["serial store", () => new InMemoryCommitStore(createDemoModel())],
  ["group-commit store", () => new GroupCommitMemoryStore(new DurableLog(createDemoModel()))],
];

describe.each(stores)("reused save keys (%s)", (_name, makeStore) => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it("the same change under the same key replays the first answer", async () => {
    const store = makeStore();
    const sequencer = await Sequencer.start(store);
    const first = await sequencer.submit(req("key-same-0001", cfm(360)));
    const again = await sequencer.submit(req("key-same-0001", cfm(360)));
    expect(first).toEqual({ status: "committed", revision: 1, rebased: false });
    expect(again).toEqual(first);
    expect((await store.changesSince(0)).length).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("a different change under a used key is refused in plain words and nothing is saved", async () => {
    const store = makeStore();
    const sequencer = await Sequencer.start(store);
    await sequencer.submit(req("key-reused-01", cfm(360)));
    const reused = await sequencer.submit(req("key-reused-01", cfm(999), 1));
    expect(reused.status).toBe("rejected");
    expect(reused.status === "rejected" && reused.error.message).toBe(KEY_REUSED_MESSAGE);
    expect((await store.changesSince(0)).length).toBe(1);
    expect((await store.head()).revision).toBe(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("reused for a different change"), expect.objectContaining({ key: "key-reused-01" }));
  });

  it("a different change sent while the first is still in flight is refused too", async () => {
    const sequencer = await Sequencer.start(makeStore());
    const [a, b] = await Promise.all([sequencer.submit(req("key-racing-01", cfm(360))), sequencer.submit(req("key-racing-01", cfm(420)))]);
    expect(a.status).toBe("committed");
    expect(b.status === "rejected" && b.error.message).toBe(KEY_REUSED_MESSAGE);
  });

  it("the client never sees the command digest", async () => {
    const sequencer = await Sequencer.start(makeStore());
    const outcome = await sequencer.submit(req("key-digest-01", cfm(360)));
    expect(Object.keys(outcome)).not.toContain("commandDigest");
  });
});

describe("answers stored before digests existed (an older server)", () => {
  it("replay as they always did: there is nothing to compare", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const lease = await store.acquireLease();
    // An older server wrote this answer without a digest.
    const sequencer = new Sequencer(store, lease);
    await store.transact(lease, "key-legacy-01", 0, () => ({ ok: false, error: { code: "conflict", message: "older answer", elementIds: [] } }));
    const outcome = await sequencer.submit(req("key-legacy-01", cfm(360)));
    expect(outcome.status === "rejected" && outcome.error.message).toBe("older answer");
  });

  it("the digest is stable for the same change and differs for a different one", () => {
    expect(commandDigest(cfm(360))).toBe(commandDigest(cfm(360)));
    expect(commandDigest(cfm(360))).not.toBe(commandDigest(cfm(361)));
    expect(commandDigest(cfm(360))).toMatch(/^[0-9a-f]{16}$/);
  });
});
