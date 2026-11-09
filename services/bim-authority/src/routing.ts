import { parseBranchModelId } from "@permitzip/bim-kernel";
import type { Sql } from "./pg-store";

/**
 * Where a connection for a model should be served. The owner comes from the
 * database (the machine holding an unexpired lease), never from the client:
 * a client-sent hint or a forced instance only decides which machine asks.
 */
export type RouteDecision =
  | { readonly kind: "local" }
  | { readonly kind: "replay"; readonly machine: string }
  /** Fly already replayed this request here and we are still not the owner: let the client retry shortly. */
  | { readonly kind: "retry" };

export interface LeaseHolder {
  readonly holderMachine: string | null;
  readonly live: boolean;
}

export function decideRoute(input: {
  readonly selfMachine: string | null;
  readonly holder: LeaseHolder | null;
  readonly alreadyReplayed: boolean;
}): RouteDecision {
  const { selfMachine, holder } = input;
  // Not on Fly (local runs), unknown model, free or expired lease, or ours: serve here.
  if (!selfMachine || !holder || !holder.live || !holder.holderMachine || holder.holderMachine === selfMachine) return { kind: "local" };
  if (input.alreadyReplayed) return { kind: "retry" };
  return { kind: "replay", machine: holder.holderMachine };
}

export async function leaseHolder(sql: Sql, modelId: string): Promise<LeaseHolder | null> {
  const [row] = await sql<{ holder_machine: string | null; live: boolean }[]>`
    select holder_machine, live from bim.model_lease_holder(${modelId})`;
  return row ? { holderMachine: row.holder_machine, live: row.live } : null;
}

/**
 * The model a copy opens over (round 11 W11): its parent copy's model row when
 * it is a copy of a copy, else its base. Null for a first copy. A database the
 * lineage migration hasn't reached answers the base.
 */
export async function parentModelOf(sql: Sql, modelId: string): Promise<string | null> {
  const branch = parseBranchModelId(modelId);
  if (!branch) return null;
  const [has] = await sql<{ ok: boolean }[]>`select to_regclass('bim.lineages') is not null as ok`;
  if (has?.ok !== true) return branch.baseModelId;
  const [row] = await sql<{ parent: string }[]>`
    select coalesce((select m.id from bim.models m where m.id = l.base_model_id || '~' || l.parent_lineage_id), l.base_model_id) as parent
    from bim.lineages l where l.model_id = ${modelId}`;
  return row?.parent ?? branch.baseModelId;
}

/** Copies deeper than this route to the base (a guard against a broken chain, never a product limit). */
const ROUTE_CHAIN_GUARD = 64;

/**
 * Who serves a model id. A copy nobody holds yet goes to the machine that
 * holds the nearest copy above it (its parent, then its parent's, up to the
 * base), so it opens beside that head and shares its unchanged elements (copy
 * on write) instead of loading a second copy.
 */
export async function routeHolder(sql: Sql, modelId: string): Promise<LeaseHolder | null> {
  const own = await leaseHolder(sql, modelId);
  if (!parseBranchModelId(modelId) || (own && own.live && own.holderMachine)) return own;
  let at: string | null = await parentModelOf(sql, modelId);
  for (let i = 0; at !== null && i < ROUTE_CHAIN_GUARD; i++) {
    const holder = await leaseHolder(sql, at);
    if (holder && holder.live && holder.holderMachine) return holder;
    at = await parentModelOf(sql, at);
  }
  return leaseHolder(sql, parseBranchModelId(modelId)?.baseModelId ?? modelId);
}

/** Fly machine ids are 14 lowercase hex characters; anything else never reaches a header. */
export function isFlyMachineId(value: string): boolean {
  return /^[0-9a-f]{14}$/.test(value);
}
