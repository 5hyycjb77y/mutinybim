import { sha256HexOf } from "../authorship/canonical";
import { BLOCK_TABLE_SEPARATOR, blockHashInput } from "../blocks/hash";
import type { BlockSnapshot, RenderedBlock } from "../blocks/types";
import type { ElementId, ModelState } from "../types";
import { evaluateSheet } from "./evaluate";
import type { CalcSheetContext } from "./point";
import type { CalcSheetEvaluation, CalcSheetSpec, GoverningCell } from "./types";

/**
 * A worked sheet as a block (F5): the same text on screen, in the PDF and for
 * the agent, hashed for issue snapshots. Lines read as a table (`" | "`, the
 * table block's form), so a report draws real cells: one row per input,
 * lookup and step. The governing cell is named in words on its row, never by
 * colour alone; the chrome adds the colour.
 *
 * The governing cells are also library pins (`governing:<lookup>`), so a
 * table edit that moves the deciding cell reads "changed since issue" even
 * when the printed value happens to match.
 */

export const CALC_GOVERNING_WORDS = "governing cell";

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function unitText(u: string): string {
  return u === "1" ? "" : u;
}

function governingText(g: GoverningCell): string {
  return `${CALC_GOVERNING_WORDS}: ${g.rowLabel} row, ${g.columnLabel} column`;
}

/** The sheet's text (deterministic). */
export function renderCalcSheet(spec: CalcSheetSpec, ev: CalcSheetEvaluation, opts: { readonly withTitle?: boolean } = {}): RenderedBlock {
  // A block placed on a sheet draws its own title (bold) above the text, so it asks for none here.
  const lines: string[] = [...(opts.withTitle === false ? [] : [spec.title.toUpperCase()]), ["Line", "Value", "Unit", "How"].join(BLOCK_TABLE_SEPARATOR)];
  const row = (label: string, key: string, unit: string, how: string) => lines.push([label, num(ev.values[key]), unitText(unit), how].join(BLOCK_TABLE_SEPARATOR));
  for (const i of spec.inputs) row(i.label, i.key, i.unit, i.bind.from === "typed" ? "typed" : i.bind.from === "field" ? "from the model" : "from another sheet");
  const byLookup = new Map(ev.governing.map((g) => [g.lookup, g] as const));
  for (const l of spec.lookups) {
    const g = byLookup.get(l.key);
    row(l.label, l.key, l.unit, g ? governingText(g) : "not found");
  }
  for (const s of spec.steps) row(s.label, s.key, s.unit, s.formula.replace(/[{}]/g, ""));
  const resultLabel = spec.result.label;
  lines.push(`Result: ${resultLabel} = ${num(ev.values[spec.result.key])}`);
  for (const c of ev.checks) lines.push(`${c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "CAN'T CHECK"}: ${c.message}`);
  for (const c of spec.citations) lines.push(`Reference: ${c.section}${c.edition ? ` (${c.edition})` : ""}${c.note ? `, ${c.note}` : ""}`);
  for (const m of ev.missing) lines.push(`Needs: ${m}`);
  const unresolved = [...ev.missing];
  return { text: lines.join("\n"), unresolved, dependsOn: ev.dependsOn };
}

/** The pins a sheet freezes with: each governing cell, plus whatever library pins the host adds (table revisions). */
export function calcSheetPins(ev: CalcSheetEvaluation, libraryPins: Readonly<Record<string, string>> = {}): Record<string, string> {
  const out: Record<string, string> = { ...libraryPins };
  for (const g of ev.governing) out[`governing:${g.lookup}`] = `${g.rowIndex}|${g.columnIndex}|${g.value}`;
  return out;
}

/** The value hash a sheet freezes under (the same recipe as every block: text, unresolved, pins). */
export function calcSheetValueHash(rendered: Pick<RenderedBlock, "text" | "unresolved">, pins: Readonly<Record<string, string>>): string {
  return sha256HexOf(blockHashInput(rendered, pins));
}

/** One issue snapshot of a sheet, with its governing cells pinned. */
export function calcSheetSnapshot(blockId: ElementId, modelRevision: number, spec: CalcSheetSpec, ev: CalcSheetEvaluation, libraryPins: Readonly<Record<string, string>> = {}): BlockSnapshot {
  const rendered = renderCalcSheet(spec, ev);
  const pins = calcSheetPins(ev, libraryPins);
  return { blockId, modelRevision, valueHash: calcSheetValueHash(rendered, pins), rendered, libraryPins: pins };
}

interface Held {
  readonly spec: CalcSheetSpec;
  evaluation: CalcSheetEvaluation;
  rendered: RenderedBlock;
}

/**
 * The live sheets of a model, re-run incrementally. After an edit, only
 * sheets whose read set (`dependsOn`, the same set field blocks use) holds a
 * changed id re-run, found through an index, so the cost is the sheets the
 * edit touched, never all of them; a library edit (a table or a limit)
 * re-runs every sheet, since any could read it.
 */
export class CalcSheetSession {
  private readonly held = new Map<string, Held>();
  /** Element id → the sheets that read it, so an edit finds its sheets without looking at the others. */
  private readonly readers = new Map<string, Set<string>>();
  /** Sheets worked out since the session started (for tests and the perf row). */
  evaluations = 0;

  constructor(private ctx: CalcSheetContext) {}

  private index(sheetId: string, before: readonly string[], after: readonly string[]): void {
    for (const id of before) {
      const set = this.readers.get(id);
      set?.delete(sheetId);
      if (set?.size === 0) this.readers.delete(id);
    }
    for (const id of after) {
      let set = this.readers.get(id);
      if (!set) this.readers.set(id, (set = new Set()));
      set.add(sheetId);
    }
  }

  private run(model: Pick<ModelState, "elements">, sheetId: string, spec: CalcSheetSpec): CalcSheetEvaluation {
    const evaluation = evaluateSheet(model, spec, this.ctx);
    this.evaluations++;
    const was = this.held.get(sheetId);
    this.index(sheetId, was?.evaluation.dependsOn ?? [], evaluation.dependsOn);
    this.held.set(sheetId, { spec, evaluation, rendered: renderCalcSheet(spec, evaluation) });
    return evaluation;
  }

  /** Add or replace a sheet and work it out now. */
  put(model: Pick<ModelState, "elements">, sheetId: string, spec: CalcSheetSpec): CalcSheetEvaluation {
    return this.run(model, sheetId, spec);
  }

  remove(sheetId: string): void {
    const was = this.held.get(sheetId);
    if (was) this.index(sheetId, was.evaluation.dependsOn, []);
    this.held.delete(sheetId);
  }

  get(sheetId: string): { readonly evaluation: CalcSheetEvaluation; readonly rendered: RenderedBlock } | null {
    return this.held.get(sheetId) ?? null;
  }

  /** After one edit: re-run the sheets it can change (those whose read set holds a changed id); returns their ids. */
  applyEdit(model: Pick<ModelState, "elements">, changedIds: readonly string[]): string[] {
    const hit = new Set<string>();
    for (const id of changedIds) for (const sheetId of this.readers.get(id) ?? []) hit.add(sheetId);
    const rerun = [...hit].sort();
    for (const sheetId of rerun) {
      const h = this.held.get(sheetId);
      if (h) this.run(model, sheetId, h.spec);
    }
    return rerun;
  }

  /** The firm's or project's tables or limits changed: every sheet re-runs. */
  applyLibraryChange(model: Pick<ModelState, "elements">, ctx: CalcSheetContext): void {
    this.ctx = ctx;
    for (const [sheetId, h] of [...this.held]) this.run(model, sheetId, h.spec);
  }
}
