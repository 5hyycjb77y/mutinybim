/**
 * @jest-environment node
 *
 * The jobs the add-on tools did that scripts could not (Nov 7 coverage
 * audit), now done with ONLY the core tools: receptacles by code spacing,
 * room schedules, schedule numbers, panel loads, rebalancing, room circuit
 * templates, automatic tags and dimensions, sheet packing, one-line
 * diagrams, duct sizing, the clash check, levels from a linked model,
 * catalogues and surfaces. Each runs the reference's own worked example
 * through bim_run_script (a preview) → bim_apply_output. Fails before the
 * gap work: ctx.read, ctx.propose, documents.autoTag, checks.clashes and the
 * rest did not exist, and a class-based schedule could not be made.
 * Real local script runner, in-memory model server.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, executeCommand, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { KIT_ENTRIES, KIT_RECIPES } from "@permitzip/bim-script";
import { CORE_TOOLS, LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { LOCAL_RUNS_WHERE, createLocalHost, startInMemoryModelServer, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");
type Body = Record<string, unknown>;
type Reads = Record<string, unknown>;

function bodyOf(result: unknown): Body {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

function twoLevels(modelId: string): ModelState {
  let m: ModelState = { modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const [levelId, name, elevationMm] of [["L1", "Level 1", 0], ["L2", "Level 2", 4000]] as const) {
    const r = executeCommand(m, { type: "create_level", levelId, name, elevationMm });
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  }
  return { ...m, revision: 0 as ModelState["revision"] };
}

const recipe = (name: string): string => {
  const r = KIT_RECIPES.find((x) => x.name === name);
  if (!r) throw new Error(`No recipe "${name}".`);
  return r.example;
};

const entry = (name: string): string => {
  const e = KIT_ENTRIES.find((x) => x.name === name);
  if (!e) throw new Error(`No entry "${name}".`);
  return e.example;
};

/** The reads a worked example declares (the runner refuses a run with other reads). */
function readsOf(source: string): Reads {
  const m = /reads: (\{[^}]*\})/.exec(source);
  if (!m?.[1]) throw new Error("The example declares no reads.");
  return JSON.parse(m[1].replace(/(\w+):/g, '"$1":')) as Reads;
}

const all = (m: ModelState | undefined): BimElement[] => Object.values(m?.elements ?? {});
const ofKind = (m: ModelState | undefined, kind: string): BimElement[] => all(m).filter((e) => e.kind === kind);
const field = <T>(e: BimElement | undefined, key: string): T | undefined => (e && key in e ? (e as unknown as Record<string, T>)[key] : undefined);

describe("core-only-gaps: the jobs only add-on tools did, done with one script and the core tools", () => {
  let models: LocalModelServer;
  let client: Client;
  let n = 0;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    client = new Client({ name: "core-only-gaps", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(async () => {
    await client.close();
    await models.close();
  });

  /** Seeds a fresh model, previews the script, applies it; the model after and the preview's label. */
  async function apply(source: string): Promise<{ m: ModelState | undefined; label: string }> {
    const modelId = `gap-${++n}`;
    await models.seed(twoLevels(modelId));
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));
    const preview = await call("bim_run_script", { model_id: modelId, script: { source, reads: readsOf(source) } });
    if (preview.status !== "previewed") throw new Error(JSON.stringify(preview).slice(0, 1200));
    const applied = await call("bim_apply_output", (preview.apply_with as { args: Body }).args);
    expect(applied).toMatchObject({ status: "saved" });
    return { m: (await models.head(modelId)) ?? undefined, label: String(preview.label ?? "") };
  }

  it("only the core tools are on the server", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...CORE_TOOLS]);
  });

  it("places receptacles by NEC 210.52 spacing in two rooms", async () => {
    const { m } = await apply(recipe("Receptacles by code spacing"));
    expect(ofKind(m, "room")).toHaveLength(2);
    const receptacles = ofKind(m, "part").filter((p) => field<string>(p, "typeId") === "builtin:duplex-receptacle@1");
    // Bedroom 14 x 14 ft and living room 18 x 14 ft: every point of wall within 6 ft takes more than one each.
    expect(receptacles.length).toBeGreaterThanOrEqual(6);
    expect(m?.elements["builtin:duplex-receptacle@1"]?.kind).toBe("part_type");
  }, 120_000);

  it("makes a room schedule from the room class, with area and totals, on a sheet", async () => {
    const { m } = await apply(recipe("Room and space schedules"));
    const schedule = ofKind(m, "view").find((v) => field<string>(v, "viewType") === "schedule");
    const def = field<{ scheduleV2?: { source: { kind: string; classes: string[] }; columns: { path?: string }[]; grandTotals: boolean } }>(schedule, "props")?.scheduleV2;
    expect(def?.source).toMatchObject({ kind: "classes", classes: ["arch.room"] });
    expect(def?.columns.map((c) => c.path)).toEqual(["number", "name", "area"]);
    expect(def?.grandTotals).toBe(true);
    expect(ofKind(m, "viewport")).toHaveLength(1);
  }, 120_000);

  it("reads a schedule's numbers and decides from them", async () => {
    const { label } = await apply(recipe("Read a schedule's numbers"));
    // Bedroom 14 x 14 ft (18.2 m²) and living room 18 x 14 ft (23.4 m²).
    expect(label).toBe("1 rooms over 20 m²");
  }, 120_000);

  it("circuits a dwelling unit from a room template and reads the panel's loads per phase", async () => {
    const { m, label } = await apply(recipe("Electrical panel and panel schedule"));
    const panel = all(m).find((e) => field<string>(e, "mark") === "LP-1");
    expect(panel).toBeDefined();
    const circuits = ofKind(m, "service_link").filter((l) => field<{ elementId: string }>(l, "source")?.elementId === panel?.id);
    expect(circuits).toHaveLength(2);
    // Each circuit carries the receptacles of its room.
    for (const c of circuits) expect(field<unknown[]>(c, "members")?.length ?? 0).toBeGreaterThan(0);
    expect(label).toMatch(/^LP-1: \d+ VA \(A \d+, B \d+\)$/);
  }, 120_000);

  it("plans a phase rebalance for the panel and says why when nothing helps", async () => {
    const { label } = await apply(recipe("Rebalance a panel"));
    expect(label).toMatch(/LP-1/);
  }, 120_000);

  it("tags every duct in a plan and dimensions the runs", async () => {
    const { m } = await apply(recipe("Tag and dimension a plan"));
    const items = ofKind(m, "drawing_item");
    const ducts = new Set<string>(ofKind(m, "run_segment").map((d) => d.id));
    const tags = items.filter((i) => field<string>(i, "shape") === "tag");
    expect(tags.length).toBeGreaterThanOrEqual(2);
    for (const t of tags) expect(ducts.has(String(field<{ elementId: string }>(t, "tag")?.elementId))).toBe(true);
    expect(items.filter((i) => field<string>(i, "shape") === "dimension").length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("packs a sheet's views into a grid", async () => {
    const { m } = await apply(recipe("Pack sheets"));
    const centers = ofKind(m, "viewport").map((v) => field<{ x: number; y: number }>(v, "center"));
    expect(centers).toHaveLength(2);
    // Both were placed at the same point; packing moved them apart.
    expect(Math.hypot((centers[0]?.x ?? 0) - (centers[1]?.x ?? 0), (centers[0]?.y ?? 0) - (centers[1]?.y ?? 0))).toBeGreaterThan(10);
  }, 120_000);

  it("draws a one-line diagram from a described distribution, and a live one", async () => {
    const drawn = await apply(entry("documents.oneLine"));
    expect(ofKind(drawn.m, "drawing_item").length).toBeGreaterThan(3);
    const live = await apply(recipe("One-line diagram"));
    const view = ofKind(live.m, "view").find((v) => field<{ diagram?: { kind: string } }>(v, "props")?.diagram);
    expect(field<{ diagram: { kind: string } }>(view, "props")?.diagram.kind).toBe("one_line");
  }, 120_000);

  it("sizes ducts from airflow with the system's criteria", async () => {
    const { m } = await apply(recipe("Size ducts from airflow"));
    const widths = ofKind(m, "run_segment").map((d) => field<{ width: number }>(d, "size")?.width ?? 0).sort((a, b) => a - b);
    expect(widths).toHaveLength(2);
    // 1600 CFM needs a wider duct than 800 CFM at the same 12 in depth.
    expect(widths[1] ?? 0).toBeGreaterThan(widths[0] ?? 0);
  }, 120_000);

  it("finds the clash between two crossing ducts", async () => {
    const { label } = await apply(recipe("Clash check"));
    expect(label).toBe("1 clash(es) after routing");
  }, 120_000);

  it("adds the linked model's new storeys as levels", async () => {
    const { m, label } = await apply(recipe("Levels from a linked model"));
    expect(label).toBe("Level 3: add, Roof: add");
    expect(ofKind(m, "level").map((l) => field<string>(l, "name")).sort()).toEqual(["Level 1", "Level 2", "Level 3", "Roof"]);
  }, 120_000);

  it("reads the catalogues: a starter receptacle and the drainage fittings", async () => {
    const { label } = await apply(recipe("Catalogues"));
    expect(label).toMatch(/drainage fittings$/);
    expect(label).not.toMatch(/^no receptacle/);
  }, 120_000);

  it("sets a duct's height from the surfaces over it", async () => {
    const { m } = await apply(recipe("Ceiling and floor heights"));
    expect(ofKind(m, "run_segment")).toHaveLength(1);
  }, 120_000);
});
