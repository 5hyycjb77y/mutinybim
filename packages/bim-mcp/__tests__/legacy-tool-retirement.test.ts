/**
 * @jest-environment node
 *
 * Legacy MCP retirement policy, central response nudges, and `bim_enable_pack`
 * notification coalescing + Streamable HTTP delivery.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { BIM_TOOL_PACKS, CORE_PACK_ID } from "@permitzip/bim-plugin";
import {
  CORE_TOOLS,
  HOST_STEP_TOOL_NAMES,
  LEGACY_TOOL_SCRIPT_EQUIVALENTS,
  LOCAL_SCHEMAS,
  PACK_CONTROL_TOOL,
  createBimToolServer,
  legacyToolNudge,
} from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { localToolPacks } from "@permitzip/bim-mcp-packs";
import { parseArgs, startCli, type CliOptions } from "../src/cli";

const REPO_ROOT = resolve(__dirname, "../../..");
const TEST_PROJECT_ID = "00000000-0000-4000-8000-000000000001";

describe("legacy-tool-retirement", () => {
  let models: LocalModelServer;
  let dir: string;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    dir = mkdtempSync(join(tmpdir(), "legacy-retire-"));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await models.close();
  });

  it("LEGACY_TOOL_SCRIPT_EQUIVALENTS + HOST_STEP_TOOL_NAMES stay 1-for-1 in sync with BIM_TOOL_PACKS and docs/SCRIPTING-COVERAGE.md", () => {
    const covered = Object.keys(LEGACY_TOOL_SCRIPT_EQUIVALENTS);
    const hostSteps: readonly string[] = [...HOST_STEP_TOOL_NAMES];
    expect(covered).toHaveLength(138);
    expect(hostSteps).toHaveLength(21);

    const overlap = covered.filter((t) => hostSteps.includes(t));
    expect(overlap).toEqual([]);

    const catalogueNonCore = BIM_TOOL_PACKS.filter((p) => p.id !== CORE_PACK_ID).flatMap((p) => p.tools);
    expect(new Set([...covered, ...hostSteps])).toEqual(new Set(catalogueNonCore));

    for (const coreTool of CORE_TOOLS) expect(legacyToolNudge(coreTool)).toBeNull();
    for (const hostStep of hostSteps) expect(legacyToolNudge(hostStep)).toBeNull();

    const doc = readFileSync(join(REPO_ROOT, "docs/SCRIPTING-COVERAGE.md"), "utf8");
    const docCovered = new Set<string>();
    const docHostSteps = new Set<string>();
    for (const line of doc.split("\n")) {
      const m = /^\| `(bim_[a-z0-9_]+)` \|.*\| (covered|host step) \|/.exec(line);
      if (!m || !m[1]) continue;
      if (m[2] === "covered") docCovered.add(m[1]);
      else docHostSteps.add(m[1]);
    }
    expect(docCovered).toEqual(new Set(covered));
    expect(docHostSteps).toEqual(new Set(hostSteps));
  });

  it("appends a single retirement nudge on covered legacy tools while keeping JSON in content[0], and never nudges host-step or core tools", async () => {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)], families: "all" });
    const client = new Client({ name: "retire-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);

    // Core tool: no nudge
    const summary = await client.callTool({ name: "bim_model_summary", arguments: { model_id: "demo" } });
    const summaryBlocks = summary.content as { type: string; text: string }[];
    expect(summaryBlocks.every((c) => !c.text.includes("slated for retirement"))).toBe(true);

    // Covered legacy tool: joined text remains valid JSON and carries deprecation_note with the exact script equivalent once
    const levels = await client.callTool({ name: "bim_list_levels", arguments: { project_id: TEST_PROJECT_ID, model_id: "demo" } });
    const levelBlocks = levels.content as { type: string; text: string }[];
    const joined = levelBlocks.map((c) => c.text).join("\n");
    const parsed = JSON.parse(joined) as Record<string, unknown>;
    expect(typeof parsed.deprecation_note).toBe("string");
    expect(parsed.deprecation_note).toContain("slated for retirement in favor of @permitzip/bim-script");
    expect(parsed.deprecation_note).toContain(LEGACY_TOOL_SCRIPT_EQUIVALENTS.bim_list_levels);
    expect(parsed.deprecation_note).toContain("bim_script_reference");
    expect(joined.split("slated for retirement in favor of @permitzip/bim-script")).toHaveLength(2);

    // Host-step tool: no nudge
    const firmParts = await client.callTool({ name: "bim_list_firm_parts", arguments: { project_id: TEST_PROJECT_ID } });
    const firmBlocks = firmParts.content as { type: string; text: string }[];
    expect(firmBlocks.every((c) => !c.text.includes("slated for retirement"))).toBe(true);

    await client.close();
  });

  it("bim_enable_pack coalesces notifications/tools/list_changed to exactly 1 notification over InMemoryTransport and steers agents to scripts", async () => {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)] });
    const client = new Client({ name: "coalesce-test", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);

    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed += 1;
    });

    const listing = await client.callTool({ name: PACK_CONTROL_TOOL, arguments: {} });
    const listingText = (listing.content as { text: string }[])[0]?.text ?? "";
    expect(listingText).toContain("@permitzip/bim-script");
    expect(listingText).toContain("/packs/<family>/mcp");

    const enabled = await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "electrical" } });
    const enabledText = (enabled.content as { text: string }[])[0]?.text ?? "";
    await new Promise((r) => setTimeout(r, 30));
    expect(changed).toBe(1);
    expect(enabledText).toContain("slated for retirement");
    expect(enabledText).toContain("bim_script_reference");

    // Calling again when already enabled sends 0 new notifications
    await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "electrical" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(changed).toBe(1);

    // Enabling a family with host-step tools (parts) mentions /packs/parts/mcp and sends exactly 1 more notification
    const partsEnabled = await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "parts" } });
    const partsText = (partsEnabled.content as { text: string }[])[0]?.text ?? "";
    await new Promise((r) => setTimeout(r, 30));
    expect(changed).toBe(2);
    expect(partsText).toContain("/packs/parts/mcp");
    expect(partsText).toContain("bim_list_firm_parts");

    await client.close();
  });

  it("bim_enable_pack delivers exactly 1 notifications/tools/list_changed over Streamable HTTP via the active POST response context", async () => {
    const running = await startCli({ ...(parseArgs(["--http", "--port", "0", "--approve", "auto", "--files", dir]) as CliOptions) }, REPO_ROOT, (host, files) => [localToolPacks(host, files)]);
    const client = new Client({ name: "http-coalesce", version: "1.0.0" });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      changed += 1;
    });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url!)));
      await client.callTool({ name: PACK_CONTROL_TOOL, arguments: { family: "drafting" } });
      await new Promise((r) => setTimeout(r, 40));
      expect(changed).toBe(1);
    } finally {
      await client.close().catch(() => {});
      await running.close();
    }
  });
});
