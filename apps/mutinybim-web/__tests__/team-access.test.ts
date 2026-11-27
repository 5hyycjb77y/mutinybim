/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type ModelAccess, type ShareRole, type WebStore } from "../src/db";
import { openSupabaseStore } from "../src/db-supabase";

type Table = "users" | "models" | "model_shares" | "teams" | "team_members" | "team_shares";
type Row = Record<string, string>;
type Seed = (table: Table, rows: Row[]) => Promise<void> | void;

async function checkAccessMatrix(store: WebStore, seed: Seed): Promise<void> {
  const prefix = randomUUID();
  const person = prefix + "-bea";
  const other = prefix + "-alex";
  const created_at = "2026-11-26T00:00:00Z";
  await seed("users", [person, other].map((id) => ({ id, email: id + "@example.test", display_name: id, created_at })));

  // A membership through team ownership and one through the ordinary roster
  // must confer the same model role. Unrelated team names stay private.
  const teams = ["A", "A-private", "B", "B-private"].map((name) => ({
    id: prefix + name, name, owner_id: name === "A" ? person : other, created_at,
  }));
  await seed("teams", teams);
  await seed("team_members", [{ team_id: prefix + "B", user_id: person, role: "manager", created_at }]);
  const grants: (ShareRole | null)[] = [null, "view", "edit"];
  const teamCases = grants.flatMap((role) => [false, true].map((member) => ({ role, member })));
  const models: Row[] = [];
  const personal: Row[] = [];
  const shared: Row[] = [];
  const cases: { id: string; expected: ModelAccess | null; teams: string[]; direct: ShareRole | null }[] = [];

  const personalCases = grants.flatMap((direct) => [false, true].map((owner) => ({ direct, owner })));
  const pairs = teamCases.flatMap((a) => teamCases.map((b) => ({ a, b })));
  for (const { direct, owner } of personalCases) {
    for (const { a, b } of pairs) {
      const id = `${prefix}-model-${cases.length}`;
      models.push({ id, owner_id: owner ? person : other, name: id, created_at, updated_at: created_at });
      if (direct) personal.push({ model_id: id, user_id: person, role: direct, created_at });
      const roles = new Set([direct]);
      const visibleTeams: string[] = [];
      for (const [name, team] of [["A", a], ["B", b]] as const) {
        if (!team.role) continue;
        shared.push({ model_id: id, team_id: prefix + name + (team.member ? "" : "-private"), role: team.role, created_at });
        if (team.member) {
          roles.add(team.role);
          visibleTeams.push(name);
        }
      }
      const expected = owner ? "owner" : roles.has("edit") ? "edit" : roles.has("view") ? "view" : null;
      cases.push({ id, expected, teams: visibleTeams, direct });
    }
  }
  await seed("models", models);
  await seed("model_shares", personal);
  await seed("team_shares", shared);
  const listed = await store.sharedWith(person);
  const byId = new Map(listed.map((m) => [m.id, m]));
  expect(cases).toHaveLength(216);
  expect(listed).toHaveLength(cases.filter((c) => c.expected === "edit" || c.expected === "view").length);
  expect(listed.map((m) => m.id)).toEqual([...byId.keys()].sort());
  const owned = cases.filter((c) => c.expected === "owner").map((c) => c.id).sort();
  expect((await store.modelsOf(person)).map((m) => m.id).sort()).toEqual(owned);
  expect(await store.countModelsOf(person)).toBe(owned.length);
  for (const c of cases) {
    const access = await store.accessTo(person, c.id);
    expect({ id: c.id, access: access?.access ?? null }).toEqual({ id: c.id, access: c.expected });
    expect((await store.sharesOf(c.id)).map((g) => [g.user_id, g.role])).toEqual(c.direct ? [[person, c.direct]] : []);
    if (c.expected === "edit" || c.expected === "view") {
      expect(byId.get(c.id)).toMatchObject({ role: c.expected, team_names: c.teams, owner_id: other });
    } else {
      expect(byId.has(c.id)).toBe(false);
    }
  }
}

test("SQLite model admission and discovery agree on all 216 personal, team and ownership combinations", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mutiny-team-access-"));
  const file = path.join(dir, "accounts.sqlite");
  const store = openDb(file);
  const db = new DatabaseSync(file);
  try {
    await checkAccessMatrix(store, (table, rows) => {
      const columns = Object.keys(rows[0] ?? {});
      if (!columns.length) return;
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...columns.map((k) => row[k]!));
    });
  } finally {
    db.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Opt in against a migrated disposable PostgREST stack with its Supabase URL
// and server-side test key. Each run uses fresh synthetic people and models.
const localUrl = process.env.MUTINYBIM_TEST_TEAM_SUPABASE_URL;
if (localUrl) {
  test("PostgREST model admission and discovery agree on the same 216 combinations", async () => {
    const key = process.env.MUTINYBIM_TEST_TEAM_SUPABASE_KEY;
    if (!key) throw new Error("Set MUTINYBIM_TEST_TEAM_SUPABASE_KEY for the disposable fixture");
    const store = openSupabaseStore({ url: localUrl, secretKey: key });
    try {
      await checkAccessMatrix(store, async (table, rows) => {
        const reply = await fetch(new URL(`/rest/v1/${table}`, localUrl), {
          method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(rows),
        });
        if (!reply.ok) throw new Error(`Could not seed ${table}: HTTP ${reply.status} ${await reply.text()}`);
      });
    } finally { await store.close(); }
  }, 60_000);
}
