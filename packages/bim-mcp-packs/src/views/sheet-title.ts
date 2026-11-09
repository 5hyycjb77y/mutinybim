import { SHEET_FIRM_NAME, type SheetTitle } from "@permitzip/bim-editor/contracts/building-model/sheet-title";
import type { Extra } from "../runtime";

/**
 * What an agent's printed sheet puts in the title block when the sheet's own
 * fields leave it blank: the host project's name and number and the firm. A
 * sheet's own title fields still win; this is the fallback.
 */
export type ResolveSheetTitle = (extra: Extra, projectId: string) => Promise<SheetTitle>;

export interface AgentSheetTitle extends SheetTitle {
  /** Plain words when the project couldn't be read (the sheet prints its own fields only). */
  readonly note?: string;
}

/** The title-block fallback for a print; never the model id. A failed read prints blanks and says so. */
export async function agentSheetTitle(resolve: ResolveSheetTitle, extra: Extra, projectId: string): Promise<AgentSheetTitle> {
  try {
    return await resolve(extra, projectId);
  } catch (err) {
    console.error("[agent-sheet-title] reading the project for a title block failed", { projectId, err });
    return {
      projectName: "",
      projectNumber: "",
      firmName: SHEET_FIRM_NAME,
      note: "The project's name and number couldn't be read, so the title block shows only the sheet's own fields. Set project_name and project_number with set_sheet_properties, or try again.",
    };
  }
}
