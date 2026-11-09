/**
 * @jest-environment node
 *
 * The printed PDF carries the linked model's hidden-line removal and its pens:
 * a sheet whose plan sits on the furniture fixture prints fewer lines when the
 * chair under the table is hidden, and the view's pen for the linked model's
 * lines below the cut is the width the PDF strokes them at.
 */
import * as WebIFC from "web-ifc";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { PEN_MM, buildSheetSceneFor, commandSchema, planCommit, type ModelState, type ReferenceDisplay, type ReferencePlan } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { cutIfcPlan } from "../src/ifc-plan";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { IDENTITY4 } from "../src/plan-geometry";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";
import { furnitureIfc } from "./fixtures/furniture-ifc";

const FT = 304.8;
const MM_TO_PT = 72 / 25.4;
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `hidden-pdf-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-22T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

async function pageContent(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const streams: PDFRawStream[] = contents instanceof PDFRawStream ? [contents] : [];
  if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const resolved = doc.context.lookup(ref);
      if (resolved instanceof PDFRawStream) streams.push(resolved);
    }
  }
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
}

const lineOps = (content: string) => (content.match(/\sl\s/g) ?? []).length;
const widths = (content: string) => [...content.matchAll(/([\d.]+) w\b/g)].map((m) => Number(m[1]));

describe("printed PDF of a plan on a linked model", () => {
  let api: WebIFC.IfcAPI;
  let modelId: number;
  const bytes = new TextEncoder().encode(furnitureIfc());
  const cut = (hiddenLines: boolean): ReferencePlan =>
    cutIfcPlan(api, modelId, { id: "arch", file: "furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY, hiddenLines }).plan;

  beforeAll(async () => {
    api = new WebIFC.IfcAPI();
    await api.Init();
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  });
  afterAll(() => api.CloseModel(modelId));

  function sheet(display?: ReferenceDisplay): ModelState {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", ...(display ? { references: { arch: display } } : {}) } });
    m = commit(m, { type: "set_view_crop", viewId: "v-plan", crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 32 * FT, y: 22 * FT } } });
    m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Mechanical plan" });
    m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 400, y: 300 }, scale: 48 });
    return m;
  }

  async function print(m: ModelState, plan: ReferencePlan): Promise<string> {
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "Hidden lines", backgrounds: { "v-plan": [{ plan, pen: "medium", tone: "ink", strokes: { cut: { pen: "wide", tone: "ink" }, projection: { pen: "thin", tone: "ink" } } }] } });
    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
    return pageContent(pdf.bytes);
  }

  it("prints fewer lines with the chair under the table hidden", async () => {
    const m = sheet();
    const hidden = await print(m, cut(true));
    const all = await print(m, cut(false));
    expect(lineOps(hidden)).toBeLessThan(lineOps(all));
  });

  it("strokes the linked model's lines below the cut with the view's pen", async () => {
    const heavyPt = PEN_MM.heavy * MM_TO_PT;
    const plain = await print(sheet(), cut(true));
    const heavy = await print(sheet({ visible: true, halftone: true, beyondPen: "heavy" }), cut(true));
    const near = (list: number[], v: number) => list.filter((w) => Math.abs(w - v) < 0.01).length;
    expect(near(widths(heavy), heavyPt)).toBeGreaterThan(near(widths(plain), heavyPt));
  });
});
