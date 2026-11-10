/**
 * @jest-environment node
 *
 * Gaps an agent hit scripting a model, Nov 9: ceilings refused as "an older
 * version that doesn't store them" on a server that stores them (the
 * script's slice listed only the protocol's features, not the kernel's gated
 * record shapes), no way to see a value but throwing an error, and a room
 * traced from walls the script never read failing with words about the
 * model. Each case fails on the kit and tools before the fix.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CEILINGS_FEATURE, gatedRecordFeatures } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { LOCAL_RUNS_WHERE, createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { PROTOCOL_FEATURES, serverProtocol } from "@permitzip/bim-sync";
import { sliceFeatures } from "../src/scripts/tools";

const REPO_ROOT = resolve(__dirname, "../../..");

type Body = Record<string, unknown>;

function bodyOf(result: unknown): Body {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content[0]?.text ?? "";
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

const script = (reads: string, body: string) =>
  ['import { defineScript, units, building } from "@permitzip/bim-script";', "export default defineScript({", '  kind: "layout",', `  reads: ${reads},`, "  parameters: {},", "  run(ctx) {", body, "  },", "});", ""].join("\n");

const CEILING = script(
  "{ levels: true }",
  [
    "    const [level] = ctx.model.levels();",
    '    if (!level) throw new Error("no level");',
    "    const ft = units.ft;",
    "    const id = building.ceiling(ctx, { level: level.id, outline: [{ x: ft(0), y: ft(0) }, { x: ft(20), y: ft(0) }, { x: ft(20), y: ft(12) }, { x: ft(0), y: ft(12) }], height: ft(9) });",
    '    ctx.report("Ceiling", { id, level: level.id });',
  ].join("\n"),
);

const REPORT_ONLY = script("{ levels: true }", '    ctx.report("Levels", ctx.model.levels().map((l) => ({ id: l.id, name: l.name })));');

const ROOM_UNREAD = script("{ levels: true }", '    const [level] = ctx.model.levels();\n    building.spaceInWalls(ctx, { level: level?.id ?? "", inside: { x: units.ft(5), y: units.ft(5) } });');

describe("n9-script-kit-gaps", () => {
  let models: LocalModelServer;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
  });
  afterAll(() => models.close());

  async function connect(): Promise<Client> {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "ask" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    const client = new Client({ name: "n9", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("a script's slice carries the gated record shapes the server advertises, ceilings among them", () => {
    const advertised = new Set(serverProtocol().features);
    const features = sliceFeatures((f) => advertised.has(f));
    expect(features).toContain(CEILINGS_FEATURE);
    for (const f of gatedRecordFeatures()) expect(features).toContain(f);
    expect(Object.values(PROTOCOL_FEATURES)).toContain(CEILINGS_FEATURE);
    // A server that doesn't store ceilings still gets none.
    expect(sliceFeatures((f) => f !== CEILINGS_FEATURE)).not.toContain(CEILINGS_FEATURE);
  });

  it("building.ceiling previews on a server that stores ceilings, and its report comes back", async () => {
    const client = await connect();
    const preview = bodyOf(await client.callTool({ name: "bim_run_script", arguments: { model_id: "demo", script: { source: CEILING, reads: { levels: true } } } }));
    expect(preview).toMatchObject({ status: "previewed", kind: "edits", changes: { creates: 1 } });
    expect(preview.report).toEqual([{ label: "Ceiling", value: { id: expect.any(String), level: expect.any(String) } }]);
    await client.close();
  }, 120_000);

  it("a script that only reports runs, and says there is nothing to apply", async () => {
    const client = await connect();
    const answer = bodyOf(await client.callTool({ name: "bim_run_script", arguments: { model_id: "demo", script: { source: REPORT_ONLY, reads: { levels: true } } } }));
    expect(answer).toMatchObject({ status: "reported", nothing_changed: true });
    expect(answer.report).toEqual([{ label: "Levels", value: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) }]);
    expect(answer.apply_with).toBeUndefined();
    await client.close();
  }, 120_000);

  it("the check warns that a room traced from walls needs the walls read; the run says the same", async () => {
    const client = await connect();
    const checked = bodyOf(await client.callTool({ name: "bim_check_output", arguments: { model_id: "demo", script: { source: ROOM_UNREAD, reads: { levels: true } } } }));
    expect(checked.status).toBe("ok");
    expect(JSON.stringify(checked.warnings)).toMatch(/you didn't read walls: add \\"wall\\" to reads.kinds/);
    const run = bodyOf(await client.callTool({ name: "bim_run_script", arguments: { model_id: "demo", script: { source: ROOM_UNREAD, reads: { levels: true } } } }));
    expect(run).toMatchObject({ status: "stopped", code: "script_error" });
    expect(String(run.message)).toMatch(/you didn't read walls/);
    await client.close();
  }, 120_000);
});
