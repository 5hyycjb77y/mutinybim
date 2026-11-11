/**
 * @jest-environment node
 *
 * The showcase scripts in packages/bim-script/examples never rot: each one
 * runs the way an agent runs it, through the core tools only
 * (bim_check_output → bim_run_script → bim_apply_output), against a fresh
 * empty model, with the real local script runner, and the model it leaves
 * has what the example says it builds. Every file in the folder is in the
 * catalogue the reference serves, and the catalogue's sources are the files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { danglingReferences, entityCounts, exportIfc, readStep, type StepToken } from "@permitzip/bim-ifc";
import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { KIT_EXAMPLES, KIT_EXAMPLE_SOURCES } from "@permitzip/bim-script";
import { runExample, type ExampleRun } from "../src/examples";

const REPO_ROOT = resolve(__dirname, "../../..");
const DIR = resolve(__dirname, "../../bim-script/examples");

const ofKind = (m: ModelState, kind: string): BimElement[] => Object.values(m.elements).filter((e) => e.kind === kind);
const field = <T>(e: BimElement | undefined, key: string): T | undefined => (e && key in e ? (e as unknown as Record<string, T>)[key] : undefined);

const run = (name: string): Promise<ExampleRun> => runExample(KIT_EXAMPLE_SOURCES[name] ?? "", { repoRoot: REPO_ROOT, modelId: name });

describe("examples: every showcase script runs through the core tools", () => {
  it("every file in the examples folder is in the catalogue, with its source", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, "")).sort();
    expect(KIT_EXAMPLES.map((x) => x.name).sort()).toEqual(files);
    // examples.generated.ts is stale: run `node packages/bim-script/scripts/write-examples.mjs`.
    for (const f of files) expect(KIT_EXAMPLE_SOURCES[f]).toBe(readFileSync(resolve(DIR, `${f}.ts`), "utf8"));
  });

  it("small-office: two floors of walls, doors, windows, rooms from the walls, and a plan sheet each", async () => {
    const { model: m, label } = await run("small-office");
    expect(ofKind(m, "level")).toHaveLength(2);
    expect(ofKind(m, "wall")).toHaveLength(12);
    expect(ofKind(m, "space").map((s) => field<string>(s, "name")).sort()).toEqual(["Conference", "Conference", "Office", "Office", "Open office", "Open office"]);
    for (const s of ofKind(m, "space")) expect(field<{ kind: string }>(s, "bounds")?.kind).toBe("bounded");
    const openings = ofKind(m, "opening");
    expect(openings.filter((o) => field<string>(o, "openingType") === "window")).toHaveLength(6);
    expect(openings.filter((o) => field<string>(o, "openingType") === "door")).toHaveLength(5);
    expect(ofKind(m, "sheet").map((s) => field<string>(s, "number")).sort()).toEqual(["A-101", "A-102"]);
    expect(ofKind(m, "viewport")).toHaveLength(2);
    expect(label).toMatch(/^Small office/);
  }, 120_000);

  it("small-office: IFC 4.3 preserves the storeys, typed walls and room identities", async () => {
    const { model } = await run("small-office");
    const { text } = exportIfc({
      model,
      project: { id: "small-office", name: "Small office", number: "001" },
      timeStamp: "2026-01-01T00:00:00Z",
    });
    const file = readStep(text);
    const entities = [...file.entities.values()];
    const stringValue = (arg: StepToken | undefined) => arg?.kind === "string" ? arg.value : undefined;

    expect(file.schemas).toEqual(["IFC4X3_ADD2"]);
    expect(danglingReferences(file)).toEqual([]);
    expect(entityCounts(file)).toMatchObject({ IFCBUILDINGSTOREY: 2, IFCWALL: 12, IFCSPACE: 6 });

    const storeys = entities.filter((entity) => entity.type === "IFCBUILDINGSTOREY");
    expect(storeys.map((storey) => stringValue(storey.args[2])).sort()).toEqual(["Level 1", "Level 2"]);

    const rooms = entities.filter((entity) => entity.type === "IFCSPACE");
    // IfcSpace uses Name for the room number and LongName for its display name.
    const identities = rooms.map((room) => [stringValue(room.args[2]), stringValue(room.args[7])]);
    expect(identities).toEqual(expect.arrayContaining([
      ["101", "Open office"], ["102", "Conference"], ["103", "Office"],
      ["201", "Open office"], ["202", "Conference"], ["203", "Office"],
    ]));
  }, 120_000);

  it("rooftop-unit: the unit on the roof, ducts sized from airflow down into the rooms, tagged, and scheduled", async () => {
    const { model: m, label } = await run("rooftop-unit");
    const unit = ofKind(m, "part").find((p) => field<string>(p, "mark") === "RTU-1");
    expect(unit).toBeDefined();
    const ducts = ofKind(m, "run_segment");
    // Supply and return each start on the unit's connector of the same name.
    const starts = ducts.map((d) => field<{ start?: { elementId: string; port: string } }>(d, "links")?.start).filter((l) => l?.elementId === unit?.id);
    expect(starts.map((l) => l?.port).sort()).toEqual(["return", "supply"]);
    // 4000 CFM at 12 in deep: wider than the 20 in a guess would give.
    for (const d of ducts) expect(field<{ width: number; height: number }>(d, "size")?.width ?? 0).toBeGreaterThan(20 * 25.4);
    const tags = ofKind(m, "drawing_item").filter((i) => field<string>(i, "shape") === "tag");
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(ofKind(m, "view").some((v) => field<string>(v, "viewType") === "schedule")).toBe(true);
    expect(ofKind(m, "sheet").map((s) => field<string>(s, "number")).sort()).toEqual(["M-101", "M-601"]);
    expect(label).toMatch(/^RTU-1 \(4000 CFM\) with \d+x12 supply and return ducts at \d+ fpm$/);
  }, 120_000);

  it("plumbing-riser: fixtures on two floors, a code-sized stack and sloped building drain, connected and tagged", async () => {
    const { model: m, label } = await run("plumbing-riser");
    expect(ofKind(m, "part").filter((p) => /plumbing-(wc|lavatory)/.test(String(field<string>(p, "typeId"))))).toHaveLength(8);
    const pipes = ofKind(m, "run_segment") as unknown as { start: { z: number }; end: { z: number }; size: { nominalMm: number } }[];
    // The building drain and branches fall.
    expect(pipes.some((p) => p.start.z - p.end.z > 100)).toBe(true);
    // Branch, stack and drain are the 3 in a water closet needs; the arms to each fixture are its own connection
    // size (3 in water closets, 1-1/4 in lavatories), so nothing else appears.
    const sizes = [...new Set(pipes.map((p) => Math.round(p.size.nominalMm * 100) / 100))].sort((a, b) => a - b);
    expect(sizes).toEqual([31.75, 76.2]);
    const tag = ofKind(m, "drawing_item").find((i) => field<string>(i, "shape") === "tag");
    expect(field<{ fields?: string[] }>(tag, "tag")?.fields).toEqual(["pipe.size", "pipe.slope", "pipe.carries.dfu"]);
    expect(label).toBe("Riser: 20 DFU, 3 in branches, 3 in stack, 3 in building drain at 1/4 in per ft, 9 gpm water demand");
  }, 120_000);

  it("electrical-room: receptacles by code spacing, a circuit per room, and the panel schedule on a sheet", async () => {
    const { model: m, label } = await run("electrical-room");
    const panel = ofKind(m, "part").find((p) => field<string>(p, "mark") === "LP-1");
    const receptacles = ofKind(m, "part").filter((p) => field<string>(p, "typeId") === "builtin:duplex-receptacle@1");
    expect(receptacles.length).toBeGreaterThanOrEqual(6);
    const circuits = ofKind(m, "service_link").filter((l) => field<{ elementId: string }>(l, "source")?.elementId === panel?.id);
    expect(circuits).toHaveLength(2);
    const schedule = ofKind(m, "view").find((v) => field<{ formSchedule?: { kind: string; elementId: string; rules?: string } }>(v, "props")?.formSchedule);
    const form = field<{ formSchedule: { kind: string; elementId: string; rules?: string } }>(schedule, "props")?.formSchedule;
    expect(form).toMatchObject({ kind: "panel", elementId: panel?.id });
    expect(form?.rules).toBeTruthy();
    expect(ofKind(m, "sheet").map((s) => field<string>(s, "number")).sort()).toEqual(["E-101", "E-601"]);
    expect(label).toMatch(/^\d+ receptacles \(meets NEC 210\.52\), 2 circuits on 1 unit\. LP-1 \d+ VA connected$/);
  }, 120_000);
});
