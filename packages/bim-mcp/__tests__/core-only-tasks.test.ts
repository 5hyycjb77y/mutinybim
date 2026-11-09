/**
 * @jest-environment node
 *
 * Script-first, proven: with ONLY the core tools on the server (no add-on
 * family), an agent does each job an engineer names by writing one script:
 * bim_run_script (a preview) → bim_apply_output → the model has the result.
 * The scripts are the reference's own worked examples (bim_script_reference
 * serves them), so the examples are proven too. Real local script runner,
 * in-memory model server.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { DEFAULT_SETTINGS, executeCommand, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { KIT_RECIPES } from "@permitzip/bim-script";
import { CORE_TOOLS, LOCAL_SCHEMAS, createBimToolServer } from "@permitzip/bim-mcp";
import { LOCAL_RUNS_WHERE, createLocalHost, startInMemoryModelServer, type LocalModelServer } from "@permitzip/bim-mcp/local";

const REPO_ROOT = resolve(__dirname, "../../..");
type Body = Record<string, unknown>;

function bodyOf(result: unknown): Body {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
  return text.trimStart().startsWith("{") ? (JSON.parse(text) as Body) : { message: text };
}

/** Levels L1 and L2, as the reference's examples name them. */
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

const elementsOf = (m: ModelState | undefined, kind: string): BimElement[] => Object.values(m?.elements ?? {}).filter((e) => e.kind === kind);

const KIT = 'import { defineScript, units, routes, parts, building, equipment, documents } from "@permitzip/bim-script";';

/** One script: build a rooftop unit's part type, save it into the model, place it on L1 and duct its supply and return. */
const ROOFTOP_UNIT = `${KIT}
export default defineScript({
  kind: "route",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    const rtu = parts.part("Rooftop unit", { type: "10 ton", category: "mechanical_equipment" });
    rtu.box({ length: units.in(120), width: units.in(60), height: units.in(48) });
    rtu.connector("bottom", { id: "supply", label: "Supply", domain: "duct", systemKind: "supply_air", shape: "rect", width: units.in(20), height: units.in(12), offset: [units.in(-30), units.in(0)] });
    rtu.connector("bottom", { id: "return", label: "Return", domain: "duct", systemKind: "return_air", shape: "rect", width: units.in(20), height: units.in(12), offset: [units.in(30), units.in(0)] });
    ctx.edit({ type: "save_part_types", label: "Rooftop unit, 10 ton", types: [{ typeId: "acme.rtu.10t", definition: rtu.build() }] });
    const unit = equipment.place(ctx, { level: "L1", type: "acme.rtu.10t", at: { x: units.ft(20), y: units.ft(20) }, height: units.ft(10), mark: "RTU-1" });
    routes.along(ctx, { level: "L1", domain: "duct", size: routes.rect(units.in(20), units.in(12)), system: { id: "sa-1", kind: "supply_air" }, height: units.ft(8), from: unit.connector("supply"), points: [{ x: units.ft(10), y: units.ft(5) }] });
    routes.along(ctx, { level: "L1", domain: "duct", size: routes.rect(units.in(20), units.in(12)), system: { id: "ra-1", kind: "return_air" }, height: units.ft(8), from: unit.connector("return"), points: [{ x: units.ft(40), y: units.ft(5) }] });
    ctx.label("RTU-1 with its supply and return ducts");
  },
});
`;

describe("core-only-tasks: an agent with only the core tools does each job with one script", () => {
  let models: LocalModelServer;
  let client: Client;
  let n = 0;

  beforeAll(async () => {
    installFirstPartyAddOns();
    models = startInMemoryModelServer();
    const host = createLocalHost({ server: models, repoRoot: REPO_ROOT, approve: "auto" });
    const server = createBimToolServer({ host, schemas: LOCAL_SCHEMAS, runsWhere: LOCAL_RUNS_WHERE });
    client = new Client({ name: "core-only", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
  });
  afterAll(async () => {
    await client.close();
    await models.close();
  });

  /** Seeds a fresh model, runs the script (preview), applies it, and returns the model after. */
  async function apply(source: string): Promise<ModelState | undefined> {
    const modelId = `task-${++n}`;
    await models.seed(twoLevels(modelId));
    const call = async (name: string, args: Body) => bodyOf(await client.callTool({ name, arguments: args }));
    const preview = await call("bim_run_script", { model_id: modelId, script: { source, reads: { levels: true } } });
    if (preview.status !== "previewed") throw new Error(JSON.stringify(preview).slice(0, 800));
    expect(preview).toMatchObject({ status: "previewed", kind: "edits" });
    const applied = await call("bim_apply_output", (preview.apply_with as { args: Body }).args);
    expect(applied).toMatchObject({ status: "saved" });
    return (await models.head(modelId)) ?? undefined;
  }

  it("only the core tools are on the server", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...CORE_TOOLS]);
  });

  it("creates a sheet with a floor plan placed on it", async () => {
    const m = await apply(recipe("Sheets per level"));
    const sheets = elementsOf(m, "sheet");
    expect(sheets.length).toBe(2);
    const plans = elementsOf(m, "view").filter((v) => "viewType" in v && v.viewType === "floor_plan");
    expect(plans.length).toBe(2);
    const viewports = Object.values(m?.elements ?? {}).filter((e) => e.kind === "viewport");
    expect(viewports.length).toBe(2);
  }, 120_000);

  it("makes a schedule with columns, on a schedule sheet", async () => {
    const m = await apply(recipe("Schedules"));
    const schedule = elementsOf(m, "view").find((v) => "viewType" in v && v.viewType === "schedule");
    const columns = schedule && "props" in schedule ? (schedule.props as { scheduleV2?: { columns: unknown[] } } | undefined)?.scheduleV2?.columns : undefined;
    expect(columns?.length).toBe(3);
    expect(elementsOf(m, "sheet")).toHaveLength(1);
  }, 120_000);

  it("finds a room from the walls around it", async () => {
    const m = await apply(recipe("Rooms from walls"));
    expect(elementsOf(m, "wall")).toHaveLength(4);
    const space = elementsOf(m, "space")[0];
    expect(space).toMatchObject({ number: "101", name: "Office" });
    // The outline came from the walls (a 30 ft x 20 ft room, inside the walls' faces), not from the script.
    const bounds = space && "bounds" in space ? (space.bounds as { kind: string; outline: { x: number; y: number }[]; boundary: { elementId: string }[] }) : null;
    expect(bounds?.kind).toBe("bounded");
    expect(new Set(bounds?.boundary.map((b) => b.elementId))).toEqual(new Set(elementsOf(m, "wall").map((w) => w.id)));
    const xs = (bounds?.outline ?? []).map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(9144 - 203.2, 0);
  }, 120_000);

  it("places a rooftop unit and routes its supply and return ducts to it", async () => {
    const m = await apply(ROOFTOP_UNIT);
    const unit = Object.values(m?.elements ?? {}).find((e) => "mark" in e && e.mark === "RTU-1");
    expect(unit).toBeDefined();
    const ducts = Object.values(m?.elements ?? {}).filter((e) => e.kind === "run_segment" && "domain" in e && e.domain === "duct");
    expect(ducts.length).toBeGreaterThanOrEqual(2);
    // Each duct run starts on one of the unit's connectors.
    // The supply duct starts on the unit's supply connector, the return duct on its return connector.
    const starts = ducts.map((d) => ("links" in d ? (d.links as { start?: { elementId: string; port: string } }).start : undefined)).filter((l) => l?.elementId === unit?.id);
    expect(starts.map((l) => l?.port).sort()).toEqual(["return", "supply"]);
  }, 120_000);

  it("routes a drain, sized by the plumbing code, that falls along its run", async () => {
    const m = await apply(recipe("Pipe routing"));
    const pipe = Object.values(m?.elements ?? {}).find((e) => e.kind === "run_segment" && "domain" in e && e.domain === "pipe") as unknown as { start: { z: number }; end: { z: number }; size: { nominalMm: number } } | undefined;
    // It falls 1/8 in per ft over 40 ft (127 mm), from start to end.
    expect((pipe?.start.z ?? 0) - (pipe?.end.z ?? 0)).toBeCloseTo(127, 0);
    // 4 in, the size the plumbing code calc gave for 88 DFU.
    expect(pipe?.size.nominalMm).toBeCloseTo(101.6, 1);
  }, 120_000);

  it("tags elements in a plan view", async () => {
    const m = await apply(recipe("Tags"));
    const tags = Object.values(m?.elements ?? {}).filter((e) => e.kind === "drawing_item" && "shape" in e && e.shape === "tag");
    expect(tags).toHaveLength(2);
    const walls = new Set<string>(elementsOf(m, "wall").map((w) => w.id));
    for (const t of tags) expect(walls.has(String((t as unknown as { tag: { elementId: string } }).tag.elementId))).toBe(true);
  }, 120_000);
});
