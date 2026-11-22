/**
 * @jest-environment node
 *
 * Title block fonts are read from one fixed folder, `public/mutinybim/firm`.
 * A folder chosen at run time made Next's file tracer ship the whole checkout
 * with every function that prints a sheet (main, Nov 2026), and the loader must
 * never hand back a file outside that folder.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIRM_FONTS_DIR, nodeSceneFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";
import type { SheetScene } from "@permitzip/bim-kernel";

const JOST = "/mutinybim/firm/permitzip/fonts/Jost-Bold.ttf";

describe("nodeSceneFonts", () => {
  it("reads the firm fonts from public/mutinybim/firm under the server's folder", async () => {
    expect(FIRM_FONTS_DIR).toBe(path.join(process.cwd(), "public", "mutinybim", "firm"));
    const bytes = await nodeSceneFonts().load(JOST);
    expect(Buffer.from(bytes).equals(readFileSync(path.join(process.cwd(), "public", JOST)))).toBe(true);
  });

  it("accepts the served path without its leading slash", async () => {
    const bytes = await nodeSceneFonts().load(JOST.slice(1));
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it.each([
    ["another public file", "/push-sw.js"],
    ["the note fonts beside the firm folder", "/mutinybim/fonts/x.ttf"],
    ["a climb out of the firm folder", "/mutinybim/firm/../../push-sw.js"],
    ["a climb out of the checkout", "/mutinybim/firm/../../../../package.json"],
    ["the firm folder itself", "/mutinybim/firm/"],
  ])("refuses %s", async (_label, file) => {
    await expect(nodeSceneFonts().load(file)).rejects.toThrow(/outside the fonts folder/);
  });

  it("names the font when the file is missing", async () => {
    await expect(nodeSceneFonts().load("/mutinybim/firm/permitzip/fonts/Nope.ttf")).rejects.toThrow(/Couldn't read the title block font \/mutinybim\/firm\/permitzip\/fonts\/Nope\.ttf/);
  });

  it("embeds matching standard PDF faces for Text Type fontFamily and italic while leaving default PDFs Helvetica-only", async () => {
    const baseScene = (primitives: SheetScene["primitives"]): SheetScene => ({
      paper: { x: 279.4, y: 215.9 },
      revision: 1,
      primitives,
      details: [],
      tags: [],
      dimensions: [],
      schedule: [],
    });
    const meta = { title: "Fonts", modelRevision: 1, snapshotSha256: "0".repeat(64), renderer: "test" };

    const plain = await renderSheetPdfWith(
      baseScene([{ kind: "text", at: { x: 20, y: 20 }, text: "PLAIN", size: 2.5, anchor: "start" }]),
      meta,
      null,
    );
    const plainAscii = Buffer.from(plain.bytes).toString("latin1");
    expect(plainAscii).toContain("/BaseFont /Helvetica");
    expect(plainAscii).not.toContain("/BaseFont /Courier");
    expect(plainAscii).not.toContain("/BaseFont /Times");
    expect(plainAscii).not.toContain("Oblique");

    const styled = await renderSheetPdfWith(
      baseScene([
        { kind: "text", at: { x: 20, y: 20 }, text: "MONO ITALIC", size: 2.5, anchor: "start", fontFamily: "Courier New, monospace", italic: true, mask: true },
        { kind: "text", at: { x: 20, y: 35 }, text: "SERIF BOLD", size: 2.5, anchor: "start", fontFamily: "Times New Roman, serif", bold: true },
        { kind: "text", at: { x: 20, y: 50 }, text: "SANS ITALIC", size: 2.5, anchor: "start", italic: true },
      ]),
      meta,
      null,
    );
    const styledAscii = Buffer.from(styled.bytes).toString("latin1");
    expect(styledAscii).toContain("/BaseFont /Courier-Oblique");
    expect(styledAscii).toContain("/BaseFont /Times-Bold");
    expect(styledAscii).toContain("/BaseFont /Helvetica-Oblique");
  });
});
