import type { DrawingItem } from "../documents";
import type { Vec2 } from "../types";
import { DEFAULT_NOTE_SIZE_MM, NOTE_LIMITS, paragraphsFromPlain, type NoteParagraph, type RichTextNote } from "./rich-text";
import { layoutNote, pieceCharX, type NoteLayout } from "./text-layout";
import { leaderPrims } from "./annotations";

/**
 * A note as it draws: its box's top-left on paper, rotation, and laid-out
 * lines. Sheet scenes carry these (`SheetScene.textBlocks`) beside their line
 * primitives; the SVG writer here and the PDF writer in @permitzip/bim-sheets
 * both draw them from the same layout.
 */
export interface TextBlock {
  readonly itemId: string;
  /** Box top-left, paper mm. */
  readonly origin: Vec2;
  /** Degrees, clockwise on paper, about `origin`. */
  readonly rotation: number;
  readonly layout: NoteLayout;
}

/** What a note item prints: its rich content, or a one-line note written before notes were rich, as an unwrapped box. */
export interface ResolvedNote {
  readonly note: RichTextNote;
  readonly size: number;
  /** The item's point in the owner's coordinates. */
  readonly anchor: Vec2;
  /**
   * Paper mm from the anchor up to the box's top. Zero for rich notes (the
   * point is the top-left); a one-line note's point was its baseline.
   */
  readonly liftMm: number;
}

/** Content, box and anchor of a note item; null for other drawing items. */
export function resolveNote(item: DrawingItem): ResolvedNote | null {
  if (item.shape !== "text") return null;
  const at = item.points[0];
  if (!at) return null;
  const size = item.textSize ?? DEFAULT_NOTE_SIZE_MM;
  if (item.note) return { note: item.note, size, anchor: at, liftMm: 0 };
  // Written before notes were rich: one unwrapped line, as wide as its text, its baseline where it always was.
  const paragraphs = paragraphsFromPlain(item.text ?? "");
  const wide = layoutNote(paragraphs, { width: NOTE_LIMITS.maxWidthMm, height: null, size });
  const width = Math.max(NOTE_LIMITS.minWidthMm, Math.ceil(Math.max(...wide.lines.map((l) => l.right), 0) * 100) / 100 + 0.5);
  return {
    note: { space: "paper", box: { width, height: null, rotation: 0 }, paragraphs, lineSpacing: 1 },
    size,
    anchor: at,
    liftMm: wide.lines[0]?.baseline ?? 0,
  };
}

/** The note's box origin on paper, given how the owner's coordinates reach paper. */
export function noteOrigin(resolved: ResolvedNote, toPaper: (p: Vec2) => Vec2): Vec2 {
  const p = toPaper(resolved.anchor);
  return { x: p.x, y: p.y - resolved.liftMm };
}

/** A note item as it draws on paper; null for other drawing items. */
export function textBlockFor(item: DrawingItem, toPaper: (p: Vec2) => Vec2): TextBlock | null {
  const resolved = resolveNote(item);
  if (!resolved) return null;
  return { itemId: item.id, origin: noteOrigin(resolved, toPaper), rotation: resolved.note.box.rotation, layout: layoutResolved(resolved) };
}

/** Lay out a note's content in its box. */
export function layoutResolved(resolved: Pick<ResolvedNote, "note" | "size">): NoteLayout {
  return layoutNote(resolved.note.paragraphs, { width: resolved.note.box.width, height: resolved.note.box.height, size: resolved.size, lineSpacing: resolved.note.lineSpacing });
}

/** Lay out content the editor is drafting (nothing saved yet). */
export function layoutDraft(paragraphs: readonly NoteParagraph[], note: Pick<RichTextNote, "box" | "lineSpacing">, size: number): NoteLayout {
  return layoutNote(paragraphs, { width: note.box.width, height: note.box.height, size, lineSpacing: note.lineSpacing });
}

function rotate(p: Vec2, deg: number): Vec2 {
  if (deg === 0) return p;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** A point in the box's own frame (mm right and down from its top-left) on paper. */
export function boxToPaper(block: Pick<TextBlock, "origin" | "rotation">, local: Vec2): Vec2 {
  const r = rotate(local, block.rotation);
  return { x: block.origin.x + r.x, y: block.origin.y + r.y };
}

/** A paper point in the box's own frame. */
export function paperToBox(block: Pick<TextBlock, "origin" | "rotation">, paper: Vec2): Vec2 {
  return rotate({ x: paper.x - block.origin.x, y: paper.y - block.origin.y }, -block.rotation);
}

/** The box's four corners on paper: top-left, top-right, bottom-right, bottom-left. */
export function textBlockCorners(block: TextBlock): [Vec2, Vec2, Vec2, Vec2] {
  const { width, height } = block.layout;
  return [boxToPaper(block, { x: 0, y: 0 }), boxToPaper(block, { x: width, y: 0 }), boxToPaper(block, { x: width, y: height }), boxToPaper(block, { x: 0, y: height })];
}

/** Where a leader leaves the box: the middle of the first line, on the side nearer `toward`. */
export function leaderStart(block: TextBlock, toward: Vec2): Vec2 {
  const firstMid = block.layout.lines[0] ? block.layout.lines[0].top + block.layout.lines[0].height / 2 : block.layout.height / 2;
  const local = paperToBox(block, toward);
  return boxToPaper(block, { x: local.x < block.layout.width / 2 ? 0 : block.layout.width, y: firstMid });
}

/** Leader from the nearer side of the box (middle of its first line) to `to` on paper, with an open arrowhead. */
export function leaderSegments(block: TextBlock, to: Vec2): Array<[Vec2, Vec2]> {
  const firstMid = block.layout.lines[0] ? block.layout.lines[0].top + block.layout.lines[0].height / 2 : block.layout.height / 2;
  const local = paperToBox(block, to);
  const from = boxToPaper(block, { x: local.x < block.layout.width / 2 ? 0 : block.layout.width, y: firstMid });
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.min(2.5, len / 3);
  const wing = (sign: number): Vec2 => ({ x: to.x - head * ux + sign * head * 0.35 * -uy, y: to.y - head * uy + sign * head * 0.35 * ux });
  return [
    [from, to],
    [to, wing(1)],
    [to, wing(-1)],
  ];
}

/** A detail-view note's box corners in model mm at the view's `scale` (model y runs up the paper), plus its leader's target. */
export function noteCornersInModel(item: DrawingItem, scale: number): Vec2[] {
  const resolved = resolveNote(item);
  if (!resolved) return [];
  const block: TextBlock = { itemId: item.id, origin: { x: 0, y: -resolved.liftMm }, rotation: resolved.note.box.rotation, layout: layoutResolved(resolved) };
  const leader = [...(resolved.note.leader ? [resolved.note.leader] : []), ...(resolved.note.leaders ?? [])].flatMap((l) => (l.elbow ? [l.to, l.elbow] : [l.to]));
  return [...textBlockCorners(block).map((c) => ({ x: resolved.anchor.x + c.x * scale, y: resolved.anchor.y - c.y * scale })), ...leader];
}

/**
 * A note item drawn on paper: its block and leader linework, or null when it
 * isn't a note or (with `fits`) its box would print past where notes may go.
 */
export function noteDrawing(item: DrawingItem, toPaper: (p: Vec2) => Vec2, fits?: (corners: readonly Vec2[]) => boolean): { block: TextBlock; leader: Array<[Vec2, Vec2]> } | null {
  const block = textBlockFor(item, toPaper);
  if (!block) return null;
  if (fits && !fits(textBlockCorners(block))) return null;
  const all = [...(item.note?.leader ? [item.note.leader] : []), ...(item.note?.leaders ?? [])];
  const leader: Array<[Vec2, Vec2]> = [];
  for (const l of all) {
    const to = toPaper(l.to);
    const elbow = l.elbow ? toPaper(l.elbow) : undefined;
    leader.push(...(elbow || l.arrow ? leaderPrims(leaderStart(block, elbow ?? to), to, elbow, l.arrow) : leaderSegments(block, to)));
  }
  return { block, leader };
}

/** SVG font family names the browser loads from the same files the PDF embeds (see `noteFontFaceCss`). */
export const NOTE_SVG_FONT_FAMILY = "MutinyBIM Notes";
const FACE_ATTRS: Record<string, string> = {
  regular: "",
  bold: ' font-weight="bold"',
  italic: ' font-style="italic"',
  boldItalic: ' font-weight="bold" font-style="italic"',
};

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/**
 * One note as SVG in paper mm. Every glyph is placed at the x the layout
 * computed, with kerning and ligatures off, so the browser's own text shaping
 * can't move a character away from where the PDF prints it. Spaces go out as
 * no-break spaces: SVG whitespace handling drops or merges ordinary ones,
 * which would shift every following glyph onto its neighbour's x.
 */
export function textBlockToSvg(block: TextBlock, attrs = ""): string {
  const parts: string[] = [];
  const transform = `translate(${n(block.origin.x)} ${n(block.origin.y)})${block.rotation ? ` rotate(${n(block.rotation)})` : ""}`;
  parts.push(`<g transform="${transform}" data-note-id="${esc(block.itemId)}" font-family="'${NOTE_SVG_FONT_FAMILY}', 'Liberation Sans', Arimo, Arial, sans-serif" style="font-kerning:none;font-variant-ligatures:none;font-feature-settings:'kern' 0,'liga' 0;white-space:pre" xml:space="preserve"${attrs}>`);
  for (const line of block.layout.lines) {
    for (const p of line.pieces) {
      if (p.text.trim().length === 0) continue;
      const xs = pieceCharX(p).map(n).join(" ");
      parts.push(`<text x="${xs}" y="${n(p.baseline)}" font-size="${n(p.em)}"${FACE_ATTRS[p.face] ?? ""}${p.color ? ` fill="${p.color}"` : ""}>${esc(p.text.replace(/ /g, "\u00a0"))}</text>`);
    }
    for (const u of line.underlines) {
      parts.push(`<rect x="${n(u.x0)}" y="${n(u.y)}" width="${n(u.x1 - u.x0)}" height="${n(u.thickness)}"${u.color ? ` fill="${u.color}"` : ""}/>`);
    }
  }
  parts.push("</g>");
  return parts.join("");
}
