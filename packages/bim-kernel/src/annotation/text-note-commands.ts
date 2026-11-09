import { z } from "zod";
import { canonicalJson } from "../canonical";
import type { AuthoredWrite } from "../commands";
import { DEFAULT_DETAIL_SCALE, DEFAULT_PLAN_SCALE, sheetPaperSize, type DrawingItem } from "../documents";
import { round, roundVec } from "../geometry";
import { KernelError, type TrackedReader } from "../model";
import { asElementId, type BimElement, type ElementId, type ModelState, type Vec2 } from "../types";
import {
  DEFAULT_NOTE_SIZE_MM,
  NOTE_LIMITS,
  lineSpacingSchema,
  noteContentProblem,
  noteLabel,
  noteLeaderSchema,
  noteParagraphsSchema,
  normalizeParagraphs,
  type NoteLeader,
  type NoteParagraph,
  type RichTextNote,
} from "./rich-text";
import { resolveNote } from "./text-note";

/**
 * Commands for rich text notes on a sheet (paper mm) or in a detail view
 * (model mm). They run inside the views/sheets executor, so they are validated
 * against the head, idempotent by request key, attributed, and undone with
 * `restore_document_elements` like every other drawing item.
 *
 * `edit_text_note` replaces the whole content at once and names the content
 * the editor started from (`noteContentFingerprint`): if anyone saved
 * different words since, it is refused rather than overwriting them. A
 * fingerprint rather than an element version, because local predictions don't
 * bump versions: your own back-to-back edits chain (each names what the last
 * one wrote), and someone else moving or resizing the box meanwhile merges.
 */

const id = z.string().min(1).max(200);
const vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
const width = z.number().finite().min(NOTE_LIMITS.minWidthMm).max(NOTE_LIMITS.maxWidthMm);
const height = z.number().finite().min(NOTE_LIMITS.minHeightMm).max(NOTE_LIMITS.maxHeightMm).nullable();
const rotation = z.number().finite().min(-360).max(360);
const size = z.number().finite().min(NOTE_LIMITS.minSizeMm).max(NOTE_LIMITS.maxSizeMm);

export const textNoteCommandSchemas = [
  z.object({
    type: z.literal("create_text_note"),
    itemId: id,
    /** A sheet, or a detail view. */
    ownerId: id,
    /** Box top-left: paper mm on a sheet, model mm in a detail view. */
    at: vec2,
    /** Box width, paper mm (text wraps at it). */
    width,
    /** Fixed box height in paper mm; null or absent grows with the text. */
    height: height.optional(),
    rotation: rotation.optional(),
    /** Cap height, paper mm, for text without its own size. */
    textSize: size.optional(),
    lineSpacing: lineSpacingSchema.optional(),
    paragraphs: noteParagraphsSchema,
    /** Leader arrow target in the owner's coordinates. */
    leader: vec2.nullable().optional(),
    /** Every leader (straight or with an elbow, any arrowhead); replaces `leader` when given. */
    leaders: z.array(noteLeaderSchema).max(9).optional(),
  }),
  z.object({
    type: z.literal("edit_text_note"),
    itemId: id,
    /** `noteContentFingerprint` of the note when editing started; refused if its words changed since. */
    expectedContent: z.string().min(1).max(64),
    paragraphs: noteParagraphsSchema,
    textSize: size.optional(),
    lineSpacing: lineSpacingSchema.optional(),
  }),
  z.object({
    type: z.literal("resize_text_note"),
    itemId: id,
    width,
    /** null: grow with the text. Absent: keep. */
    height: height.optional(),
    /** New top-left, when dragging the left or top edge moves it. */
    at: vec2.optional(),
  }),
  z.object({
    type: z.literal("move_text_note"),
    itemId: id,
    at: vec2.optional(),
    rotation: rotation.optional(),
    /** null removes the leader. */
    leader: vec2.nullable().optional(),
    /** Replace every leader (an empty list removes them all). */
    leaders: z.array(noteLeaderSchema).max(9).optional(),
  }),
  z.object({ type: z.literal("delete_text_note"), itemId: id }),
] as const;

export type TextNoteCommand = z.infer<(typeof textNoteCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(textNoteCommandSchemas.map((s) => s.shape.type.value));

export function isTextNoteCommand(command: { readonly type: string }): command is TextNoteCommand {
  return TYPES.has(command.type);
}

/** Conflict-check field names; see `noteFieldValue`. */
export const NOTE_FIELDS = { content: "doc.note", box: "doc.noteBox", points: "doc.points", deleted: "doc.deleted" } as const;

/** 32-bit FNV-1a, twice with different offsets: a short, stable fingerprint (not a security hash). */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** What a note says (paragraphs, or a one-line note's text, plus its default size and line spacing), as a short fingerprint. */
export function noteContentFingerprint(el: DrawingItem): string {
  return fingerprint(noteFieldValue(el, NOTE_FIELDS.content) ?? "");
}

/** Fingerprint of content as it will be stored after `edit_text_note` (normalized), so a follow-up edit can name it. */
export function draftContentFingerprint(item: DrawingItem, paragraphs: readonly NoteParagraph[], textSize?: number, lineSpacing?: number): string {
  const after: DrawingItem = { ...item, textSize: textSize ?? item.textSize ?? DEFAULT_NOTE_SIZE_MM, note: { ...(item.note ?? { space: "paper", box: { width: 10, height: null, rotation: 0 }, lineSpacing: 1 }), paragraphs: normalizeParagraphs(paragraphs), lineSpacing: lineSpacing ?? item.note?.lineSpacing ?? 1 } };
  const { text: _plain, ...rest } = after;
  return noteContentFingerprint(rest);
}

/** Value of a note field for the commit's competing-edit check, or undefined if the field isn't a note field. */
export function noteFieldValue(el: DrawingItem, field: string): string | undefined {
  if (field === NOTE_FIELDS.content) return canonicalJson({ paragraphs: el.note?.paragraphs ?? null, text: el.text ?? null, textSize: el.textSize ?? null, lineSpacing: el.note?.lineSpacing ?? null });
  if (field === NOTE_FIELDS.box) return canonicalJson({ box: el.note?.box ?? null, leader: el.note?.leader ?? null });
  return undefined;
}

export interface NoteCommandContext {
  readonly model: ModelState;
  readonly reader: TrackedReader;
  readonly write: (el: BimElement) => void;
  readonly authored: AuthoredWrite[];
}

function fail(message: string, ids: readonly string[] = [], code: "invalid_value" | "already_exists" | "element_not_found" | "wrong_kind" = "invalid_value"): never {
  throw new KernelError(code, message, ids.map(asElementId));
}

/** Where a note may be written: a live sheet (paper) or detail view (model), with the scale a detail view draws at. */
function ownerOf(reader: TrackedReader, ownerId: string): { readonly owner: BimElement; readonly space: "paper" | "model"; readonly scale: number; readonly paper: Vec2 | null } {
  const owner = reader.find(asElementId(ownerId));
  if (!owner || ("deleted" in owner && owner.deleted)) fail("The sheet or detail view you're writing in no longer exists.", [ownerId], "element_not_found");
  if (owner.kind === "sheet") return { owner, space: "paper", scale: 1, paper: sheetPaperSize(owner) };
  if (owner.kind === "view" && owner.viewType === "detail") return { owner, space: "model", scale: owner.props?.scale ?? DEFAULT_DETAIL_SCALE, paper: null };
  // Plans and sections take notes too: the box stays paper-sized at any view scale.
  if (owner.kind === "view" && (owner.viewType === "floor_plan" || owner.viewType === "ceiling_plan" || owner.viewType === "section")) return { owner, space: "model", scale: owner.props?.scale ?? DEFAULT_PLAN_SCALE, paper: null };
  fail("Notes go on a sheet, a detail view, a plan or a section. To label an element with its own data, use a tag.", [ownerId], "wrong_kind");
}

function liveNote(reader: TrackedReader, itemId: string): DrawingItem {
  const el = reader.find(asElementId(itemId));
  if (!el || ("deleted" in el && el.deleted)) fail("That note no longer exists. Someone may have deleted it.", [itemId], "element_not_found");
  if (el.kind !== "drawing_item" || el.shape !== "text") fail(`${itemId} is not a note.`, [itemId], "wrong_kind");
  return el;
}

function checkContent(paragraphs: readonly NoteParagraph[], itemId: string): NoteParagraph[] {
  const normalized = normalizeParagraphs(paragraphs);
  const problem = noteContentProblem(normalized);
  if (problem) fail(problem, [itemId]);
  return normalized;
}

function checkOnSheet(paper: Vec2 | null, at: Vec2, itemId: string): void {
  if (!paper) return;
  if (at.x < 0 || at.y < 0 || at.x > paper.x || at.y > paper.y) fail("The note's corner is off the sheet. Put it on the sheet.", [itemId]);
}

const normRotation = (deg: number) => {
  const r = round(((((deg + 180) % 360) + 360) % 360) - 180);
  return r === -180 ? 180 : r;
};

/**
 * A note as rich content. One written before notes were rich becomes a box
 * as wide as its text, its top-left placed so the text stays where it printed.
 */
function asRich(item: DrawingItem, space: "paper" | "model", scale: number): { note: RichTextNote; at: Vec2 } {
  const resolved = resolveNote(item);
  const at = item.points[0];
  if (!resolved || !at) fail("That note has no text to edit.", [item.id]);
  if (item.note) return { note: item.note, at };
  const lift = resolved.liftMm;
  return { note: { ...resolved.note, space }, at: roundVec(space === "paper" ? { x: at.x, y: at.y - lift } : { x: at.x, y: at.y + lift * scale }) };
}

/** A note's leaders as stored: the first as `leader`, the rest as `leaders`, coordinates rounded. */
function leaderFields(list: readonly NoteLeader[]): Pick<RichTextNote, "leader" | "leaders"> {
  const clean = list.map((l) => ({ to: roundVec(l.to), ...(l.elbow ? { elbow: roundVec(l.elbow) } : {}), ...(l.arrow ? { arrow: l.arrow } : {}) }));
  const [first, ...rest] = clean;
  return { ...(first ? { leader: first } : {}), ...(rest.length > 0 ? { leaders: rest } : {}) };
}

/** Someone else saved the note since the editor opened it: nothing is written. */
export interface NoteConflict {
  readonly code: "conflict";
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

/** Runs one note command, writing through the views executor's context. Refusals throw; a lost-update conflict comes back. */
export function executeTextNoteCommand(ctx: NoteCommandContext, command: TextNoteCommand): NoteConflict | null {
  const { model, reader, write, authored } = ctx;
  const contentValue = (el: DrawingItem) => noteFieldValue(el, NOTE_FIELDS.content) ?? "";
  const boxValue = (el: DrawingItem) => noteFieldValue(el, NOTE_FIELDS.box) ?? "";
  switch (command.type) {
    case "create_text_note": {
      if (model.elements[command.itemId]) fail(`${command.itemId} is already used by another element`, [command.itemId], "already_exists");
      const { owner, space, paper } = ownerOf(reader, command.ownerId);
      const at = roundVec(command.at);
      checkOnSheet(paper, at, command.itemId);
      const paragraphs = checkContent(command.paragraphs, command.itemId);
      const note: RichTextNote = {
        space,
        box: { width: round(command.width), height: command.height ?? null, rotation: normRotation(command.rotation ?? 0) },
        paragraphs,
        lineSpacing: command.lineSpacing ?? 1,
        ...leaderFields(command.leaders ?? (command.leader ? [{ to: command.leader }] : [])),
      };
      write({
        version: 0,
        authoredRev: {},
        id: asElementId(command.itemId),
        kind: "drawing_item",
        ownerId: owner.id,
        shape: "text",
        points: [at],
        textSize: command.textSize ?? DEFAULT_NOTE_SIZE_MM,
        note,
        ...(owner.partition ? { partition: owner.partition } : {}),
      });
      return null;
    }
    case "edit_text_note": {
      const item = liveNote(reader, command.itemId);
      if (noteContentFingerprint(item) !== command.expectedContent) {
        const label = noteLabel(item.note?.paragraphs ?? [{ runs: [{ text: item.text ?? "" }] }], 30);
        return { code: "conflict", message: `Someone saved a change to "${label}" while you were editing it, so your edit wasn't saved. Your text is still in the editor: copy it, then edit the note again.`, elementIds: [item.id] };
      }
      const { space, scale } = ownerOf(reader, item.ownerId);
      const { note, at } = asRich(item, space, scale);
      const paragraphs = checkContent(command.paragraphs, item.id);
      const { text: _plain, ...rest } = item;
      const next: DrawingItem = { ...rest, points: [at], textSize: command.textSize ?? item.textSize ?? DEFAULT_NOTE_SIZE_MM, note: { ...note, paragraphs, lineSpacing: command.lineSpacing ?? note.lineSpacing } };
      write(next);
      authored.push({ elementId: item.id, field: NOTE_FIELDS.content, value: contentValue(next) });
      if (at !== item.points[0]) authored.push({ elementId: item.id, field: NOTE_FIELDS.points, value: canonicalJson(next.points) });
      return null;
    }
    case "resize_text_note": {
      const item = liveNote(reader, command.itemId);
      const { space, scale, paper } = ownerOf(reader, item.ownerId);
      const { note, at: oldAt } = asRich(item, space, scale);
      const at = command.at ? roundVec(command.at) : oldAt;
      checkOnSheet(paper, at, item.id);
      const box = { ...note.box, width: round(command.width), ...(command.height !== undefined ? { height: command.height === null ? null : round(command.height) } : {}) };
      const { text: _plain, ...rest } = item;
      const next: DrawingItem = { ...rest, points: [at], note: { ...note, box } };
      write(next);
      authored.push({ elementId: item.id, field: NOTE_FIELDS.box, value: boxValue(next) });
      if (command.at) authored.push({ elementId: item.id, field: NOTE_FIELDS.points, value: canonicalJson(next.points) });
      if (!item.note) authored.push({ elementId: item.id, field: NOTE_FIELDS.content, value: contentValue(next) });
      return null;
    }
    case "move_text_note": {
      const item = liveNote(reader, command.itemId);
      if (command.at === undefined && command.rotation === undefined && command.leader === undefined && command.leaders === undefined) fail("Say where to move the note, how far to turn it, or where its leader points.", [item.id]);
      const { space, scale, paper } = ownerOf(reader, item.ownerId);
      const { note, at: oldAt } = asRich(item, space, scale);
      const at = command.at ? roundVec(command.at) : oldAt;
      checkOnSheet(paper, at, item.id);
      const { leader: _leader, leaders: _leaders, ...withoutLeader } = note;
      const leaders: readonly NoteLeader[] =
        command.leaders !== undefined
          ? command.leaders
          : command.leader === undefined
            ? [...(note.leader ? [note.leader] : []), ...(note.leaders ?? [])]
            : command.leader === null
              ? []
              : [{ ...note.leader, to: command.leader }, ...(note.leaders ?? [])];
      const nextNote: RichTextNote = { ...withoutLeader, box: { ...note.box, ...(command.rotation !== undefined ? { rotation: normRotation(command.rotation) } : {}) }, ...leaderFields(leaders) };
      const { text: _plain, ...rest } = item;
      const next: DrawingItem = { ...rest, points: [at], note: nextNote };
      write(next);
      if (command.at) authored.push({ elementId: item.id, field: NOTE_FIELDS.points, value: canonicalJson(next.points) });
      if (command.rotation !== undefined || command.leader !== undefined || command.leaders !== undefined) authored.push({ elementId: item.id, field: NOTE_FIELDS.box, value: boxValue(next) });
      if (!item.note) authored.push({ elementId: item.id, field: NOTE_FIELDS.content, value: contentValue(next) });
      return null;
    }
    case "delete_text_note": {
      const item = liveNote(reader, command.itemId);
      write({ ...item, deleted: true });
      authored.push({ elementId: item.id, field: NOTE_FIELDS.deleted, value: "true" });
      return null;
    }
  }
}
