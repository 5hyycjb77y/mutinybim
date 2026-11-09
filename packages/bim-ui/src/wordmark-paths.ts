/**
 * MUTINY wordmark, drawn as plain slab geometry (no font outlines, so no font
 * license applies). Cap height 100 units; letters advance by width + 6.
 * `assets/mutiny-wordmark.svg` must equal `wordmarkSvg()` (enforced by the package tests).
 */
export const WORDMARK_LETTERS: readonly { readonly char: string; readonly width: number; readonly d: string }[] = [
  { char: "M", width: 120, d: "M0 0H34L60 52L86 0H120V9H113V91H120V100H82V91H89V40L67 82H53L31 40V91H38V100H0V91H7V9H0Z" },
  { char: "U", width: 104, d: "M0 0H38V9H31V66A21 14 0 0 0 73 66V9H66V0H104V9H97V64A45 36 0 0 1 7 64V9H0Z" },
  { char: "T", width: 100, d: "M0 0H100V34H90V24H62V91H70V100H30V91H38V24H10V34H0Z" },
  { char: "I", width: 44, d: "M0 0H44V9H34V91H44V100H0V91H10V9H0Z" },
  { char: "N", width: 112, d: "M0 0H34L81 62V9H74V0H112V9H105V100H84L31 30V91H38V100H0V91H7V9H0Z" },
  { char: "Y", width: 112, d: "M0 0H40V9H33L56 48L79 9H72V0H112V9H105L68 60V91H76V100H36V91H44V60L7 9H0Z" },
];

export const WORDMARK_GAP = 6;

export function wordmarkLayout(): { readonly width: number; readonly glyphs: readonly { readonly x: number; readonly d: string; readonly char: string }[] } {
  let x = 0;
  const glyphs = WORDMARK_LETTERS.map((l) => {
    const glyph = { x, d: l.d, char: l.char };
    x += l.width + WORDMARK_GAP;
    return glyph;
  });
  return { width: x - WORDMARK_GAP, glyphs };
}

/** The standalone SVG file contents (`currentColor` fill). */
export function wordmarkSvg(): string {
  const { width, glyphs } = wordmarkLayout();
  const paths = glyphs.map((g) => `<path transform="translate(${g.x} 0)" d="${g.d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 100" role="img" aria-label="MUTINY"><title>MUTINY</title><g fill="currentColor">${paths}</g></svg>\n`;
}
