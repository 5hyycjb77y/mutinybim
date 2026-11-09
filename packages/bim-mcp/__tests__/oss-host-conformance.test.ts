/**
 * @jest-environment node
 *
 * What every host must do, proved on the open local host: a read-only host
 * refuses edits before the model changes; a host with scripts off says so
 * before a script is written and refuses to run one; no change lands
 * without the approval gate's yes (a client that can't ask is refused in
 * words, `--approve auto` lands it and nothing else does); an add-on pack
 * registers beside the core without touching it, and a pack that reuses a
 * core name is refused. Each case fails on a host that skips the check.
 */
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import type { ScriptRunRequest, ScriptRunResult } from "@permitzip/bim-script";
import { CORE_TOOLS, ELICITATION_UNSUPPORTED, LOCAL_SCHEMAS, coreToolsOutsideCatalogue, createBimToolServer, packProblems, text, type BimToolPack } from "@permitzip/bim-mcp";
import { READ_ONLY_REFUSAL, createLocalHost, startInMemoryModelServer, starterModel, type LocalHostOptions, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");
const SOURCE = 'import { defineScript } from "@permitzip/bim-script";\nexport default defineScript({ kind: "layout", reads: { levels: true }, parameters: {}, run(ctx) {} });\n';
const OUTPUT = { kind: "edits", label: "One new level", steps: 1, batches: [{ type: "batch_edits", label: "One new level", commands: [{ type: "create_level", levelId: "level-9", name: "Level 9", elevationMm: 9000 }] }] };

/** A runner that answers every run with OUTPUT (the real runner is proved by the end-to-end test). */
const fixedRunner = {
  id: "fixed",
  limits: { memoryMb: 1024, wallMs: 30_000, outputBytes: 2 * 1024 * 1024 },
  runs: [] as ScriptRunRequest[],
  async run(request: ScriptRunRequest): Promise<ScriptRunResult> {
    this.runs.push(request);
    return { ok: true, output: OUTPUT, bytes: 100, ms: 1 };
  },
};

type Body = Record<string, unknown>;
const bodyOf = (result: unknown): Body => {
  const t = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
  return t.trimStart().startsWith("{") ? (JSON.parse(t) as Body) : { message: t };
};

describe("oss-host-conformance", () => {
  let models: LocalModelServer;
  beforeAll(() => installFirstPartyAddOns());
  beforeEach(async () => {
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    fixedRunner.runs.length = 0;
  });

  async function client(options: Partial<LocalHostOptions>, elicit: "approve" | "none" = "approve", packs: readonly BimToolPack[] = []) {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, runner: fixedRunner, ...options });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs });
    const c = new Client({ name: "conformance", version: "1.0.0" }, elicit === "approve" ? { capabilities: { elicitation: {} } } : {});
    if (elicit === "approve") {
      const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
      c.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), c.connect(a)]);
    return { call: async (name: string, args: Body) => bodyOf(await c.callTool({ name, arguments: args })), close: () => c.close() };
  }

  async function previewArgs(c: Awaited<ReturnType<typeof client>>): Promise<Body> {
    const preview = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: { levels: true } } });
    expect(preview.status).toBe("previewed");
    return (preview.apply_with as { args: Body }).args;
  }

  it("every core tool is a catalogue tool (pack membership lives in one place)", () => {
    expect(coreToolsOutsideCatalogue()).toEqual([]);
    expect(CORE_TOOLS.slice(0, 5)).toEqual(["bim_script_reference", "bim_check_output", "bim_run_script", "bim_apply_output", "bim_save_part_type"]);
  });

  it("a read-only host refuses the edit and the model is unchanged", async () => {
    const c = await client({ readOnly: true });
    const args = await previewArgs(c);
    const before = await models.head("demo");
    const refused = await c.call("bim_apply_output", args);
    expect(refused).toMatchObject({ status: "refused", code: "read_only", message: READ_ONLY_REFUSAL });
    expect(await models.head("demo")).toEqual(before);
    await c.close();
  });

  it("a host with scripts off says so in the reference and runs nothing", async () => {
    const c = await client({ scripts: false });
    const reference = await c.call("bim_script_reference", {});
    expect(reference.script_machine).toMatchObject({ ready: false });
    const run = await c.call("bim_run_script", { model_id: "demo", script: { source: SOURCE, reads: { levels: true } } });
    expect(run).toMatchObject({ status: "refused", nothing_changed: true });
    expect(fixedRunner.runs).toHaveLength(0);
    await c.close();
  });

  it("a client that can't ask the person: refused in words, nothing lands", async () => {
    const c = await client({}, "none");
    const args = await previewArgs(c);
    const before = await models.head("demo");
    expect(await c.call("bim_apply_output", args)).toMatchObject({ status: "not_approved", message: ELICITATION_UNSUPPORTED, nothing_changed: true });
    expect(await models.head("demo")).toEqual(before);
    await c.close();
  });

  it("--approve auto lands it without asking", async () => {
    const c = await client({ approve: "auto" }, "none");
    const args = await previewArgs(c);
    expect(await c.call("bim_apply_output", args)).toMatchObject({ status: "saved" });
    expect((await models.head("demo"))?.elements["level-9"]).toMatchObject({ name: "Level 9" });
    await c.close();
  });

  it("an add-on pack registers beside the core, with the host it was given", async () => {
    let sawHost = false;
    const pack: BimToolPack = {
      id: "acme-hello",
      purpose: "says hello",
      tools: ["acme_hello"],
      register(server: McpServer, host) {
        sawHost = typeof host.withArea === "function";
        server.registerTool("acme_hello", { description: "Hello", inputSchema: { name: z.string() } }, async (args) => text({ hello: args.name }));
      },
    };
    const c = await client({}, "approve", [pack]);
    // Opt-in: an add-on pack is its own family, off until turned on.
    expect(await c.call("acme_hello", { name: "pack" })).toEqual({ message: expect.stringContaining("disabled") });
    await c.call("bim_enable_pack", { family: "acme-hello" });
    expect(await c.call("acme_hello", { name: "pack" })).toEqual({ hello: "pack" });
    expect(sawHost).toBe(true);
    await c.close();
  });

  it("a pack that reuses a core tool name is refused before the server starts", () => {
    const clash: BimToolPack = { id: "clash", purpose: "x", tools: ["bim_run_script"], register: () => undefined };
    expect(packProblems([clash])).toEqual([expect.stringContaining("bim_run_script is already on this server (a core tool)")]);
    expect(() => createBimToolServer({ host: createLocalHost({ server: models, repoRoot: REPO_ROOT, runner: fixedRunner }), packs: [clash] })).toThrow(/can't start/);
  });
});
