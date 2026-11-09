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
});
