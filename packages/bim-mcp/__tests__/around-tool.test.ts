/**
 * @jest-environment node
 *
 * `aroundTool`: a host can answer some tool calls itself (a model it reaches
 * somewhere else) and pass the rest on. It wraps the core, the families and
 * the family switch, and changes nothing a client sees in the tool list.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { LOCAL_SCHEMAS, createBimToolServer, type ToolCallWrapper } from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { localToolPacks } from "@permitzip/bim-mcp-packs";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("aroundTool", () => {
  let models: LocalModelServer;
  let dir: string;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    dir = mkdtempSync(join(tmpdir(), "around-tool-"));
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await models.close();
  });

  async function connect(aroundTool?: ToolCallWrapper) {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)], ...(aroundTool ? { aroundTool } : {}) });
    const client = new Client({ name: "around", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  const text = (result: unknown): string => {
    const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
    return content.map((c) => c.text ?? "").join("");
  };

  it("answers the calls the host takes and passes the rest on, with the same tool list", async () => {
    const seen: string[] = [];
    const wrap: ToolCallWrapper = (name, next) =>
      ((args: { model_id?: string }, extra: unknown) => {
        seen.push(name);
        if (args?.model_id === "elsewhere-1") return { content: [{ type: "text", text: `answered ${name} elsewhere` }] };
        return (next as (a: unknown, e: unknown) => unknown)(args, extra);
      }) as never;
    const plain = await connect();
    const wrapped = await connect(wrap);
    expect((await wrapped.listTools()).tools.map((t) => t.name)).toEqual((await plain.listTools()).tools.map((t) => t.name));

    expect(text(await wrapped.callTool({ name: "bim_model_summary", arguments: { model_id: "elsewhere-1" } }))).toBe("answered bim_model_summary elsewhere");
    expect(text(await wrapped.callTool({ name: "bim_model_summary", arguments: { model_id: "demo" } }))).toContain("demo");
    await wrapped.callTool({ name: "bim_enable_pack", arguments: {} });
    expect(seen).toEqual(["bim_model_summary", "bim_model_summary", "bim_enable_pack"]);
  });
});
