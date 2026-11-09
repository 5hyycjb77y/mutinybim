import { layoutSheet, type BatchCommand, type Sheet, type SheetRevision } from "@permitzip/bim-kernel";

export { sheetLayoutCommand } from "@permitzip/bim-kernel";

/**
 * Sheet commands people and agents build the same way: arranging a sheet's
 * viewports, the revision table, and the revision row an issue adds. The
 * Views & Sheets dialogs and the drawing-set MCP tools both call these, so a
 * person's Arrange and an agent's bim_auto_layout_sheet send the identical
 * edit.
 */

export type SheetLayoutOptions = Parameters<typeof layoutSheet>[2];

const sameNumber = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why a revision table can't be saved, in words for the person or agent; null when it can. */
export function revisionTableProblem(sheetNumber: string, rows: readonly SheetRevision[]): string | null {
  for (const r of rows) {
    if (!r.number.trim() || !r.date.trim() || !r.description.trim()) return `Every revision row on ${sheetNumber} needs a number, a date and a description.`;
  }
  const repeated = rows.find((r, i) => rows.findIndex((o) => sameNumber(o.number, r.number)) !== i);
  return repeated ? `Sheet ${sheetNumber} would have revision ${repeated.number.trim()} twice. Use the next number.` : null;
}

/**
 * The revision number to suggest next across sheets: one past the highest
 * number (1, 2, 3…) or letter (A, B, C…) already used; 1 when none is.
 */
export function nextRevisionNumber(sheets: ReadonlyArray<Pick<Sheet, "props">>): string {
  const used = sheets.flatMap((s) => (s.props?.revisions ?? []).map((r) => r.number.trim()));
  const numbers = used.filter((n) => /^\d+$/.test(n)).map(Number);
  if (numbers.length > 0) return String(Math.max(...numbers) + 1);
  const letters = used.filter((n) => /^[A-Za-z]$/.test(n)).map((n) => n.toUpperCase().charCodeAt(0));
  if (letters.length > 0) {
    const next = Math.max(...letters) + 1;
    return next <= 90 ? String.fromCharCode(next) : "1";
  }
  return "1";
}

/** The sheet that already has this revision number, if any. */
export function sheetWithRevision<T extends Pick<Sheet, "props">>(sheets: readonly T[], number: string): T | undefined {
  return sheets.find((sh) => (sh.props?.revisions ?? []).some((r) => sameNumber(r.number, number)));
}

/** One edit that appends a revision row to every sheet given. */
export function addRevisionCommand(sheets: ReadonlyArray<Pick<Sheet, "id" | "props">>, row: SheetRevision): BatchCommand {
  return {
    type: "batch_documents",
    label: `Add revision ${row.number} (${row.description}) to ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}`,
    commands: sheets.map((sh) => ({ type: "set_sheet_properties" as const, sheetId: sh.id, revisions: [...(sh.props?.revisions ?? []), row] })),
  };
}
