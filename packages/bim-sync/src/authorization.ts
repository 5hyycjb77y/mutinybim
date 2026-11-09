import { parseBranchModelId, type Actor } from "@permitzip/bim-kernel";
import { type LineageCapability } from "@permitzip/bim-kernel/lineages";
import { principalFor } from "./agent-principal";
import type { ConnectionPrincipal } from "./hub";
import { lineageRights, LINEAGE_RIGHTS_WORDS, rightsOn, type LineageGrantRecord, type LineageRights, type LineageRow } from "./lineages/rights";

/**
 * The engine's whole authorization contract. Hosts answer one question —
 * what may this verified person do to this model? — and the engine applies it.
 * Round 11 (W11): and which copies they are named on; the engine combines
 * that with the copy's parent chain into rights per copy. See AUTHORIZATION.md.
 */
export type ModelCapability = "model.read" | "model.edit" | "model.issue";

export type ModelGrant =
  | { readonly ok: true; readonly capabilities: ReadonlySet<ModelCapability> }
  | { readonly ok: false; readonly reason: string };

/** The person's live grants on a model's copies, or a refusal in words (the host couldn't answer). */
export type LineageGrantsAnswer = { readonly ok: true; readonly grants: readonly LineageGrantRecord[] } | { readonly ok: false; readonly reason: string };

export interface ModelAuthorizer {
  capabilities(input: { readonly userId: string; readonly modelId: string; readonly token: string }): Promise<ModelGrant>;
  /**
   * Round 11: the grants named for this person on copies of `modelId` (the
   * base model's id). Absent: the host names nobody, so a copy is edited by
   * its creator (and a round 8b branch by its base's editors).
   */
  lineageGrants?(input: { readonly userId: string; readonly modelId: string; readonly token: string }): Promise<LineageGrantsAnswer>;
}

export const NO_MODEL_ACCESS = "You don't have access to this model. Ask a project admin to add you.";

/**
 * The project exists and the person may see it, but no live model is set up
 * for it yet. Only ever sent after the person's read access was confirmed, so
 * it reveals nothing to people without access. Clients match this exact text
 * (a host's client shows its own words for it).
 */
export const NO_SUCH_MODEL = "No such model";

export type NativeModelRole = "viewer" | "editor" | "manager";

const ROLE_CAPABILITIES: Record<NativeModelRole, readonly ModelCapability[]> = {
  viewer: ["model.read"],
  editor: ["model.read", "model.edit"],
  manager: ["model.read", "model.edit", "model.issue"],
};

export function capabilitiesForRole(role: NativeModelRole): ReadonlySet<ModelCapability> {
  return new Set(ROLE_CAPABILITIES[role]);
}

export interface ModelMemberStore {
  roleOf(modelId: string, userId: string): Promise<NativeModelRole | null>;
}

/** Reference store for the native default; a standalone deployment backs it with bim.model_members. */
export class InMemoryModelMemberStore implements ModelMemberStore {
  private readonly roles = new Map<string, NativeModelRole>();

  set(modelId: string, userId: string, role: NativeModelRole | null): void {
    const key = `${modelId}\u0000${userId}`;
    if (role) this.roles.set(key, role);
    else this.roles.delete(key);
  }

  async roleOf(modelId: string, userId: string): Promise<NativeModelRole | null> {
    return this.roles.get(`${modelId}\u0000${userId}`) ?? null;
  }
}

/** Standalone per-copy members (round 11): who is named on which copy. A standalone deployment backs it with bim.lineage_members. */
export interface LineageMemberStore {
  grantsOf(baseModelId: string, userId: string): Promise<readonly LineageGrantRecord[]>;
}

export class InMemoryLineageMemberStore implements LineageMemberStore {
  private readonly rows = new Map<string, Map<string, Set<LineageCapability>>>();

  private key(baseModelId: string, userId: string): string {
    return `${baseModelId}\u0000${userId}`;
  }

  /** Name a person on a copy with a capability (`revoke` removes it). */
  grant(baseModelId: string, lineageId: string, userId: string, capability: LineageCapability): void {
    const byLineage = this.rows.get(this.key(baseModelId, userId)) ?? new Map<string, Set<LineageCapability>>();
    byLineage.set(lineageId, new Set([...(byLineage.get(lineageId) ?? []), capability]));
    this.rows.set(this.key(baseModelId, userId), byLineage);
  }

  revoke(baseModelId: string, lineageId: string, userId: string, capability: LineageCapability): void {
    this.rows.get(this.key(baseModelId, userId))?.get(lineageId)?.delete(capability);
  }

  async grantsOf(baseModelId: string, userId: string): Promise<readonly LineageGrantRecord[]> {
    const out: LineageGrantRecord[] = [];
    for (const [lineageId, caps] of this.rows.get(this.key(baseModelId, userId)) ?? []) for (const capability of caps) out.push({ lineageId, capability });
    return out;
  }
}

/** Open-source default: per-model members with viewer / editor / manager roles, and per-copy members. No host IAM involved. */
export class NativeModelAuthorizer implements ModelAuthorizer {
  constructor(
    private readonly members: ModelMemberStore,
    private readonly copies: LineageMemberStore | null = null,
  ) {}

  async capabilities(input: { readonly userId: string; readonly modelId: string }): Promise<ModelGrant> {
    const role = await this.members.roleOf(input.modelId, input.userId);
    if (!role) return { ok: false, reason: NO_MODEL_ACCESS };
    return { ok: true, capabilities: capabilitiesForRole(role) };
  }

  async lineageGrants(input: { readonly userId: string; readonly modelId: string }): Promise<LineageGrantsAnswer> {
    return { ok: true, grants: this.copies ? await this.copies.grantsOf(input.modelId, input.userId) : [] };
  }
}

/**
 * The model a host is asked about for a model id: a copy (`<base>~<copy>`) is
 * asked about as its base, whose project decides who may read at all. What
 * the person may do on the copy itself is the engine's (`lineageRights`):
 * project edit is edit on the first copy only.
 */
export function authorizationModelId(modelId: string): string {
  return parseBranchModelId(modelId)?.baseModelId ?? modelId;
}

/** The copies a connection is for, as the model server has them (nearest first, ending at the first copy). */
export interface ConnectionLineage {
  readonly chain: readonly LineageRow[];
  /** Copies whose changes the person's accepted responsibility on the parent covers (the engineer of record). */
  readonly responsibleOn?: () => Promise<ReadonlySet<string>>;
}

/** What a connection holds on the copy it serves and every copy above it. */
export interface PrincipalLineage {
  readonly lineageId: string;
  readonly rights: LineageRights;
  /** The same person's rights down another chain of this model (grants read once, at admission). */
  readonly rightsOf: (chain: readonly LineageRow[]) => LineageRights;
}

export type ConnectionDecision =
  | { readonly ok: true; readonly principal: ConnectionPrincipal; readonly capabilities: ReadonlySet<ModelCapability> }
  | { readonly ok: false; readonly reason: string };

/** The person's rights down a copy's chain: project capabilities, their grants, and the chain. */
export async function connectionLineageRights(
  authorizer: ModelAuthorizer,
  input: { readonly verifiedUserId: string; readonly baseModelId: string; readonly token: string; readonly capabilities: ReadonlySet<ModelCapability>; readonly lineage: ConnectionLineage },
): Promise<{ readonly ok: true; readonly rights: LineageRights; readonly rightsOf: PrincipalLineage["rightsOf"] } | { readonly ok: false; readonly reason: string }> {
  const answer: LineageGrantsAnswer = authorizer.lineageGrants ? await authorizer.lineageGrants({ userId: input.verifiedUserId, modelId: input.baseModelId, token: input.token }) : { ok: true, grants: [] };
  if (!answer.ok) return answer;
  const responsibleOn = input.lineage.responsibleOn ? await input.lineage.responsibleOn() : undefined;
  const rightsOf = (chain: readonly LineageRow[]): LineageRights =>
    lineageRights({
      userId: input.verifiedUserId,
      model: { read: input.capabilities.has("model.read"), edit: input.capabilities.has("model.edit") },
      chain,
      grants: answer.grants,
      ...(responsibleOn ? { responsibleOn } : {}),
    });
  return { ok: true, rights: rightsOf(input.lineage.chain), rightsOf };
}

/**
 * Decide a connection: the login may act as itself or as an agent bound to that
 * same person, and the agent gets exactly that person's capabilities. Without
 * edit the connection is read-only (the hub refuses its commands).
 *
 * With `lineage` (round 11, every copy the model server serves): edit is the
 * person's edit on that copy, never its base's; a copy they can't read is
 * refused as if it didn't exist for them.
 */
export async function authorizeConnection(
  authorizer: ModelAuthorizer,
  input: { readonly actor: Actor; readonly verifiedUserId: string; readonly modelId: string; readonly token: string; readonly lineage?: ConnectionLineage },
): Promise<ConnectionDecision> {
  const who = principalFor(input.actor, input.verifiedUserId);
  if (!who.ok) return who;
  const baseModelId = authorizationModelId(input.modelId);
  const grant = await authorizer.capabilities({ userId: input.verifiedUserId, modelId: baseModelId, token: input.token });
  if (!grant.ok) return grant;
  if (!grant.capabilities.has("model.read")) return { ok: false, reason: NO_MODEL_ACCESS };
  if (!input.lineage) {
    return {
      ok: true,
      principal: { actorId: who.actorId, canWrite: grant.capabilities.has("model.edit") },
      capabilities: grant.capabilities,
    };
  }
  const here = input.lineage.chain[0];
  if (!here) return { ok: false, reason: NO_MODEL_ACCESS };
  const decided = await connectionLineageRights(authorizer, { verifiedUserId: input.verifiedUserId, baseModelId, token: input.token, capabilities: grant.capabilities, lineage: input.lineage });
  if (!decided.ok) return decided;
  const mine = rightsOn(decided.rights, here.lineage.id);
  if (!mine.has("read")) return { ok: false, reason: LINEAGE_RIGHTS_WORDS.noRead };
  return {
    ok: true,
    principal: { actorId: who.actorId, canWrite: mine.has("edit"), lineage: { lineageId: here.lineage.id, rights: decided.rights, rightsOf: decided.rightsOf } },
    capabilities: grant.capabilities,
  };
}
