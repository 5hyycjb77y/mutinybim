/**
 * @jest-environment node
 *
 * A linked architect's plan on a printed sheet follows the view's linked-model
 * display: halftone by default, screened lighter as an underlay, in ink when
 * set to normal, gone when hidden. Our ductwork always prints in ink.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { TONE_GREY, buildSheetSceneFor, commandSchema, planCommit, referencePresetDisplay, type ModelState, type ReferenceDisplay, type ReferencePlan } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `linked-pdf-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-21T00:00:00.000Z");
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

const plan: ReferencePlan = {
  id: "arch",
  source: { file: "arch.ifc", sha256: "0".repeat(64) },
  level: { name: "LEVEL 1", elevationMm: 0 },
  cutHeightMm: 1200,
  bounds: { min: { x: -100_000, y: -100_000 }, max: { x: 100_000, y: 100_000 } },
  layers: [{ id: "w", discipline: "architecture", kind: "cut", category: "IFCWALL", segments: [0, 2000, 10000, 2000, 0, 6000, 10000, 6000] }],
  labels: [],
};

function sheet(display?: ReferenceDisplay): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", ...(display ? { references: { arch: display } } : {}) } });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Mechanical plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 400, y: 300 }, scale: 48 });
  return m;
}

async function print(m: ModelState): Promise<string> {
  const scene = buildSheetSceneFor(m, "s-1", { projectName: "Linked display", backgrounds: { "v-plan": [{ plan, pen: "medium", tone: "ink" }] } });
  const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
  return pageContent(pdf.bytes);
}

const stroke = (grey: number) => `${grey} ${grey} ${grey} RG`;

describe("printed PDF follows the view's linked model display", () => {
  it("prints the architect's plan halftone by default while ducts stay in ink", async () => {
    const content = await print(sheet());
    expect(content).toContain(stroke(TONE_GREY.halftone));
    expect(content).toContain("0 0 0 RG");
  });

  it("an underlay prints screened, lighter than halftone", async () => {
    const content = await print(sheet(referencePresetDisplay("underlay")));
    expect(content).toContain(stroke(TONE_GREY.screened));
    expect(content).not.toContain(stroke(TONE_GREY.halftone));
  });

  it("normal prints it in ink; hidden leaves it off the sheet", async () => {
    expect(await print(sheet(referencePresetDisplay("normal")))).not.toContain(stroke(TONE_GREY.halftone));
    const hidden = await print(sheet(referencePresetDisplay("hidden")));
    const normal = await print(sheet(referencePresetDisplay("normal")));
    expect(hidden.length).toBeLessThan(normal.length);
  });
});
