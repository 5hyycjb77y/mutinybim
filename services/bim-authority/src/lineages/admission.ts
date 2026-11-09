import { connectionLineageRights, storeHistory, type ConnectionLineage, type HistoryReader, type HistorySource, type ModelAuthorizer, type ModelCapability, type PrincipalLineage } from "@permitzip/bim-sync";
import { lineageHistory, rightsOn, type LineageLine } from "@permitzip/bim-sync/lineages";
import { parseBranchModelId, type ModelState } from "@permitzip/bim-kernel";
import { lineageModelId } from "@permitzip/bim-kernel/lineages";
import type { PgLineageStore } from "./store";

/**
 * The model server's side of per-copy rights (round 11 W11): the chain a
 * connection is decided against, and the live re-check's answer per copy.
 */

/** The chain for a served model id (the base itself, or a copy at any depth); null: no such copy. */
export async function connectionLineageFor(store: PgLineageStore, modelId: string): Promise<ConnectionLineage | null> {
  const baseModelId = parseBranchModelId(modelId)?.baseModelId ?? modelId;
  const chain = await store.chainOf(baseModelId, modelId);
  return chain ? { chain } : null;
}

export type CopyRecheck = { readonly ok: true; readonly canRead: boolean; readonly canWrite: boolean; readonly lineage: PrincipalLineage } | { readonly ok: false; readonly reason: string };

/** A live connection's rights on its copy now (grants can be revoked mid-session). */
export async function recheckCopyRights(
  authorizer: ModelAuthorizer,
  store: PgLineageStore,
  input: { readonly userId: string; readonly modelId: string; readonly token: string; readonly capabilities: ReadonlySet<ModelCapability> },
): Promise<CopyRecheck> {
  const lineage = await connectionLineageFor(store, input.modelId);
  const here = lineage?.chain[0];
  if (!lineage || !here) return { ok: true, canRead: false, canWrite: false, lineage: { lineageId: "", rights: new Map(), rightsOf: () => new Map() } };
  const baseModelId = parseBranchModelId(input.modelId)?.baseModelId ?? input.modelId;
  const decided = await connectionLineageRights(authorizer, { verifiedUserId: input.userId, baseModelId, token: input.token, capabilities: input.capabilities, lineage });
  if (!decided.ok) return decided;
  const mine = rightsOn(decided.rights, here.lineage.id);
  return { ok: true, canRead: mine.has("read"), canWrite: mine.has("edit"), lineage: { lineageId: here.lineage.id, rights: decided.rights, rightsOf: decided.rightsOf } };
}

/** A copy's line for the lineage service: its head and history over its chain, each link read live or from storage. */
export async function copyLine(store: PgLineageStore, baseModelId: string, lineageId: string, sourceOf: (modelId: string) => HistorySource & { head(): Promise<ModelState> }): Promise<LineageLine> {
  const rows = await store.rows(baseModelId);
  const row = rows.find((r) => r.lineage.id === lineageId);
  if (!row) throw new Error(`No copy ${lineageId} on ${baseModelId}`);
  const chain = (await store.chainOf(baseModelId, lineageModelId(baseModelId, row.lineage))) ?? [];
  const readers = new Map<string, HistoryReader>(chain.map((link) => [link.lineage.id, storeHistory(sourceOf(lineageModelId(baseModelId, link.lineage)))]));
  const own = sourceOf(lineageModelId(baseModelId, row.lineage));
  return { head: () => own.head(), history: lineageHistory(chain, (id) => readers.get(id)) };
}
