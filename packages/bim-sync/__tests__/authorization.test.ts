import {
  InMemoryModelMemberStore,
  NO_MODEL_ACCESS,
  NativeModelAuthorizer,
  agentActor,
  authorizeConnection,
  capabilitiesForRole,
  type ModelAuthorizer,
} from "../src";

const PRIYA = "11111111-1111-4111-8111-111111111111";
const AVERY = "22222222-2222-4222-8222-222222222222";
const human = (id: string, name: string) => ({ id, name, kind: "human" as const });

function setup() {
  const members = new InMemoryModelMemberStore();
  members.set("site-7301", PRIYA, "editor");
  members.set("site-7301", AVERY, "viewer");
  members.set("other-client", AVERY, "manager");
  return new NativeModelAuthorizer(members);
}

const connect = (authorizer: ModelAuthorizer, actor: Parameters<typeof authorizeConnection>[1]["actor"], userId: string, modelId: string) =>
  authorizeConnection(authorizer, { actor, verifiedUserId: userId, modelId, token: "t" });

describe("native model roles", () => {
  it("maps viewer, editor and manager to read, edit and issue", () => {
    expect([...capabilitiesForRole("viewer")]).toEqual(["model.read"]);
    expect([...capabilitiesForRole("editor")]).toEqual(["model.read", "model.edit"]);
    expect([...capabilitiesForRole("manager")]).toEqual(["model.read", "model.edit", "model.issue"]);
  });
});

describe("authorizeConnection", () => {
  it("gives an editor a read-write connection", async () => {
    const d = await connect(setup(), human(PRIYA, "Priya"), PRIYA, "site-7301");
    expect(d.ok && d.principal).toEqual({ actorId: PRIYA, canWrite: true });
  });

  it("gives a viewer a read-only connection", async () => {
    const d = await connect(setup(), human(AVERY, "Avery"), AVERY, "site-7301");
    expect(d.ok && d.principal).toEqual({ actorId: AVERY, canWrite: false });
  });

  it("refuses someone who is not a member of the model", async () => {
    const outsider = "33333333-3333-4333-8333-333333333333";
    expect(await connect(setup(), human(outsider, "Outsider"), outsider, "site-7301")).toEqual({ ok: false, reason: NO_MODEL_ACCESS });
  });

  it("refuses a model on another project even for a member elsewhere", async () => {
    expect(await connect(setup(), human(PRIYA, "Priya"), PRIYA, "other-client")).toEqual({ ok: false, reason: NO_MODEL_ACCESS });
  });

  it("gives an agent exactly its person's capabilities, never more", async () => {
    const authorizer = setup();
    const priyaAgent = await connect(authorizer, agentActor(PRIYA, "run-1", "Host agent"), PRIYA, "site-7301");
    expect(priyaAgent.ok && priyaAgent.principal).toEqual({ actorId: `agent:${PRIYA}:run-1`, canWrite: true });
    const averyAgent = await connect(authorizer, agentActor(AVERY, "run-2", "Host agent"), AVERY, "site-7301");
    expect(averyAgent.ok && averyAgent.principal).toEqual({ actorId: `agent:${AVERY}:run-2`, canWrite: false });
  });

  it("refuses an agent claiming to act for someone other than the signed-in person", async () => {
    const d = await connect(setup(), agentActor(PRIYA, "run-1", "Host agent"), AVERY, "site-7301");
    expect(d).toEqual({ ok: false, reason: "An agent can only act for the person who signed it in" });
  });

  it("refuses a person signing in as someone else", async () => {
    const d = await connect(setup(), human(PRIYA, "Priya"), AVERY, "site-7301");
    expect(d).toEqual({ ok: false, reason: "You can only edit as yourself" });
  });

  it("treats a grant without read as no access", async () => {
    const editOnly: ModelAuthorizer = { capabilities: async () => ({ ok: true, capabilities: new Set(["model.edit"]) }) };
    expect(await connect(editOnly, human(PRIYA, "Priya"), PRIYA, "site-7301")).toEqual({ ok: false, reason: NO_MODEL_ACCESS });
  });
});
