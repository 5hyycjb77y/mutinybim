/**
 * @jest-environment node
 *
 * Script-first, ten at most (AGENTS.md, "Tools: script-first, ten at most").
 * The default tool list is the core pack and stays within CORE_TOOL_BUDGET:
 * a server started with no flags (stdio or /mcp) lists exactly the core, every
 * other family is opt-in (--packs, /packs/<family>/mcp, or bim_enable_pack in
 * the session, which sends notifications/tools/list_changed). Raising the
 * budget or adding a core tool is the maintainer's call, never a test edit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { BIM_TOOL_PACKS, bimPack } from "@permitzip/bim-plugin";
import { CORE_TOOLS, CORE_TOOL_BUDGET, LOCAL_SCHEMAS, PACK_CONTROL_TOOL, TOOL_FAMILIES, createBimToolServer } from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { localToolPacks } from "@permitzip/bim-mcp-packs";
import { parseArgs, startCli, type CliOptions } from "../src/cli";

const REPO_ROOT = resolve(__dirname, "../../..");
const DEFAULT_LIST = [...CORE_TOOLS, PACK_CONTROL_TOOL];

describe("core-tool-budget", () => {
  let models: LocalModelServer;
  let dir: string;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    dir = mkdtempSync(join(tmpdir(), "core-budget-"));
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await models.close();
  });

  function server(families?: readonly string[] | "all") {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    return createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)], ...(families ? { families } : {}) });
  }

  async function connect(families?: readonly string[] | "all") {
    const client = new Client({ name: "budget", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server(families).connect(b), client.connect(a)]);
    return client;
  }

  const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

  it("the core pack, the family switch included, is within the budget of ten", () => {
    expect(CORE_TOOL_BUDGET).toBe(10);
    expect(DEFAULT_LIST.length).toBeLessThanOrEqual(CORE_TOOL_BUDGET);
    expect(CORE_TOOLS).toEqual(["bim_script_reference", "bim_check_output", "bim_run_script", "bim_apply_output", "bim_save_part_type", "bim_model_summary", "bim_query_elements", "bim_inspect_network", "bim_validation_issues"]);
  });

  it("with no flags the default is none: the server lists exactly the core, and says its tool list can change", async () => {
    expect((parseArgs([]) as CliOptions).packs).toBe("none");
    const client = await connect();
    expect(await names(client)).toEqual(DEFAULT_LIST);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    await client.close();
  });

  it("--packs takes none, all or a comma list of families, by slug, id or skill name", () => {
    expect((parseArgs(["--packs", "drafting,ducts_pipes,mutinybim-electrical"]) as CliOptions).packs).toEqual(["drafting", "ducts-pipes", "electrical"]);
    expect((parseArgs(["--packs", "all"]) as CliOptions).packs).toBe("all");
    expect(parseArgs(["--packs", "everything"])).toMatchObject({ error: expect.stringContaining("comma list of families") });
    expect(TOOL_FAMILIES).not.toContain("scripts");
    expect(TOOL_FAMILIES).not.toContain("core");
  });

  it("the core is one definition: the catalogue's core pack is exactly the server's core, and no family repeats a core tool", () => {
    expect(bimPack("core")?.tools).toEqual(CORE_TOOLS);
    expect(bimPack("mutinybim")?.id).toBe("core");
    for (const pack of BIM_TOOL_PACKS.filter((p) => p.id !== "core")) for (const tool of pack.tools) expect(CORE_TOOLS).not.toContain(tool);
    expect(CORE_TOOLS.length + 1).toBeLessThanOrEqual(CORE_TOOL_BUDGET);
  });

  it("a family named at start is listed with the core; every other family stays off", async () => {
    const client = await connect(["drafting"]);
    const listed = await names(client);
    expect(listed).toEqual(expect.arrayContaining([...DEFAULT_LIST, ...(bimPack("drafting")?.tools ?? [])]));
    expect(listed).not.toContain(bimPack("electrical")?.tools[0]);
    await client.close();
  });

  it("bim_enable_pack lists the families and turns one on; the server sends notifications/tools/list_changed", async () => {
    const client = await connect();
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed += 1;
    });
    const listing = await client.callTool({ name: PACK_CONTROL_TOOL, arguments: {} });
    const text = (listing.content as { text: string }[])[0]?.text ?? "";
    for (const family of TOOL_FAMILIES) expect(text).toContain(`- ${family} (`);
    const electrical = bimPack("electrical")?.tools ?? [];
    await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "electrical" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(changed).toBeGreaterThan(0);
    expect(await names(client)).toEqual(expect.arrayContaining([...DEFAULT_LIST, ...electrical]));
    const unknown = await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "everything" } });
    expect(unknown.isError).toBe(true);
    await client.close();
  });

  it("--packs all lists every tool and needs no switch (the 168-tool parity list)", async () => {
    const client = await connect("all");
    const listed = await names(client);
    expect(listed).not.toContain(PACK_CONTROL_TOOL);
    expect(new Set(listed)).toEqual(new Set(BIM_TOOL_PACKS.flatMap((p) => p.tools)));
    await client.close();
  });

  it("over HTTP, /mcp is the core and /packs/<family>/mcp is the core plus that family", async () => {
    const started = await startCli({ ...(parseArgs(["--http", "--port", "0"]) as CliOptions) }, REPO_ROOT, (host, files) => [localToolPacks(host, files)]);
    try {
      const base = new URL(started.url ?? "");
      const list = async (path: string) => {
        const client = new Client({ name: "budget-http", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(path, base)));
        const listed = await names(client);
        await client.close();
        return listed;
      };
      expect(await list("/mcp")).toEqual(DEFAULT_LIST);
      const plumbing = await list("/packs/plumbing/mcp");
      expect(plumbing).toEqual(expect.arrayContaining([...DEFAULT_LIST, ...(bimPack("plumbing")?.tools ?? [])]));
      expect(plumbing).not.toContain(bimPack("drafting")?.tools[0]);
      const missing = await fetch(new URL("/packs/everything/mcp", base), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(missing.status).toBe(404);
    } finally {
      await started.close();
    }
  });
});
