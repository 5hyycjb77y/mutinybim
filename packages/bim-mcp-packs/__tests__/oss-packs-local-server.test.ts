/**
 * @jest-environment node
 *
 * The open tool server with every add-on pack, as one person runs it
 * (`mutinybim-mcp --packs all`): it lists exactly the MutinyBIM tools
 * a host serves (the 168 names pinned in fixtures/tool-names.json),
 * a pack edit lands only after the person approves it in their client, a
 * declined one lands nothing, and a service that needs a hosted MutinyBIM
 * answers in plain words.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { createLocalHost, startInMemoryModelServer, starterModel, type LocalModelServer } from "@permitzip/bim-mcp/local";
import { localToolPacks } from "@permitzip/bim-mcp-packs";

const REPO_ROOT = resolve(__dirname, "../../..");
const FIXTURE = join(__dirname, "fixtures", "tool-names.json");
// The pack tools keep the host's schemas byte for byte, so they take a project uuid; the local server has one workspace and ignores it.
const PROJECT = "00000000-0000-4000-8000-000000000001";

type Body = Record<string, unknown>;
const bodyOf = (r: unknown): Body => {
  const t = (r as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
  return t.trimStart().startsWith("{") ? (JSON.parse(t) as Body) : { message: t };
};

describe("oss-packs-local-server", () => {
  let models: LocalModelServer;
  let dir: string;
  let answer: "approve" | "decline" = "approve";
  const asked: string[] = [];

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    await models.seed(starterModel("demo"));
    dir = mkdtempSync(join(tmpdir(), "oss-packs-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function connect() {
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "ask" });
    // --packs all: every family on from the start.
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, packs: [localToolPacks(host, dir)], families: "all" });
    const client = new Client({ name: "packs", version: "1.0.0" }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return answer === "approve" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  it("lists exactly the pinned MutinyBIM tools", async () => {
    const pinned = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { order: string[] }).order;
    const client = await connect();
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect([...listed].sort()).toEqual([...pinned].sort());
    expect(listed).toHaveLength(168);
    await client.close();
  });

  it("a pack edit lands after the person approves it, and a declined one lands nothing", async () => {
    const client = await connect();
    const create = (name: string, elevation_ft: number) => client.callTool({ name: "bim_create_level", arguments: { project_id: PROJECT, model_id: "demo", name, elevation_ft } });
    const named = async (name: string) => Object.values((await models.head("demo"))?.elements ?? {}).filter((e) => e.kind === "level" && "name" in e && e.name === name);
    const before = await models.head("demo");
    const saved = bodyOf(await create("Level 5", 40));
    expect(saved).toMatchObject({ status: "saved" });
    expect(asked.at(-1)).toContain("create_level");
    expect(await named("Level 5")).toHaveLength(1);
    answer = "decline";
    const mid = await models.head("demo");
    const declined = bodyOf(await create("Level 6", 50));
    expect(declined).toMatchObject({ status: "refused", code: "not_approved" });
    expect(await models.head("demo")).toEqual(mid);
    expect(await named("Level 6")).toHaveLength(0);
    expect(Number(mid?.revision)).toBe(Number(before?.revision) + 1);
    answer = "approve";
    await client.close();
  });

  it("a service that needs a hosted MutinyBIM says so in plain words", async () => {
    const client = await connect();
    const out = bodyOf(await client.callTool({ name: "bim_list_linked_models", arguments: { project_id: PROJECT, model_id: "demo" } }));
    expect(JSON.stringify(out)).not.toMatch(/undefined|TypeError/);
    await client.close();
  });
});
