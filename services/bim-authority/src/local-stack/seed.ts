/**
 * Seeds the local stack's database after the model server's migrations: the
 * local people, one demo project they all belong to, and an empty model
 * (`demo`) on it. Safe to run on every start; it only adds what is missing.
 *
 *   node --import tsx src/local-stack/seed.ts      (in the model server's image)
 */
import postgres from "postgres";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { toJson } from "../pg-store";
import { LOCAL_PEOPLE, localUserId } from "./people";

const PROJECT_ID = "00000000-0000-4000-a000-00000000d001";
const MODEL_ID = process.env.LOCAL_STACK_MODEL_ID ?? "demo";

const dbUrl = process.env.MUTINYBIM_DB_URL;
if (!dbUrl) throw new Error("[local-stack seed] MUTINYBIM_DB_URL is not set");

const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async (tx) => {
    for (const name of LOCAL_PEOPLE) await tx`insert into auth.users (id) values (${localUserId(name)}::uuid) on conflict do nothing`;
    await tx`insert into public.projects (id, project_number, name) values (${PROJECT_ID}::uuid, 'DEMO', 'Local demo') on conflict (id) do nothing`;
    for (const name of LOCAL_PEOPLE) {
      await tx`insert into public.project_members (project_id, user_id) values (${PROJECT_ID}::uuid, ${localUserId(name)}::uuid) on conflict do nothing`;
    }
    await tx`insert into bim.models (id, project_id, settings) values (${MODEL_ID}, ${PROJECT_ID}::uuid, ${tx.json(toJson(DEFAULT_SETTINGS))}) on conflict (id) do nothing`;
  });
  console.log(`[local-stack seed] model "${MODEL_ID}" on the demo project; members: ${LOCAL_PEOPLE.join(", ")}`);
} catch (err) {
  console.error("[local-stack seed] failed", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
