/**
 * @jest-environment node
 *
 * The agent's name on the model server: a host that knows which assistant is
 * connected (a hosted app: "Claude", "ChatGPT") passes it, and every session
 * says hello as that name, through the model access and through the caller
 * add-on packs use. Without a name it stays "Local agent". Fails on a host
 * that always says "Local agent".
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { runEdit } from "@permitzip/bim-mcp";
import { LOCAL_AGENT_NAME, localCaller, localModelAccess, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";

const ADD_LEVEL = { type: "create_level", levelId: "level-9", name: "Level 9", elevationMm: 9000 } as const;
const ARGS = { project_id: "local", model_id: "demo" };

/** The in-memory server, recording the actor every hello names. */
function recording(): { server: LocalModelServer; names: string[] } {
  const inner = startInMemoryModelServer();
  const names: string[] = [];
  const server: LocalModelServer = {
    ...inner,
    socketFactory: (url, handlers) => {
      const socket = inner.socketFactory(url, handlers);
      return {
        ...socket,
        send: (data) => {
          const msg = JSON.parse(data) as { type?: string; actor?: { name?: string } };
          if (msg.type === "hello" && msg.actor?.name) names.push(msg.actor.name);
          socket.send(data);
        },
      };
    },
  };
  return { server, names };
}

describe("local-agent-name", () => {
  beforeAll(() => installFirstPartyAddOns());

  it("the caller says hello as the assistant's name", async () => {
    const { server, names } = recording();
    await server.seed(starterModel("demo"));
    const out = await runEdit(localCaller({ server, person: "p1", runId: "run-1", agentName: "Claude" }), "t_edit", {}, ARGS, ADD_LEVEL);
    expect(JSON.parse(out.content[0]?.text ?? "{}")).toMatchObject({ status: "saved" });
    expect(names).toEqual(["Claude"]);
  });

  it("the model access says hello as the assistant's name", async () => {
    const { server, names } = recording();
    await server.seed(starterModel("demo"));
    await localModelAccess({ server, person: "p1", runId: "run-1", agentName: "ChatGPT" }).withModel({}, ARGS, async () => undefined);
    expect(names).toEqual(["ChatGPT"]);
  });

  it("without a name it is the local agent", async () => {
    const { server, names } = recording();
    await server.seed(starterModel("demo"));
    await localModelAccess({ server, person: "p1", runId: "run-1" }).withModel({}, ARGS, async () => undefined);
    expect(names).toEqual([LOCAL_AGENT_NAME]);
  });
});
