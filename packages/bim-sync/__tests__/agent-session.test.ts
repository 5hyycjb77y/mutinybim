/**
 * @jest-environment node
 *
 * Agents edit through the same authority path as browsers: same hello, same
 * kernel commands, same outcomes. These drills use the in-memory hub with an
 * authorize hook like the real authority's (verified login -> principal).
 */
import { type Actor } from "@permitzip/bim-kernel";
import {
  AgentSession,
  AgentSessionError,
  InMemoryCommitStore,
  Sequencer,
  SyncClient,
  SyncHub,
  agentActor,
  agentOnBehalfOf,
  airDeviceSchedule,
  inspectNetwork,
  principalFor,
  queryElements,
  summarizeModel,
  validationIssues,
  type AgentSocketFactory,
} from "../src";
import { airflowOf } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;

/** Tokens in these drills are "token-<userId>"; the hub verifies them like the authority does. */
async function setup() {
  const store = new InMemoryCommitStore(createDemoModel());
  const sequencer = await Sequencer.start(store);
  const hub = new SyncHub(sequencer, {
    authorize: async (hello) => {
      const userId = hello.token?.startsWith("token-") ? hello.token.slice("token-".length) : null;
      if (!userId) return { ok: false, reason: "Sign in first" };
      const decision = principalFor(hello.actor, userId);
      return decision.ok ? { ok: true, principal: { actorId: decision.actorId, canWrite: true } } : { ok: false, reason: decision.reason };
    },
  });
  let nextId = 0;
  const factory: AgentSocketFactory = (_url, handlers) => {
    const conn = { id: `agent-${++nextId}`, send: (data: string) => setImmediate(() => handlers.onMessage(data)) };
    hub.join(conn);
    setImmediate(() => handlers.onOpen());
    return {
      send: (data) => setImmediate(() => void hub.handle(conn, data)),
      close: () => hub.leave(conn),
    };
  };
  return { hub, sequencer, factory };
}

function browser(hub: SyncHub, actor: Actor, token: string) {
  const conn = { id: `browser-${actor.id}`, send: (data: string) => setImmediate(() => client.receive(data)) };
  const client: SyncClient = new SyncClient(
    { send: (data) => setImmediate(() => void hub.handle(conn, data)), close: () => hub.leave(conn) },
    actor,
    {},
    60_000,
    { token },
  );
  hub.join(conn);
  client.opened();
  return client;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const avery: Actor = { id: "avery", name: "Avery", kind: "human" };

describe("agent principal", () => {
  it("binds an agent to the person who signed it in", () => {
    const agent = agentActor("avery", "conv-1", "Agent");
    expect(agent.id).toBe("agent:avery:conv-1");
    expect(agentOnBehalfOf(agent.id)).toBe("avery");
    expect(principalFor(agent, "avery")).toEqual({ ok: true, actorId: "agent:avery:conv-1" });
    expect(principalFor(agent, "priya").ok).toBe(false);
    expect(principalFor(avery, "avery")).toEqual({ ok: true, actorId: "avery" });
    expect(principalFor({ ...avery, id: "priya" }, "avery").ok).toBe(false);
  });
});

describe("agent session against the authority", () => {
  it("saves an agent edit and a browser sees it", async () => {
    const { hub, factory } = await setup();
    const human = browser(hub, avery, "token-avery");
    const session = await AgentSession.open({ url: "mem://", token: "token-avery", modelId: "demo", actor: agentActor("avery", "c1", "Agent-1"), socketFactory: factory });
    const result = await session.edit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 400 }, { idempotencyKey: "agent-c1-call-1" });
    expect(result).toMatchObject({ status: "saved", revision: 1, changedIds: expect.arrayContaining(["sd-2"]) });
    await until(() => human.confirmedRevision() === 1);
    const sd2 = human.view()?.elements["sd-2"];
    expect(sd2?.kind === "terminal" && airflowOf(sd2)).toBe(400);
    session.close();
    human.dispose();
  });

  it("a retried tool call (same key) is applied once and gets the same answer", async () => {
    const { factory, sequencer } = await setup();
    const session = await AgentSession.open({ url: "mem://", token: "token-avery", modelId: "demo", actor: agentActor("avery", "c2", "Agent"), socketFactory: factory });
    const first = await session.edit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 }, { idempotencyKey: "agent-c2-call-7" });
    const again = await session.edit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 }, { idempotencyKey: "agent-c2-call-7" });
    expect(first.status).toBe("saved");
    expect(again).toMatchObject({ status: "saved", revision: first.status === "saved" ? first.revision : -1 });
    expect((await sequencer.head()).revision).toBe(1);
    session.close();
  });

  it("an edit planned on old data comes back as a plain conflict the agent can re-plan from", async () => {
    const { hub, factory } = await setup();
    const priya = browser(hub, { id: "priya", name: "Priya", kind: "human" }, "token-priya");
    const session = await AgentSession.open({ url: "mem://", token: "token-avery", modelId: "demo", actor: agentActor("avery", "c3", "Agent-2"), socketFactory: factory });
    const readAt = session.revision();
    await until(() => priya.confirmedRevision() === 0);
    priya.submit({ type: "slide_branch", tapId: "tap-1", s: 9 * FT });
    await until(() => session.revision() === 1);
    const stale = await session.edit({ type: "slide_branch", tapId: "tap-1", s: 14 * FT }, { idempotencyKey: "agent-c3-call-1", baseRevision: readAt });
    expect(stale).toMatchObject({ status: "conflict", withActor: "Priya", latestRevision: 1 });
    // Agents and tool cards repeat this verbatim: a sentence naming the person, never a kernel reason code.
    expect(stale.status === "conflict" ? stale.message : "").toMatch(/^Priya changed /);
    const replanned = await session.edit({ type: "slide_branch", tapId: "tap-1", s: 11 * FT }, { idempotencyKey: "agent-c3-call-2", baseRevision: 1 });
    expect(replanned).toMatchObject({ status: "saved", revision: 2 });
    session.close();
    priya.dispose();
  });

  it("an agent's edit conflicts with its own person's concurrent edit", async () => {
    const { hub, factory } = await setup();
    const human = browser(hub, avery, "token-avery");
    const session = await AgentSession.open({ url: "mem://", token: "token-avery", modelId: "demo", actor: agentActor("avery", "c4", "Agent"), socketFactory: factory });
    await until(() => human.confirmedRevision() === 0);
    human.submit({ type: "slide_branch", tapId: "tap-1", s: 8 * FT });
    await until(() => session.revision() === 1);
    const result = await session.edit({ type: "slide_branch", tapId: "tap-1", s: 15 * FT }, { idempotencyKey: "agent-c4-call-1", baseRevision: 0 });
    expect(result).toMatchObject({ status: "conflict", withActor: "Avery" });
    session.close();
    human.dispose();
  });

  it("refuses an invalid edit with the kernel's reason and saves nothing", async () => {
    const { factory, sequencer } = await setup();
    const session = await AgentSession.open({ url: "mem://", token: "token-avery", modelId: "demo", actor: agentActor("avery", "c5", "Agent"), socketFactory: factory });
    const result = await session.edit({ type: "resize_run", segmentId: "seg-run-1", profile: { shape: "rect", width: 2000, height: 2000 } }, { idempotencyKey: "agent-c5-call-1" });
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.message.length).toBeGreaterThan(0);
    expect((await sequencer.head()).revision).toBe(0);
    session.close();
  });

  it("an agent cannot act for someone else", async () => {
    const { factory } = await setup();
    await expect(
      AgentSession.open({ url: "mem://", token: "token-priya", modelId: "demo", actor: agentActor("avery", "c6", "Agent"), socketFactory: factory, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "denied" } satisfies Partial<AgentSessionError>);
  });
});

describe("agent reads", () => {
  const model = createDemoModel();

  it("summarizes the model with its revision", () => {
    const summary = summarizeModel(model);
    expect(summary.revision).toBe(0);
    expect(summary.countsByKind.terminal).toBe(2);
    expect(summary.systems[0]?.totalCfm).toBeGreaterThan(0);
  });

  it("queries by kind with a limit and reports the total", () => {
    const result = queryElements(model, { kinds: ["terminal"], limit: 1 });
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.facts.cfm).toBeGreaterThan(0);
  });

  it("walks from a terminal up to its equipment", () => {
    const inspection = inspectNetwork(model, "sd-1");
    expect(inspection?.pathToEquipment[0]?.id).toBe("sd-1");
    expect(inspection?.pathToEquipment.at(-1)?.kind).toBe("equipment");
    expect(inspectNetwork(model, "nope")).toBeNull();
  });

  it("returns the schedule and open issues", () => {
    expect(airDeviceSchedule(model).rows.length).toBeGreaterThanOrEqual(3);
    expect(validationIssues(model).total).toBe(0);
  });
});
