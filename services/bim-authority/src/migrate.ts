import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { BASELINE_PROBES } from "./migration-baseline";
import { loadMigrationFiles, runMigrations } from "./migrations";
import { connectForMigrations, pgMigrationSession } from "./pg-migration-session";

/**
 * Applies db/migrations to the authority's own database (MUTINYBIM_DB_URL).
 * Fly runs this as the release step of every deploy (fly.toml `release_command`),
 * in a temporary machine with the app's secrets, before any machine restarts.
 * Exit 1 aborts the deploy and the running version keeps serving.
 *
 *   node --import tsx src/migrate.ts             # apply
 *   node --import tsx src/migrate.ts --dry-run   # report only, writes nothing
 *
 * The full configuration is validated first, so a deploy whose settings the new
 * code would refuse also stops here instead of restarting machines into a crash.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const where = `${config.app ?? "local"}${config.region ? ` (${config.region})` : ""}, database ${config.dbRef}`;
  console.log(`[migrate] ${where}, image ${config.commit ?? "unknown"}`);

  const files = loadMigrationFiles(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  const sql = connectForMigrations(config.dbUrl);
  try {
    await runMigrations({ session: pgMigrationSession(sql), files, probes: BASELINE_PROBES, dryRun });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    // Message and Postgres code only: never the connection settings.
    const code = typeof err === "object" && err !== null && "code" in err ? ` (${String(err.code)})` : "";
    console.error(`[migrate] FAILED${code}: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[migrate] the deploy stops here and the running version keeps serving. A file that failed rolled back whole; files recorded before it stay applied");
    process.exit(1);
  },
);
