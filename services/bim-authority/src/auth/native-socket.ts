import type { Actor, Changeset } from "@permitzip/bim-kernel";
import { NativeModelAuthorizer, NO_MODEL_ACCESS, authorizationModelId, commandDigest, principalFor, withoutCommandDigest, type CommitOutcome, type ConnectionPrincipal } from "@permitzip/bim-sync";
import { LINEAGE_RIGHTS_WORDS } from "@permitzip/bim-sync/lineages";
import { PERMISSION_CHECK_FAILED } from "../host/contract";
import { PgImportRuns } from "../import/pg-runs";
import { proposalOwnerCanWrite } from "../import/proposal-access";
import { recheckCopyRights } from "../lineages/admission";
import { PgLineageMemberStore } from "../lineages/members";
import { PgLineageStore } from "../lineages/store";
import { nativeRoleOf } from "../native-model-members";
import { resolveNativeSessionInTransaction } from "../native-session-store";
import { PgBranchRegistry } from "../pg-branches";
import type { QuerySql, Sql } from "../pg-store";

type NativeDecision =
  | { ok: true; personId: string; expiresAt: number; principal: ConnectionPrincipal }
  | { ok: false; kind: "session" | "access" | "unavailable"; reason: string };

/** The same per-copy grant is used at admission, on recheck, and inside an ordered save. */
export async function nativeCopyGrant(sql: QuerySql, modelId: string, personId: string) {
  const authorizer = new NativeModelAuthorizer(
    { roleOf: (base, who) => nativeRoleOf(sql, base, who) }, new PgLineageMemberStore(sql),
  );
  const base = await authorizer.capabilities({ userId: personId, modelId: authorizationModelId(modelId) });
  if (!base.ok || !base.capabilities.has("model.read")) return { ok: false as const, reason: NO_MODEL_ACCESS };
  const rights = await recheckCopyRights(authorizer, new PgLineageStore(sql, new PgBranchRegistry(sql)), {
    userId: personId, modelId, token: "", capabilities: base.capabilities,
  });
  if (!rights.ok) throw new Error("Could not read native copy rights.");
  if (!rights.canRead) return { ok: false as const, reason: LINEAGE_RIGHTS_WORDS.noRead };
  const canWrite = await proposalOwnerCanWrite(new PgImportRuns(sql), {
    modelId, userId: personId, canRead: true, canWrite: rights.canWrite,
  }, true);
  return { ok: true as const, canWrite, lineage: rights.lineage };
}

async function sessionAccess(tx: import("postgres").TransactionSql, token: string, modelId: string, actor: Actor): Promise<NativeDecision> {
  const session = await resolveNativeSessionInTransaction(tx, token);
  if (!session) return { ok: false, kind: "session", reason: "Sign in again: your session is not valid" };
  const who = principalFor(actor, session.personId);
  if (!who.ok) return { ok: false, kind: "access", reason: who.reason };
  const grant = await nativeCopyGrant(tx, modelId, session.personId);
  if (!grant.ok) return { ok: false, kind: "access", reason: grant.reason };
  return { ok: true, personId: session.personId, expiresAt: session.expiresAt.getTime() / 1000,
    principal: { actorId: who.actorId, canWrite: grant.canWrite, lineage: grant.lineage, reportWriteAccess: true } };
}

/** Admission and live checks decide the same exact copy from one committed database snapshot. */
export async function nativeSocketAccess(sql: Sql, token: string, modelId: string, actor: Actor): Promise<NativeDecision> {
  try {
    return await sql.begin("isolation level repeatable read", tx => sessionAccess(tx, token, modelId, actor));
  } catch {
    // Driver diagnostics can contain bound values. Clients can reconnect and obtain a fresh decision.
    console.error("[bim-authority] could not read native socket access", { modelId });
    return { ok: false, kind: "unavailable", reason: PERMISSION_CHECK_FAILED };
  }
}

/** A receipt read has no side effects. Missing or differently scoped evidence stays unconfirmed. */
export async function readNativeSaveReceipt(sql: Sql, token: string, modelId: string, actor: Actor, key: string, digest: string): Promise<CommitOutcome | null> {
  try {
    return await sql.begin("isolation level repeatable read", async tx => {
      const access = await sessionAccess(tx, token, modelId, actor);
      if (!access.ok) return null;
      const [row] = await tx<{ outcome: CommitOutcome }[]>`
        select outcome from bim.command_outcomes where model_id = ${modelId} and actor_id = ${access.principal.actorId} and idempotency_key = ${key}`;
      if (row?.outcome.commandDigest) return row.outcome.commandDigest === digest ? withoutCommandDigest(row.outcome) : null;
      // A changeset can outlive its receipt. Its original author, key and command are durable evidence.
      const [log] = await tx<{ body: Changeset }[]>`
        select body from bim.changesets where model_id = ${modelId} and actor_id = ${access.principal.actorId} and idempotency_key = ${key}`;
      if (!log || commandDigest(log.body.command) !== digest) return null;
      return { status: "committed" as const, revision: log.body.revision, rebased: log.body.rebased };
    });
  } catch {
    console.error("[bim-authority] could not check a native save receipt", { modelId });
    return null;
  }
}
