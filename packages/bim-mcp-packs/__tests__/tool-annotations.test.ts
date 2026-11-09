/**
 * @jest-environment node
 *
 * Every MutinyBIM tool says in its MCP annotations whether it changes the
 * model, so any client, and any host's permission map, reads it from the
 * tool list: read-only for the read list, changing (destructive unless it
 * only adds) for every edit and confirm-gated tool. The core's inline
 * annotations agree with the same lists.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { CORE_TOOLS, LOCAL_SCHEMAS, PACK_CONTROL_TOOL, createBimToolServer } from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { BIM_TOOL_PACKS } from "@permitzip/bim-plugin";
import { BIM_ADDITIVE_TOOL_NAMES, BIM_OPEN_WORLD_TOOL_NAMES, bimToolAnnotations, localToolPacks } from "@permitzip/bim-mcp-packs";
import { BIM_CONFIRM_GATED_TOOL_NAMES, BIM_EDIT_TOOL_NAMES, BIM_READ_TOOL_NAMES } from "../src/support/tool-names";

const REPO_ROOT = resolve(__dirname, "../../..");
const CATALOGUE: readonly string[] = BIM_TOOL_PACKS.flatMap((p) => p.tools);

describe("tool-annotations", () => {
  let models: LocalModelServer;
  let dir: string;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    dir = mkdtempSync(join(tmpdir(), "tool-annotations-"));
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await models.close();
  });

  it("classifies every catalogue tool once: read, or changing", () => {
    const read = new Set<string>(BIM_READ_TOOL_NAMES);
    const changing = new Set<string>([...BIM_EDIT_TOOL_NAMES, ...BIM_CONFIRM_GATED_TOOL_NAMES]);
    for (const tool of CATALOGUE) {
      expect({ tool, classified: read.has(tool) !== changing.has(tool) }).toEqual({ tool, classified: true });
      expect(bimToolAnnotations(tool)?.readOnlyHint).toBe(read.has(tool));
    }
    expect(bimToolAnnotations("acme_count_doors")).toBeNull();
  });

  it("only changing catalogue tools are listed as additive, and only real tools reach outside", () => {
    for (const tool of BIM_ADDITIVE_TOOL_NAMES) expect(bimToolAnnotations(tool)).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    for (const tool of BIM_OPEN_WORLD_TOOL_NAMES) expect(CATALOGUE).toContain(tool);
    expect(bimToolAnnotations("bim_delete_elements")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(bimToolAnnotations("bim_browse_autodesk_docs")).toEqual({ readOnlyHint: true, openWorldHint: true });
  });

  it("the server lists every tool with the annotations the lists give, the core included", async () => {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "ask" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)], families: "all" });
    const client = new Client({ name: "annotations", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const tools = (await client.listTools()).tools.filter((t) => t.name !== PACK_CONTROL_TOOL);
    expect(tools.map((t) => t.name).sort()).toEqual([...CATALOGUE].sort());
    for (const tool of tools) {
      const expected = bimToolAnnotations(tool.name);
      expect({ tool: tool.name, readOnlyHint: tool.annotations?.readOnlyHint }).toEqual({ tool: tool.name, readOnlyHint: expected?.readOnlyHint });
      if (!expected?.readOnlyHint) expect({ tool: tool.name, destructiveHint: tool.annotations?.destructiveHint }).toEqual({ tool: tool.name, destructiveHint: expected?.destructiveHint });
    }
    for (const name of CORE_TOOLS) expect(tools.find((t) => t.name === name)?.annotations).toMatchObject(bimToolAnnotations(name) ?? {});
    await client.close();
  });
});
