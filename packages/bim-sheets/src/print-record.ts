import { createHash } from "node:crypto";
import { buildSheetSceneFor, canonicalJson, type ModelState, type SheetDrawOptions } from "@permitzip/bim-kernel";

/**
 * What a set print looked like, sheet by sheet, so an issue can say which
 * sheets changed since someone last printed and checked them. Schedules,
 * tags and title fields are live queries: a sheet can change without anyone
 * touching it. The digest is the drawn sheet itself (its scene graph), with
 * the model revision held at zero so a save elsewhere in the model doesn't
 * count as a change to this sheet.
 */

export interface SheetDigest {
  readonly sheetId: string;
  readonly number: string;
  readonly digest: string;
}

export interface SetPrintRecord {
  readonly kind: "set_print";
  readonly modelId: string;
  readonly modelRevision: number;
  readonly pdfFile: string;
  readonly pdfSha256: string;
  readonly sheets: readonly SheetDigest[];
  readonly printedBy: string;
  readonly printedByName?: string;
  readonly printedAt: string;
}

/**
 * The drawn content of each sheet, independent of the model revision and of
 * the sheet's revision table: the row an issue adds is the issue itself, not
 * a change to what was checked.
 */
export function sheetDigests(model: ModelState, sheetIds: readonly string[], opts: SheetDrawOptions): SheetDigest[] {
  const elements = { ...model.elements };
  for (const id of sheetIds) {
    const sheet = elements[id];
    if (sheet?.kind === "sheet" && sheet.props?.revisions) elements[id] = { ...sheet, props: { ...sheet.props, revisions: [] } };
  }
  const steady: ModelState = { ...model, revision: 0 as ModelState["revision"], elements };
  return sheetIds.map((sheetId) => {
    const sheet = model.elements[sheetId];
    const number = sheet?.kind === "sheet" ? sheet.number : sheetId;
    const scene = buildSheetSceneFor(steady, sheetId, opts);
    return { sheetId, number, digest: createHash("sha256").update(canonicalJson(scene)).digest("hex") };
  });
}

export type PrintComparison =
  | { readonly status: "matches_print"; readonly printedRevision: number; readonly printedAt: string }
  | {
      readonly status: "changed_since_print" | "not_printed";
      /** Sheets drawn differently from the last print. */
      readonly changed: readonly string[];
      /** Sheets the last print didn't include (or no print at all). */
      readonly unprinted: readonly string[];
      readonly printedRevision: number | null;
      readonly printedAt: string | null;
    };

/** Compare the sheets as they draw now with the last set print. */
export function compareWithPrint(now: readonly SheetDigest[], print: SetPrintRecord | null): PrintComparison {
  if (!print) return { status: "not_printed", changed: [], unprinted: now.map((s) => s.number), printedRevision: null, printedAt: null };
  const printed = new Map(print.sheets.map((s) => [s.sheetId, s.digest]));
  const changed: string[] = [];
  const unprinted: string[] = [];
  for (const s of now) {
    const was = printed.get(s.sheetId);
    if (was === undefined) unprinted.push(s.number);
    else if (was !== s.digest) changed.push(s.number);
  }
  if (changed.length === 0 && unprinted.length === 0) return { status: "matches_print", printedRevision: print.modelRevision, printedAt: print.printedAt };
  return { status: changed.length > 0 ? "changed_since_print" : "not_printed", changed, unprinted, printedRevision: print.modelRevision, printedAt: print.printedAt };
}

/** One plain sentence for the issue gate (people and agents read the same words). */
export function describePrintComparison(c: PrintComparison): string {
  if (c.status === "matches_print") return `Every sheet draws exactly as it did in the set printed at Rev ${c.printedRevision}.`;
  if (c.printedRevision === null) return `No set print to compare with: ${listSheets(c.unprinted)} ${c.unprinted.length === 1 ? "hasn't" : "haven't"} been printed as a set. Print the set and check it before issuing.`;
  const parts: string[] = [];
  if (c.changed.length > 0) parts.push(`${listSheets(c.changed)} ${c.changed.length === 1 ? "draws" : "draw"} differently than in the set printed at Rev ${c.printedRevision} (a schedule, tag or view changed)`);
  if (c.unprinted.length > 0) parts.push(`${listSheets(c.unprinted)} ${c.unprinted.length === 1 ? "wasn't" : "weren't"} in that print`);
  return `${parts.join("; ")}. Print the set again and check it before issuing.`;
}

function listSheets(numbers: readonly string[]): string {
  if (numbers.length <= 4) return numbers.join(", ");
  return `${numbers.slice(0, 4).join(", ")} and ${numbers.length - 4} more`;
}
