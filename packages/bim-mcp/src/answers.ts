import { AgentSessionError, type AgentEditResult } from "@permitzip/bim-sync";

/** How every MutinyBIM tool answers: JSON an agent reads, and plain lines it can repeat verbatim. */

export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(withRefusalShape(value), null, 2) }] };
}

const REFUSED = new Set<unknown>(["refused", "would_refuse", "would_be_refused", "conflict"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every refusal an agent reads carries the rule's `code` and the
 * `element_ids` involved, whichever tool built it (the kernel always names
 * them; some tools dropped them on the way out).
 */
export function withRefusalShape(value: unknown): unknown {
  if (!isRecord(value) || !REFUSED.has(value.status)) return value;
  const { elementIds, ...rest } = value;
  const ids = Array.isArray(rest.element_ids) ? rest.element_ids : Array.isArray(elementIds) ? elementIds : [];
  const code = typeof rest.code === "string" ? rest.code : value.status === "conflict" ? "conflict" : "refused";
  return { ...rest, code, element_ids: ids };
}

/** "Not sent: <why>. Nothing changed." for an edit refused before it reached the model server. */
export function notSent(why: string): string {
  return `Not sent: ${why.replace(/\.$/, "")}. Nothing changed.`;
}

export function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Plain-language line an agent (and the tool card) can repeat verbatim. */
export function describeEditResult(result: AgentEditResult): string {
  switch (result.status) {
    case "saved":
      return `Saved as Rev ${result.revision}${result.rebased ? " (applied on top of newer changes that did not overlap)" : ""}. Changed: ${result.changedIds.join(", ") || "nothing"}.${result.summary && result.summary.length > 0 ? ` ${result.summary.join(". ")}.` : ""}${openIssuesLine(result.openIssues)}`;
    case "conflict":
      return `Not saved: ${result.message}${result.withRevision !== null ? ` (Rev ${result.withRevision})` : ""}. Read the model again at Rev ${result.latestRevision}; ask before overriding someone else's change.`;
    case "refused":
      return `Not saved: ${result.message}. Nothing changed.`;
    case "not_saved_yet":
      return `Not saved yet: ${result.message}`;
  }
}

/** Issues open before an edit that it left alone: said once, so a saved edit isn't read as "the model is clean". */
function openIssuesLine(issues: readonly { readonly message: string; readonly elementIds: readonly string[] }[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  const [first] = issues;
  const more = issues.length > 1 ? ` and ${issues.length - 1} more` : "";
  return ` The model still has ${issues.length} open issue${issues.length === 1 ? "" : "s"} from before this edit (${first?.message}${more}); fix ${issues.length === 1 ? "it" : "them"} with edits to those elements (bim_validation_issues lists them).`;
}

/** An edit's answer as tools return it. Open issues as a count: the message names the first, bim_validation_issues reads them all. */
export function editResultBody(result: AgentEditResult, modelId: string) {
  const open = result.status === "saved" ? result.openIssues : undefined;
  return { ...result, message: describeEditResult(result), model_id: modelId, ...(open ? { openIssues: undefined, open_issues: open.length } : {}) };
}

export function explain(err: unknown, tool: string) {
  console.error(`[mcp:${tool}] failed`, err);
  if (err instanceof AgentSessionError) {
    const lead = err.code === "denied" ? "The model server refused access" : "Could not reach the model server";
    return failure(`${lead}: ${err.message}`);
  }
  return failure(err instanceof Error ? err.message : `Unexpected error in ${tool}`);
}
