import { DatabaseSync } from "node:sqlite";
import type { ShareRole } from "../src/db";

/** The roster forms arrive in the following slice. Seed their records, then
 * exercise the app's real discovery, editing and personal sharing routes. */
export function seedTeamShare(file: string, team: {
  id: string; name: string; ownerId: string; memberId: string; modelId: string; role: ShareRole;
}): void {
  const db = new DatabaseSync(file);
  const at = "2026-11-26T00:00:00.000Z";
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN");
    db.prepare("INSERT INTO teams(id, name, owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(team.id, team.name, team.ownerId, team.ownerId, at);
    db.prepare("INSERT INTO team_members(team_id, user_id, role, added_by, created_at) VALUES (?, ?, 'member', ?, ?)")
      .run(team.id, team.memberId, team.ownerId, at);
    db.prepare("INSERT INTO team_shares(model_id, team_id, role, shared_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(team.modelId, team.id, team.role, team.ownerId, at);
    db.exec("COMMIT");
  } finally { db.close(); }
}
