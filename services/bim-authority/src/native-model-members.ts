import type { ModelMemberStore, NativeModelRole } from "@permitzip/bim-sync";
import { z } from "zod";
import { resolveNativeSessionInTransaction } from "./native-session-store";
import type { QuerySql, Sql } from "./pg-store";

// PostgreSQL's uuid type also holds older identifiers with no RFC version or variant.
const personId = z.guid().length(36);
const role = z.enum(["viewer", "editor", "manager"]).nullable();
const membershipChange = z.object({ personId, expectedRole: role, role }).strict();
type MembershipChange = z.infer<typeof membershipChange>;
type MembershipResult = "changed" | "unchanged" | "conflict" | "denied" | "unknown_person" | "invalid";
type MembershipDecision =
  | { result: "changed" | "unchanged" | "conflict"; role: NativeModelRole | null }
  | { result: "denied" | "unauthenticated" | "unknown_person" | "invalid" };
interface MemberView {
  personId: string;
  displayName: string;
  role: NativeModelRole | null;
}
type MemberRead =
  | { result: "ok"; ownerId: string; members: MemberView[] }
  | { result: "denied" | "unauthenticated" | "unknown_person" | "invalid" };

/** Also used inside the socket's snapshot of the session, membership and copy. */
export async function nativeRoleOf(sql: QuerySql, modelId: string, userId: string): Promise<NativeModelRole | null> {
  if (!personId.safeParse(userId).success) return null;
  const [row] = await sql<{ role: NativeModelRole }[]>`
    select m.role from bim.model_members m join bim.model_authority a using (model_id)
    where m.model_id = ${modelId} and m.person_id = ${userId}::uuid and a.permission_source = 'native'`;
  return row?.role ?? null;
}

/** Base-model roles for NativeModelAuthorizer. Per-copy grants use PgLineageMemberStore. */
export class PgNativeModelMembers implements ModelMemberStore {
  constructor(private readonly sql: Sql) {}

  roleOf(modelId: string, userId: string): Promise<NativeModelRole | null> {
    return nativeRoleOf(this.sql, modelId, userId);
  }

  /** Managers see this model's members. Adding someone starts with their exact native person ID. */
  async readMemberships(modelId: string, token: string, targetId: string | null): Promise<MemberRead> {
    if (targetId !== null && !personId.safeParse(targetId).success) return { result: "invalid" };
    return this.sql.begin("isolation level repeatable read", async (tx): Promise<MemberRead> => {
      const actor = await resolveNativeSessionInTransaction(tx, token);
      if (!actor) return { result: "unauthenticated" };
      const [model] = await tx<{ ownerId: string }[]>`
        select a.owner_person_id as "ownerId" from bim.model_authority a
        join bim.model_members me using (model_id)
        where a.model_id = ${modelId} and a.permission_source = 'native'
          and me.person_id = ${actor.personId}::uuid and me.role = 'manager'`;
      if (!model) return { result: "denied" };
      const members = targetId === null
        ? await tx<MemberView[]>`select p.person_id as "personId", p.display_name as "displayName", m.role
            from bim.model_members m join bim.people p using (person_id)
            where m.model_id = ${modelId} order by lower(p.display_name), p.person_id`
        : await tx<MemberView[]>`select p.person_id as "personId", p.display_name as "displayName", m.role
            from bim.people p left join bim.model_members m on m.person_id = p.person_id and m.model_id = ${modelId}
            where p.person_id = ${targetId}::uuid`;
      if (targetId !== null && !members.length) return { result: "unknown_person" };
      return { result: "ok", ownerId: model.ownerId, members };
    });
  }

  /** The signed-in caller supplies the target and the role they saw. Only the session identifies the actor. */
  async changeRole(modelId: string, token: string, change: MembershipChange): Promise<MembershipResult> {
    const { result } = await this.updateMembership(modelId, token, change);
    return result === "unauthenticated" ? "denied" : result;
  }

  /** Return the role observed under the membership lock so a caller can review a conflict. */
  async updateMembership(modelId: string, token: string, input: unknown): Promise<MembershipDecision> {
    const change = membershipChange.safeParse(input);
    if (!change.success) return { result: "invalid" };
    const targetId = change.data.personId.toLowerCase();
    const { expectedRole, role: next } = change.data;
    try {
      return await this.sql.begin("isolation level read committed", async (tx): Promise<MembershipDecision> => {
        // The base row serializes all its membership writers. Read roles and check expiry after any wait.
        const [model] = await tx<{ owner_person_id: string }[]>`
          select owner_person_id from bim.model_authority where model_id = ${modelId}
            and permission_source = 'native' for update`;
        if (!model) return { result: "denied" };
        const actor = await resolveNativeSessionInTransaction(tx, token);
        if (!actor) return { result: "unauthenticated" };
        if (actor.personId === targetId || targetId === model.owner_person_id) return { result: "denied" };

        const [members] = await tx<{
          actor_role: NativeModelRole | null; target_role: NativeModelRole | null; target_exists: boolean;
        }[]>`select
          (select role from bim.model_members where model_id = ${modelId} and person_id = ${actor.personId}::uuid) as actor_role,
          (select role from bim.model_members where model_id = ${modelId} and person_id = ${targetId}::uuid) as target_role,
          exists(select 1 from bim.people where person_id = ${targetId}::uuid) as target_exists`;
        if (members?.actor_role !== "manager") return { result: "denied" };
        if (actor.personId !== model.owner_person_id && (members.target_role === "manager" || next === "manager")) return { result: "denied" };
        if (!members.target_exists) return { result: "unknown_person" };
        if (members.target_role !== expectedRole) return { result: "conflict", role: members.target_role };
        if (expectedRole === next) return { result: "unchanged", role: next };

        if (next === null) {
          await tx`delete from bim.model_members where model_id = ${modelId} and person_id = ${targetId}::uuid`;
        } else {
          await tx`insert into bim.model_members(model_id, person_id, role) values (${modelId}, ${targetId}::uuid, ${next})
            on conflict (model_id, person_id) do update set role = excluded.role`;
        }
        await tx`update bim.model_authority set authorization_revision = authorization_revision + 1 where model_id = ${modelId}`;
        return { result: "changed", role: next };
      });
    } catch {
      // Driver diagnostics may contain bound values. A client retries after reading the current role.
      throw new Error("Could not confirm the membership change. Read the current role before retrying.");
    }
  }
}
