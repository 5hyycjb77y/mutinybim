/** Operator command for creating a standalone model after native installation. */
import { parseArgs } from "node:util";
import postgres from "postgres";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { nativeMigrationConfig } from "./native-migrations";
import { connect, toJson, type Sql } from "./pg-store";

const usage = "Usage: node --import tsx src/create-native-model.ts <model-id> --owner <person-uuid>";

async function createModel(sql: Sql, modelId: string, owner: string): Promise<boolean> {
  try {
    await sql`select bim.create_native_model(${modelId}, ${owner}::uuid, ${sql.json(toJson(DEFAULT_SETTINGS))}::jsonb)`;
    return true;
  } catch (err) {
    if (!(err instanceof postgres.PostgresError)) throw err;
    if (err.code === "22P02") throw new Error("Use the UUID of an existing native person for --owner.");
    if (err.code === "3F000" || err.code === "42883") {
      throw new Error("Check MUTINYBIM_DB_URL and run the native installer on the intended database first.");
    }
    if (err.code !== "23505" || err.constraint_name !== "models_pkey" || err.table_name !== "models") throw err;
  }

  // Another process may have committed the same request before its reply arrived.
  // A retry confirms the stored owner and grant without touching model contents.
  const [existing] = await sql`
    select 1 from bim.model_authority a join bim.model_members m
      on m.model_id = a.model_id and m.person_id = a.owner_person_id
    where a.model_id = ${modelId} and a.permission_source = 'native'
      and a.owner_person_id = ${owner}::uuid and m.role = 'manager'`;
  if (!existing) throw new Error(`Model "${modelId}" is already in use. Check the model ID and designated owner.`);
  return false;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { owner: { type: "string", multiple: true }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const [modelId] = positionals;
  const owner = values.owner?.[0];
  if (positionals.length !== 1 || values.owner?.length !== 1 || !modelId || !owner) throw new Error(usage);
  if (modelId !== modelId.trim() || /[~,]/.test(modelId)) {
    throw new Error("Use a base model ID without surrounding whitespace, a comma or a copy separator (~).");
  }
  const sql = connect(nativeMigrationConfig().dbUrl, 1);
  try {
    const created = await createModel(sql, modelId, owner);
    console.log(created ? `Created model "${modelId}" with owner ${owner}.` : `Model "${modelId}" already exists with this owner (${owner}).`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "Could not create the native model.");
  process.exitCode = 1;
});
