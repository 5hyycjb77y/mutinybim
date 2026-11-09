/**
 * @jest-environment node
 *
 * The caller runtime every tool pack works through: an edit goes to the model
 * server as the caller; the host's gate before an edit can stop it with its
 * own answer (nothing is sent); the host hears about a saved edit; a retried
 * call carries the same idempotency key; the local caller refuses a write on
 * a read-only server before any model contact. Each case fails on a runtime
 * that skips the hook.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { editIdempotencyKey, runEdit, type BimCaller, type ResolveBimCaller } from "@permitzip/bim-mcp";
import { READ_ONLY_REFUSAL, localCaller, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";

type Body = Record<string, unknown>;
const bodyOf = (r: { content: { text: string }[] }): Body => JSON.parse(r.content[0]?.text ?? "{}") as Body;
const ADD_LEVEL = { type: "create_level", levelId: "level-7", name: "Level 7", elevationMm: 7000 } as const;
const ARGS = { project_id: "local", model_id: "demo" };

describe("oss-caller-runtime", () => {
  let server: LocalModelServer;
  beforeAll(() => installFirstPartyAddOns());
  beforeEach(async () => {
    server = startInMemoryModelServer();
    await server.seed(starterModel("demo"));
  });

  const base = (overrides: Partial<BimCaller> = {}): ResolveBimCaller => {
    const open = localCaller({ server, person: "p1", runId: "run-1" });
    return async (extra, projectId, write) => ({ ...(await open(extra, projectId, write)), ...overrides });
  };

  it("an edit is saved as the caller, and the host hears about it", async () => {
    const saved: string[][] = [];
    const out = bodyOf(await runEdit(base({ afterSaved: async (s) => void saved.push([...s.changedIds]) }), "t_edit", {}, ARGS, ADD_LEVEL));
    expect(out).toMatchObject({ status: "saved" });
    expect(saved).toEqual([expect.arrayContaining(["level-7"])]);
    expect((await server.head("demo"))?.elements["level-7"]).toMatchObject({ name: "Level 7" });
  });

  it("the host's gate answers instead, and nothing is sent", async () => {
    const before = await server.head("demo");
    const out = await runEdit(base({ beforeEdit: async () => ({ body: { status: "preview", note: "the card shows this" }, isError: false }) }), "t_edit", {}, ARGS, ADD_LEVEL);
    expect(bodyOf(out)).toEqual({ status: "preview", note: "the card shows this" });
    expect(await server.head("demo")).toEqual(before);
  });

  it("the edit answer names the caller's branch", async () => {
    const out = bodyOf(await runEdit(base({ branchId: "b-1" }), "t_edit", {}, ARGS, ADD_LEVEL));
    expect(out.branch).toEqual({ id: "b-1", name: "b-1" });
  });

  it("the same call makes the same idempotency key; another run makes another", () => {
    const a = editIdempotencyKey("run-1", "t_edit", { model_id: "demo", command: ADD_LEVEL }, 3);
    expect(editIdempotencyKey("run-1", "t_edit", { model_id: "demo", command: ADD_LEVEL }, 3)).toBe(a);
    expect(editIdempotencyKey("run-2", "t_edit", { model_id: "demo", command: ADD_LEVEL }, 3)).not.toBe(a);
  });

  it("a read-only local caller refuses the write before contacting the model", async () => {
    const before = await server.head("demo");
    const out = await runEdit(localCaller({ server, person: "p1", runId: "run-1", readOnly: true }), "t_edit", {}, ARGS, ADD_LEVEL);
    expect(out).toMatchObject({ isError: true });
    expect(out.content[0]?.text).toContain(READ_ONLY_REFUSAL);
    expect(await server.head("demo")).toEqual(before);
  });

  it("an invalid command is refused before it is sent, naming the field", async () => {
    const out = bodyOf(await runEdit(base(), "t_edit", {}, ARGS, { type: "create_level", levelId: "x" } as unknown as typeof ADD_LEVEL));
    expect(out).toMatchObject({ status: "refused", code: "invalid_command" });
  });
});
