/**
 * @jest-environment node
 *
 * The example building's L1 panel schedule on a sheet, printed through the
 * real PDF writer: the page content is a golden, and the live values (the
 * receptacle circuit's kVA, the NEC demand line) are on paper, not only on
 * screen. Loading this package registers the NEC editions the schedule names.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildSheetSceneFor, builtinFormTemplate } from "@permitzip/bim-kernel";
import "../src";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";
import { referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

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

async function printL1(load?: number): Promise<{ content: string; texts: string[] }> {
  const b = referenceBuilding();
  if (load !== undefined) b.ok({ type: "set_parameters", id: "off1-r1", scope: "instance", values: { load_va: load } });
  b.ok({ type: "create_sheet", sheetId: "e-601", number: "E-601", name: "Panel schedules" });
  b.ok({ type: "create_view", viewId: "v-l1", name: "Panel L1", viewType: "schedule", props: { formSchedule: { kind: "panel", elementId: "l1", template: builtinFormTemplate("panel"), rules: "nec-2023" } } });
  b.ok({ type: "place_viewport", viewportId: "vp-l1", sheetId: "e-601", viewId: "v-l1", center: { x: 300, y: 250 } });
  const scene = buildSheetSceneFor(b.head, "e-601", { projectName: "Example building" });
  const pdf = await renderSheetPdfWith(scene, { title: "E-601", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
  return { content: await pageContent(pdf.bytes), texts: scene.primitives.flatMap((p) => (p.kind === "text" ? [p.text] : [])) };
}

describe("panel schedule printed to PDF", () => {
  it("prints the golden page", async () => {
    const { content, texts } = await printL1();
    expect(texts).toEqual(expect.arrayContaining(["PANEL L1", "0.54", "SPACE", "Demand: NEC 2023 Article 220", "12.24 kVA   34 A"]));
    expect(content).toMatchSnapshot();
  });

  it("a changed load reaches the printed page", async () => {
    const before = await printL1();
    const after = await printL1(360);
    expect(after.content).not.toBe(before.content);
    expect(after.texts).toContain("0.72");
    expect(after.texts).toContain("12.42 kVA   34 A");
  });
});
