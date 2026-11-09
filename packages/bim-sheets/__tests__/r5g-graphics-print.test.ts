/**
 * @jest-environment node
 *
 * Round 5b f-graphics on paper (NEXT-BATCH §5): halftone electrical on an
 * E-101-like sheet prints halftone; plan symbols print as symbols, not as a
 * cut through the 3D body; and a sheet whose views carry no per-category
 * overrides prints byte for byte as it did, with or without the registry.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { MeshCache } from "@permitzip/bim-geometry";
import {
  DEFAULT_SETTINGS,
  TONE_GREY,
  buildSheetSceneFor,
  builtinPartType,
  commandSchema,
  planCommit,
  setPartMeshProvider,
  withUpgradePolicy,
  type ModelState,
  type PartTypeDefinition,
  type Primitive,
} from "@permitzip/bim-kernel";
import { CATEGORY_OVERRIDES_FEATURE, buildCategoryRegistry, withCategoryRegistry, type CategoryRegistry } from "@permitzip/bim-kernel";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import { renderSheetPdfWith } from "../src/pdf-core";

const FT = 304.8;
const NOW = () => "2026-10-29T00:00:00.000Z";
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = withUpgradePolicy(
    (f) => f === CATEGORY_OVERRIDES_FEATURE,
    () => planCommit(head, [], { idempotencyKey: `r5g-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, NOW),
  );
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

const crop = { min: { x: -12000, y: -8000 }, max: { x: 12000, y: 8000 } };

/** Level 1 power plan on E-101: a receptacle, a troffer and a fire alarm horn strobe. */
function e101(): ModelState {
  const receptacle = builtinPartType("builtin:gfci-receptacle@1");
  const troffer = builtinPartType("builtin:troffer-2x4-led@1");
  if (!receptacle || !troffer) throw new Error("starter electrical types missing");
  let m: ModelState = { modelId: "r5g", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "r1", typeId: "t-rec", partType: receptacle.definition, levelId: "lvl-1", position: { x: 0, y: 0 } });
  m = commit(m, { type: "place_part", partId: "f1", typeId: "t-tr", partType: troffer.definition, levelId: "lvl-1", position: { x: 3000, y: 2000 } });
  m = commit(m, { type: "place_part", partId: "fa1", typeId: "t-fa", partType: { ...receptacle.definition, familyName: "Fire alarm device", typeName: "Horn strobe" }, levelId: "lvl-1", position: { x: -3000, y: 1500 } });
  m = commit(m, { type: "create_view", viewId: "v-e101", name: "Level 1 Power", viewType: "floor_plan", crop, props: { level: "Level 1", scale: 48, discipline: "electrical" } });
  m = commit(m, { type: "create_sheet", sheetId: "s-e101", number: "E-101", name: "Power plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-e101", sheetId: "s-e101", viewId: "v-e101", center: { x: 400, y: 300 }, scale: 48 });
  return m;
}

async function pdfOf(m: ModelState, sheetId: string, categories?: CategoryRegistry): Promise<Uint8Array> {
  const build = () => buildSheetSceneFor(m, sheetId, { projectName: "7903 test" });
  const scene = categories ? withCategoryRegistry(categories, build) : build();
  return (await renderSheetPdfWith(scene, { title: sheetId, modelRevision: 1, snapshotSha256: "t", renderer: "t" }, null)).bytes;
}

/** Stroke colours set in the page content, as grey levels. */
async function strokeGreys(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  const out: number[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const text = new TextDecoder().decode(decodePDFRawStream(obj).decode());
    for (const m of text.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) RG/g)) out.push(Number(m[1]));
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const lines = (prims: readonly Primitive[]) => prims.filter((p): p is Extract<Primitive, { kind: "line" }> => p.kind === "line");

describe("r5g graphics on paper", () => {
  it("halftone electrical devices on E-101 prints them halftone (the old code printed them in ink)", async () => {
    const before = e101();
    const after = commit(before, { type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { electrical_devices: { halftone: true } } } });
    const halftone = TONE_GREY.halftone;
    const near = (g: number) => Math.abs(g - halftone) < 0.01;
    const greysBefore = (await strokeGreys(await pdfOf(before, "s-e101"))).filter(near).length;
    const greysAfter = (await strokeGreys(await pdfOf(after, "s-e101"))).filter(near).length;
    expect(greysAfter).toBeGreaterThan(greysBefore);
  });

  it("a sheet whose views set no overrides prints byte-identical, with the firm registry or without", async () => {
    const m = e101();
    const plain = await pdfOf(m, "s-e101");
    const reg = buildCategoryRegistry({ extraClasses: [{ id: "firm.fire_alarm_device", label: "Fire alarm device", parent: "mep.electrical_device" }] });
    expect(sameBytes(await pdfOf(m, "s-e101", reg), plain)).toBe(true);
    // Set, then cleared: the view stores nothing and the sheet prints as before.
    const set = commit(m, { type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: { lighting_fixtures: { visible: false } } } });
    expect(sameBytes(await pdfOf(set, "s-e101"), plain)).toBe(false);
    const cleared = commit(set, { type: "set_view_properties", viewId: "v-e101", props: { categoryOverrides: {} } });
    expect(sameBytes(await pdfOf(cleared, "s-e101"), plain)).toBe(true);
  });
});

describe("r5g plan symbols print as symbols", () => {
  beforeAll(async () => {
    setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
  });

  const RTU: PartTypeDefinition = JSON.parse(readFileSync(path.join(__dirname, "fixtures/cut-sheet-rtu.json"), "utf8"));

  function roof(): ModelState {
    let m: ModelState = { modelId: "r5g-roof", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "roof", name: "Roof", elevationMm: 14 * FT });
    m = commit(m, { type: "place_part", partId: "rtu-1", typeId: "type-rtu", partType: RTU, levelId: "roof", position: { x: 10 * FT, y: 10 * FT }, mark: "RTU-1", values: {} });
    m = commit(m, { type: "create_view", viewId: "v-roof", name: "Roof plan", viewType: "floor_plan", props: { level: "roof" } });
    m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Roof" });
    m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-roof", center: { x: 200, y: 250 }, scale: 48 });
    return m;
  }

  const sheetLines = (m: ModelState) => lines(buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives).length;
  const sheetTexts = (m: ModelState) => buildSheetSceneFor(m, "s-1", { projectName: "P" }).primitives.filter((p) => p.kind === "text" && p.text === "RTU").length;

  it("symbol on: the unit prints its plan symbol and no body lines; symbol off: its body and no symbol", () => {
    const both = roof();
    const symbol = commit(both, { type: "set_view_properties", viewId: "v-roof", props: { categoryOverrides: { equipment: { planSymbol: true } } } });
    const body = commit(both, { type: "set_view_properties", viewId: "v-roof", props: { categoryOverrides: { equipment: { planSymbol: false } } } });
    expect(sheetTexts(both)).toBe(1);
    expect(sheetTexts(symbol)).toBe(1);
    expect(sheetTexts(body)).toBe(0);
    expect(sheetLines(symbol)).toBeLessThan(sheetLines(both));
    expect(sheetLines(body)).toBe(sheetLines(both));
    // A class override reaches the same part through its class (mechanical equipment → Equipment).
    const byClass = commit(both, { type: "set_view_properties", viewId: "v-roof", props: { categoryOverrides: { "mep.mechanical_equipment": { planSymbol: true } } } });
    expect(sheetLines(byClass)).toBe(sheetLines(symbol));
  });
});
