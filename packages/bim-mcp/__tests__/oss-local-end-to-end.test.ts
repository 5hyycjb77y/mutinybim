/**
 * @jest-environment node
 *
 * The open MutinyBIM tool server end to end, as an outside agent uses it: an
 * MCP client connects to `createBimToolServer` with the open local host (an
 * in-memory model server, the real local script runner, approvals asked
 * through MCP elicitation) and walks the script workflow: reference → check
 * → run (a preview that changes nothing) → apply (the person approves in the
 * client) → the model changed. Then the same server over streamable HTTP.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { KIT_ENTRIES } from "@permitzip/bim-script";
import { CORE_TOOLS, LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { LOCAL_RUNS_WHERE, createLocalHost, serveHttp, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");

const SCRIPT = [
  'import { defineScript } from "@permitzip/bim-script";',
  "export default defineScript({",
  '  kind: "layout",',
  "  reads: { levels: true },",
  "  parameters: {},",
  "  run(ctx) {",
  '    ctx.edit({ type: "create_level", levelId: "level-2", name: "Level 2", elevationMm: 4000 });',
  "  },",
  "});",
  "",
].join("\n");

type Body = Record<string, unknown>;

function bodyOf(result: unknown): Body {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content[0]?.text ?? "";
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

describe("oss-local-end-to-end: an MCP client runs a script through the open tool server and the model changes", () => {
  let models: LocalModelServer;
  const asked: string[] = [];
  let answer: "approve" | "decline" = "approve";

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
  });
  afterAll(() => models.close());

  async function connect(): Promise<Client> {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "ask" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    const client = new Client({ name: "oss-e2e", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return answer === "approve" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("lists exactly the core pack", async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([...CORE_TOOLS]);
    await client.close();
  });

  it("reference → check → run (nothing changes) → apply after the person approves → the model has the new level", async () => {
    const client = await connect();
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));

    const reference = await call("bim_script_reference", {});
    expect(reference.script_machine).toEqual({ ready: true });
    expect(reference.kit).toEqual(expect.arrayContaining([expect.any(String)]));

    const checked = await call("bim_check_output", { model_id: "demo", script: { source: SCRIPT, reads: { levels: true } } });
    expect(checked).toMatchObject({ status: "ok", findings: [] });

    const before = await models.head("demo");
    const preview = await call("bim_run_script", { model_id: "demo", script: { source: SCRIPT, reads: { levels: true } } });
    expect(preview).toMatchObject({ status: "previewed", kind: "edits", changes: { creates: 1, edits: 0, deletes: 0 }, approval: "session_allowed" });
    expect(await models.head("demo")).toEqual(before);

    const applyWith = preview.apply_with as { tool: string; args: Body };
    expect(applyWith.tool).toBe("bim_apply_output");
    const applied = await call(applyWith.tool, applyWith.args);
    expect(applied).toMatchObject({ status: "saved" });
    expect(asked).toEqual([expect.stringContaining('land "')]);

    const after = await models.head("demo");
    expect(after?.elements["level-2"]).toMatchObject({ kind: "level", name: "Level 2" });
    expect(Number(after?.revision)).toBe(Number(before?.revision) + 1);
    await client.close();
  }, 120_000);

  it("a declined approval lands nothing", async () => {
    answer = "decline";
    const client = await connect();
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));
    const source = SCRIPT.replace(/level-2/g, "level-3").replace("Level 2", "Level 3").replace("4000", "8000");
    const preview = await call("bim_run_script", { model_id: "demo", script: { source, reads: { levels: true } } });
    const before = await models.head("demo");
    const declined = await call("bim_apply_output", (preview.apply_with as { args: Body }).args);
    expect(declined).toMatchObject({ status: "not_approved", nothing_changed: true });
    expect(await models.head("demo")).toEqual(before);
    answer = "approve";
    await client.close();
  }, 120_000);

  it("a part script previews part types and saves them to the library after the person approves", async () => {
    const client = await connect();
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));
    const part = KIT_ENTRIES.find((e) => e.name === "PartBuilder.connector")?.example ?? "";
    const preview = await call("bim_run_script", { script: { source: part, reads: {} } });
    expect(preview).toMatchObject({ status: "previewed", kind: "part_types", approval: "ask_every_time" });
    const args = { ...(preview.apply_with as { args: Body }).args, save_as: { key: "local.sample_part", name: "Sample part", version: "1.0.0" } };
    const saved = await call("bim_save_part_type", args);
    expect(saved).toMatchObject({ status: "saved", library: "firm", script: { key: "local.sample_part", result: "saved" } });
    expect(asked.at(-1)).toContain("save 1 part type");
    const listed = await call("bim_script_reference", { library: "list" });
    expect(listed.scripts).toEqual([expect.objectContaining({ key: "local.sample_part", yours: true })]);
    await client.close();
  }, 120_000);

  it("the same server over streamable HTTP", async () => {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "ask" });
    const http = await serveHttp(() => createBimToolServer({ host, schemas: LOCAL_SCHEMAS }));
    try {
      const client = new Client({ name: "oss-e2e-http", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...CORE_TOOLS]);
      const summary = bodyOf(await client.callTool({ name: "bim_model_summary", arguments: { model_id: "demo" } }));
      expect(summary).toMatchObject({ modelId: "demo", countsByKind: { level: 2 } });
      await client.close();
    } finally {
      await http.close();
    }
  }, 60_000);
});
