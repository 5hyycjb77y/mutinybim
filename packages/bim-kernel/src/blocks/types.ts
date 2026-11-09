import type { ElementId } from "../types";
import type { BlockTableSpec } from "./table-spec";

/**
 * Live blocks and issue snapshots (KERNEL-REQUIREMENTS-MODEL §3.6, ROADMAP F5).
 *
 * A field-bound text block is a paragraph whose `{field}` tokens resolve
 * against the model (fields/template.ts): "Total connected {service.connected_kva}
 * kVA = {service.amps} A at {service.voltage}". It sits on a sheet as a
 * drawing item and in a report as an embed; both are the same block.
 *
 * The kernel renders a block at a revision deterministically and hashes it.
 * The host stores snapshots and ties them to issue sets; "changed since SD
 * issue" is a hash compare, and an issued copy is never rewritten.
 */

export interface FieldBlockSpec {
  /** Text with `{field}` tokens; newlines kept. */
  readonly template: string;
  /** The element the fields read (the service's MDP, a space, a zone). Absent: the project. */
  readonly subjectId?: ElementId;
  readonly title?: string;
  /** A computed table (ventilation, pressurization) instead of field tokens; the template is then its caption for the editor. */
  readonly table?: BlockTableSpec;
  /**
   * A live calculation sheet (round 12 S12) instead of field tokens: the
   * registered template (`CALC_SHEET_POINT` id) built for the block's subject,
   * worked out and drawn as the sheet's table; the template text is then its
   * caption. Written only to peers that read it (`blocks:calc`).
   */
  readonly calc?: CalcBlockSpec;
}

/** Which calculation a block shows (stored: the template id and its options never change meaning). */
export interface CalcBlockSpec {
  readonly template: string;
  /** The template's own options (an edition label, a table slot, a system id). */
  readonly options?: Readonly<Record<string, string | number | boolean>>;
}

export interface RenderedBlock {
  readonly text: string;
  /** Tokens that did not resolve, shown as "—" in the text and listed here so the editor can say which. */
  readonly unresolved: readonly string[];
  /** Elements whose changes can change this block (for incremental re-render and "changed since"). */
  readonly dependsOn: readonly ElementId[];
}

/** One frozen copy. `valueHash` is over the rendered text and the library pins, not the revision, so a no-op edit is not "changed". */
export interface BlockSnapshot {
  readonly blockId: ElementId;
  readonly modelRevision: number;
  readonly valueHash: string;
  readonly rendered: RenderedBlock;
  readonly libraryPins: Readonly<Record<string, string>>;
}

export type BlockFreshness = { readonly state: "live" } | { readonly state: "frozen_current"; readonly issueLabel: string } | { readonly state: "changed_since"; readonly issueLabel: string };
