import type { BlockFreshness, BlockTableInput, ModelBlockKind } from "@permitzip/bim-kernel";

/**
 * What a live sheet block (and a report's embedded model block) looks like
 * against its issue snapshots, as the editor and reports read it. The
 * snapshots themselves and these reports are made in `./block-snapshots`,
 * server side.
 */

export interface SheetBlockReport {
  readonly sheetId: string;
  readonly blockId: string;
  readonly title: string | null;
  readonly freshness: BlockFreshness;
  /** "Live", "Matches SD issue", "Changed since SD issue". */
  readonly label: string;
  readonly text: string;
  readonly unresolved: readonly string[];
  /** What the issued copy says, when the live text moved on. */
  readonly issuedText: string | null;
  readonly issuedAt: string | null;
  readonly issuedAtRevision: number | null;
}

export interface ModelBlockRequest {
  readonly blockId: string;
  /** Show it as frozen at this issue ("SD"); null: live. */
  readonly pin: string | null;
}

export interface IssuedCopy {
  readonly issueName: string;
  readonly text: string;
  readonly issuedAt: string;
  readonly modelRevision: number;
}

export type ModelBlockReport =
  | {
      readonly ok: true;
      readonly blockId: string;
      readonly kind: ModelBlockKind;
      readonly title: string | null;
      readonly sheetId: string;
      readonly sheetNumber: string;
      readonly sheetName: string;
      /** The one definition, as the editor shows it. */
      readonly spec: { readonly template: string; readonly title: string | null; readonly subjectId: string | null; readonly table: BlockTableInput | null };
      /** What it says today. */
      readonly text: string;
      readonly unresolved: readonly string[];
      /** Against the latest issue, exactly as its sheet shows it. */
      readonly freshness: BlockFreshness;
      readonly label: string;
      readonly latest: IssuedCopy | null;
      /** Issues that froze it, newest first, once each. */
      readonly issues: readonly string[];
      readonly pin: string | null;
      readonly pinned: IssuedCopy | null;
      /** The pin names an issue this block was not on, in words; it then shows live. */
      readonly pinMissing: string | null;
    }
  | { readonly ok: false; readonly blockId: string; readonly message: string };
