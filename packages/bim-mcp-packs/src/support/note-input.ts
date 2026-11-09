import { z } from "zod";
import { NOTE_LIMITS, paragraphsFromPlain, type NoteParagraph } from "@permitzip/bim-kernel";

/**
 * Note content as agents send it (MCP `bim_add_sheet_note` / `bim_edit_text_note`)
 * and as the Cmd+J approval card previews it: the same conversion on both
 * sides, so the preview is the note that will be saved.
 */

const IN = 25.4;
/** Rich note content as agents write it: paragraphs of styled runs, lists by kind and level, sizes in inches. */
export const noteRunInput = z.object({
  text: z.string().max(NOTE_LIMITS.maxRunChars).describe('Text of this run. "\\n" is a line break inside the paragraph.'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  text_height_in: z.number().min(NOTE_LIMITS.minSizeMm / IN).max(NOTE_LIMITS.maxSizeMm / IN).optional().describe("Cap height of this run in inches (default: the note's)."),
});
export const noteParagraphInput = z.object({
  runs: z.array(noteRunInput).max(NOTE_LIMITS.maxRunsPerParagraph).describe("Styled pieces of text, in order. An empty list is a blank line."),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  list: z.enum(["bullet", "numbered"]).optional().describe("Make the paragraph a list item."),
  level: z.number().int().min(0).max(NOTE_LIMITS.maxListLevel).optional().describe("List nesting, 0 = outermost."),
  start: z.number().int().min(1).max(NOTE_LIMITS.maxListStart).optional().describe("Numbered lists: restart counting here."),
});
export const noteContentInput = {
  text: z.string().trim().min(1).max(NOTE_LIMITS.maxChars).optional().describe("Plain text; each line is a paragraph. Use paragraphs instead for bold/italic/underline, lists or alignment."),
  paragraphs: z.array(noteParagraphInput).min(1).max(NOTE_LIMITS.maxParagraphs).optional().describe("Rich content: e.g. [{runs:[{text:'GENERAL NOTES',bold:true}]},{list:'numbered',runs:[{text:'Seal all joints.'}]}]."),
};

/** Agent paragraphs (or plain text) as kernel paragraphs; a string is the refusal. */
export function noteParagraphs(args: { text?: string; paragraphs?: ReadonlyArray<z.infer<typeof noteParagraphInput>> }): NoteParagraph[] | string {
  if (args.text && args.paragraphs) return "Send text or paragraphs, not both.";
  if (args.text) return paragraphsFromPlain(args.text);
  if (!args.paragraphs) return "Send the note's text (plain) or paragraphs (rich).";
  return args.paragraphs.map((p) => ({
    runs: p.runs.map((r) => ({
      text: r.text,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italic: true } : {}),
      ...(r.underline ? { underline: true } : {}),
      ...(r.text_height_in !== undefined ? { size: Math.round(r.text_height_in * IN * 100) / 100 } : {}),
    })),
    ...(p.align ? { align: p.align } : {}),
    ...(p.list ? { list: { kind: p.list, level: p.level ?? 0, ...(p.start !== undefined ? { start: p.start } : {}) } } : {}),
  }));
}

