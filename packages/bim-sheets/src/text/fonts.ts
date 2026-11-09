import { NOTE_FONT_FACES, NOTE_FONT_FILES, type NoteFace } from "@permitzip/bim-kernel";

/**
 * Where the note fonts come from. The same four files the layout engine was
 * measured from (`font-metrics.generated.ts` pins their sha256) are embedded
 * in every PDF and loaded by the browser, so print and screen share glyphs.
 *
 * Node reads them from this package's `fonts/` folder (`nodeNoteFonts` in
 * ../pdf); the browser fetches the copies served at NOTE_FONT_URL_BASE.
 */
export interface NoteFontSource {
  load(file: string): Promise<Uint8Array>;
}

/** Public path the host app serves the note fonts from (public/mutinybim/fonts). */
export const NOTE_FONT_URL_BASE = "/mutinybim/fonts/";

export class NoteFontMismatchError extends Error {
  constructor(readonly file: string, readonly expected: string, readonly actual: string) {
    super(`Note font ${file} is not the one the text layout was measured with (expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)}); refusing to print notes that would not match the screen`);
    this.name = "NoteFontMismatchError";
  }
}

export function noteFontFile(face: NoteFace): string {
  return NOTE_FONT_FILES[face];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A face's bytes, verified against the hash its metrics came from. */
export async function loadVerifiedFace(source: NoteFontSource, face: NoteFace): Promise<Uint8Array> {
  const file = noteFontFile(face);
  const bytes = await source.load(file);
  const actual = await sha256Hex(bytes);
  const expected = NOTE_FONT_FACES[face].sha256;
  if (actual !== expected) throw new NoteFontMismatchError(file, expected, actual);
  return bytes;
}

/** Fonts fetched over HTTP (the browser print path). */
export function fetchNoteFonts(base: string = NOTE_FONT_URL_BASE, fetchImpl: typeof fetch = fetch): NoteFontSource {
  return {
    async load(file) {
      const res = await fetchImpl(`${base}${file}`);
      if (!res.ok) throw new Error(`Couldn't load the note font ${file} (HTTP ${res.status}), so notes can't be printed`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
