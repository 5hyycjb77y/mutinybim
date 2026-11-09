/**
 * @jest-environment node
 *
 * Sheet text drawn in the PDF's standard Helvetica (WinAnsi) must never fail
 * the print for a character that font can't encode (the reference building 7352, bug log #42:
 * a plan with an auto-sized 3/8" pipe tag failed `WinAnsi cannot encode "⅜"`).
 * The screen keeps "1⅜""; the PDF prints "1-3/8"" and says it substituted.
 */
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import type { Primitive, SheetScene } from "@permitzip/bim-kernel";
import { renderSheetPdfWith } from "../src/pdf-core";
import { winAnsiText } from "../src/text/win-ansi";

const META = { title: "P-101", modelRevision: 1, snapshotSha256: "0".repeat(64), renderer: "test" } as const;

function scene(texts: readonly string[]): SheetScene {
  const primitives: Primitive[] = texts.map((text, i) => ({ kind: "text", at: { x: 50, y: 50 + i * 10 }, text, size: 2.5, anchor: "start" }));
  return { paper: { x: 914.4, y: 609.6 }, revision: 1, primitives, tags: [], dimensions: [], details: [], schedule: [] };
}

/** The page's standard-font strings, decoded from their WinAnsi hex. */
async function pageStrings(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const refs = contents && "asArray" in contents ? contents.asArray() : contents ? [contents] : [];
  const out: string[] = [];
  for (const r of refs) {
    const stream = r instanceof PDFRawStream ? r : doc.context.lookup(r);
    if (!(stream instanceof PDFRawStream)) continue;
    const text = new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
    for (const m of text.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
      const hex = m[1] ?? "";
      out.push(String.fromCharCode(...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16))));
    }
  }
  expect(doc.getPage(0).node.Resources()?.lookup(PDFName.of("Font"))).toBeDefined();
  return out;
}

describe("standard-font text in a sheet PDF", () => {
  it("prints a 1⅜\" pipe tag as 1-3/8\" instead of failing the print, and reports the substitution", async () => {
    // Old code: renderSheetPdfWith threw `WinAnsi cannot encode "⅜" (0x215c)`.
    const pdf = await renderSheetPdfWith(scene(['1⅜" CW', '⅜" HW', '¾" CW', "1½\" G", "480V Δ − 208Y/120V"]), META, null);
    const strings = await pageStrings(pdf.bytes);
    expect(strings).toEqual(expect.arrayContaining(['1-3/8" CW', '3/8" HW']));
    // ¼ ½ ¾ are WinAnsi characters: they print as themselves (0xBE, 0xBD).
    expect(strings).toEqual(expect.arrayContaining(['\u00be" CW', '1\u00bd" G']));
    expect(strings).toContain("480V DELTA - 208Y/120V");
    expect(pdf.substitutedText).toEqual([
      { text: '1⅜" CW', printed: '1-3/8" CW' },
      { text: '⅜" HW', printed: '3/8" HW' },
      { text: "480V Δ − 208Y/120V", printed: "480V DELTA - 208Y/120V" },
    ]);
  });

  it("maps every vulgar fraction to ASCII, hyphenated after a whole number, and anything else unknown to ?", () => {
    const supported = new Set<number>([...Array.from({ length: 95 }, (_, i) => 0x20 + i), 0xbc, 0xbd, 0xbe]);
    expect(winAnsiText('2⅝"', supported)).toBe('2-5/8"');
    expect(winAnsiText("⅞ ⅛ ⅓ ⅔ ⅕", supported)).toBe("7/8 1/8 1/3 2/3 1/5");
    expect(winAnsiText("½ ¾", supported)).toBe("\u00bd \u00be");
    expect(winAnsiText("≤ 4 ≥ 2 → ok", supported)).toBe("<= 4 >= 2 -> ok");
    expect(winAnsiText("漢", supported)).toBe("?");
    expect(winAnsiText("plain", supported)).toBe("plain");
  });
});
