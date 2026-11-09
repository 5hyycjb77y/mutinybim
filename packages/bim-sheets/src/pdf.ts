import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SheetScene } from "@permitzip/bim-kernel";
import { renderSheetPdfWith, type NoteFontSource, type PdfMetadata, type PdfPrintOptions, type RenderedPdf, type SceneFontSource, type SheetImageSource } from "./pdf-core";

export { CODE_SLOT_KEYWORD, DetailHashMismatchError, NoteFontMismatchError, fetchSceneFonts, modelPrintOptions, renderSheetPdfWith, type DetailSource, type NoteFontSource, type PdfMetadata, type PdfPrintOptions, type RenderedPdf, type SceneFontSource, type SheetImageSource } from "./pdf-core";

/** Standalone: pictures are files under `dir`, the figure's file id a path inside it. */
export function fileImageSource(dir: string): SheetImageSource {
  const root = path.resolve(dir);
  return {
    load: async (fileId) => {
      const full = path.resolve(root, fileId);
      if (!full.startsWith(root + path.sep)) throw new Error(`${fileId} is outside the pictures folder`);
      return new Uint8Array(await readFile(full));
    },
  };
}

/** Firm-standard detail files shipped with this package. */
export const DETAILS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../details");
/** The note fonts (the browser loads copies from public/mutinybim/fonts). */
export const NOTE_FONTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fonts");

/** Note fonts read from a folder: this package's by default. Bundled servers pass the traced copy's path. */
export function nodeNoteFonts(dir: string = NOTE_FONTS_DIR): NoteFontSource {
  return { load: async (file) => new Uint8Array(await readFile(path.join(dir, path.basename(file)))) };
}

/** The served path every firm title block font lives under. */
export const FIRM_FONTS_URL_PREFIX = "/mutinybim/firm/";
/**
 * Where those fonts sit on a Node host: its `public` folder. Built from literal
 * segments so a bundler's file tracer ships this folder and nothing wider; a
 * folder passed in at run time makes it trace the whole checkout.
 */
export const FIRM_FONTS_DIR = path.join(process.cwd(), "public", "mutinybim", "firm");

/**
 * Scene fonts (a firm title block's faces) read from the host's served folder:
 * the path the title block names (`/mutinybim/firm/…/Jost-600.ttf`) under
 * `FIRM_FONTS_DIR`. Hosts that serve them elsewhere pass their own
 * `SceneFontSource` in the print options.
 */
export function nodeSceneFonts(): SceneFontSource {
  return {
    load: async (file) => {
      const served = path.posix.normalize(`/${file}`);
      if (!served.startsWith(FIRM_FONTS_URL_PREFIX)) throw new Error(`The title block font ${file} is outside the fonts folder`);
      const full = path.join(FIRM_FONTS_DIR, served.slice(FIRM_FONTS_URL_PREFIX.length));
      if (!full.startsWith(FIRM_FONTS_DIR + path.sep)) throw new Error(`The title block font ${file} is outside the fonts folder`);
      try {
        return new Uint8Array(await readFile(full));
      } catch (err) {
        throw new Error(`Couldn't read the title block font ${file}, so this sheet can't be printed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Vector PDF of a sheet scene, embedding placed standard details from this package's details folder. */
export function renderSheetPdf(scene: SheetScene, meta: PdfMetadata, noteFonts: NoteFontSource = nodeNoteFonts(), images: SheetImageSource | null = null, print: PdfPrintOptions = {}): Promise<RenderedPdf> {
  return renderSheetPdfWith(scene, meta, {
    load: (file) => readFile(path.join(DETAILS_DIR, path.basename(file))),
    sha256: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
  }, noteFonts, images, { sceneFonts: print.sceneFonts ?? nodeSceneFonts(), ...(print.monochrome ? { monochrome: true } : {}) });
}
