/**
 * The title-block fallback shared by the browser's sheets and the agent's
 * prints: the firm whose drawings these are (never the product name), and the
 * host project's name and number. A sheet's own `firm_name`,
 * `project_name` and `project_number` fields win over these.
 */

export const SHEET_FIRM_NAME = "PermitZIP";

export interface SheetTitle {
  readonly projectName: string;
  readonly projectNumber: string;
  readonly firmName: string;
}
