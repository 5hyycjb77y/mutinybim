/**
 * @jest-environment node
 *
 * Groups and phases on paper: a view's phase filter and group settings reach
 * the printed PDF, not only the screen.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { PHASE_DASH, buildSheetSceneFor, commandSchema, planCommit, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";

const MM_TO_PT = 72 / 25.4;
const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `org-pdf-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-10-20T00:00:00.000Z");
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

function sheet(filter: string | null, groupDisplay?: Record<string, "show" | "halftone" | "hide">): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "set_element_phases", ids: ["seg-trunk"], phaseCreated: "phase-existing", phaseDemolished: "phase-new" });
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Demolition", viewType: "floor_plan", props: { level: "L1", detailLevel: "coarse", visualStyle: "wireframe", ...(filter ? { phaseFilterId: filter } : {}), ...(groupDisplay ? { groupDisplay } : {}) } });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "MD-101", name: "Mechanical demolition" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-plan", center: { x: 400, y: 300 }, scale: 48 });
  return m;
}

async function print(m: ModelState): Promise<string> {
  const scene = buildSheetSceneFor(m, "s-1", { projectName: "Groups and phases" });
  const pdf = await renderSheetPdfWith(scene, { title: "MD-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
  return pageContent(pdf.bytes);
}

const lead = (n: number) => String(n * MM_TO_PT).slice(0, 5).replace(".", "\\.");
const dashOperator = new RegExp(`\\[${lead(PHASE_DASH[0] ?? 0)}\\d* ${lead(PHASE_DASH[1] ?? 0)}\\d*\\] 0 d`);

describe("printed PDF follows groups and phases", () => {
  it("a demolished duct prints dashed in 'Show existing + demo'", async () => {
    const content = await print(sheet("pf-existing-demo"));
    expect(content).toMatch(dashOperator);
  });

  it("with 'Show complete' the demolished duct is gone from the sheet, so nothing prints dashed", async () => {
    const content = await print(sheet("pf-complete"));
    expect(content).not.toMatch(dashOperator);
  });

  it("hiding a group in the view removes its linework from the PDF", async () => {
    const shown = await print(sheet(null));
    const hidden = await print(sheet(null, { "grp-general": "hide" }));
    const strokes = (s: string) => (s.match(/ l\s/g) ?? []).length;
    expect(strokes(hidden)).toBeLessThan(strokes(shown));
  });
});
