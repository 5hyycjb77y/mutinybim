import { z } from "zod";
import type { SheetRevision } from "@permitzip/bim-kernel";
import type { PrintComparison, SetPrintRecord } from "@permitzip/bim-sheets";
import type { AgentEditResult } from "@permitzip/bim-sync";
import type { FiledInProject } from "./filed-in-project";

/**
 * What printing and issuing a drawing set answers, as the Views & Sheets
 * dialogs and the agent read it. The work itself (the model server, storage,
 * the Workspace) is in `./drawing-set`, server side.
 */

export interface SetSheetPage {
  readonly number: string;
  readonly title: string;
  readonly page: number;
}

export type PrintSetResult =
  | {
      readonly status: "printed";
      readonly revision: number;
      readonly sheets: readonly SetSheetPage[];
      readonly sha256: string;
      readonly bytes: number;
      readonly downloadUrl: string;
      readonly expiresInSeconds: number;
      readonly titleBlockNote?: string;
      /** Linked backgrounds that couldn't be cut (the pages still print without them). */
      readonly backgroundsMissing: readonly string[];
      /** Viewports off a sheet's drawing area and labels the PDF font printed differently (`1⅜"` as `1-3/8"`). */
      readonly printNotes: readonly string[];
    }
  | { readonly status: "refused"; readonly message: string };

export interface IssueSetInput {
  readonly name: string;
  readonly expectedRevision: number;
  readonly sheets?: readonly string[];
  readonly addRevision?: SheetRevision;
  /** Issue although sheets draw differently than in the last set print (the caller has checked them). */
  readonly acceptChangesSincePrint?: boolean;
}

export type IssueCheckResult =
  | { readonly status: "refused"; readonly message: string }
  | {
      readonly status: "ready";
      /** The print check in words (matching, or which sheets differ). */
      readonly message: string;
      readonly revision: number;
      readonly comparison: PrintComparison;
      readonly sheets: readonly IssueSheetSummary[];
      readonly nextRevision: string;
    };

export interface IssueSheetSummary {
  readonly number: string;
  readonly title: string;
  readonly lastRevision: string | null;
}

export type IssueSetResult =
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "not_saved"; readonly message: string; readonly edit: AgentEditResult }
  | { readonly status: "needs_print"; readonly message: string; readonly revision: number; readonly comparison: PrintComparison }
  | {
      readonly status: "issued" | "already_issued";
      readonly message: string;
      readonly issueId: string;
      readonly revision: number;
      readonly snapshotSha256: string;
      readonly pdfSha256: string;
      readonly sheets: ReadonlyArray<SetSheetPage & { readonly revision: string | null }>;
      readonly references: ReadonlyArray<{ readonly id: string; readonly views: readonly string[] }>;
      readonly downloadUrl: string;
      readonly manifestUrl: string;
      readonly filed: FiledInProject;
      readonly comparison: PrintComparison;
      readonly acceptedChangesSincePrint: boolean;
      /** Live blocks on the issued sheets whose text this issue froze. */
      readonly blocksFrozen: number;
      /** V10: each sheet's public Verify page (the link its QR code carries); empty when this path records none. */
      readonly verifyLinks: ReadonlyArray<{ readonly number: string; readonly url: string }>;
    };

export const issueSummarySchema = z.object({
  issueId: z.string(),
  name: z.string(),
  modelRevision: z.number(),
  issuedAt: z.string(),
  issuedBy: z.string(),
  issuedByName: z.string().optional(),
  pdfFile: z.string(),
  sheets: z.array(z.object({ number: z.string(), title: z.string(), revision: z.string().nullable() })),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

export interface SetHistory {
  readonly lastPrint: (Pick<SetPrintRecord, "modelRevision" | "printedAt" | "printedByName"> & { readonly sheets: readonly string[]; readonly downloadUrl: string }) | null;
  readonly issues: ReadonlyArray<IssueSummary & { readonly downloadUrl: string }>;
}
