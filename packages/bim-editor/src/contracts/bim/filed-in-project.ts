/** Whether a stored file was also shown in the project's Workspace (Files); a refusal carries the reason. */
export type FiledInProject =
  | { readonly status: "filed" | "already_filed"; readonly fileId: string; readonly folder: string; readonly name: string }
  | { readonly status: "not_filed"; readonly reason: string };
