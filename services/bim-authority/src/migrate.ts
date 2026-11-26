import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { BASELINE_PROBES } from "./migration-baseline";
import { loadMigrationFiles, runMigrations } from "./migrations";
import { connectForMigrations } from "./pg-migration-session";
import { migrationArguments, modeCheckedMigrationSession, nativeMigrationConfig, nativeMigrationFiles } from "./native-migrations";

/**
 * Applies db/migrations to the authority's own database (MUTINYBIM_DB_URL).
 * Fly runs this as the release step of every deploy (fly.toml `release_command`),
 * in a temporary machine with the app's secrets, before any machine restarts.
 * Exit 1 aborts the deploy and the running version keeps serving.
 *
 *   node --import tsx src/migrate.ts             # apply
 *   node --import tsx src/migrate.ts --dry-run   # report only, writes nothing
 *   node --import tsx src/migrate.ts --native   # native PostgreSQL 17 installation
 *   node --import tsx src/migrate.ts --native --dry-run
 *
 * The default hosted path validates the full configuration first, so a deploy whose settings the new
 * code would refuse also stops here instead of restarting machines into a crash.
 * Native installation needs only MUTINYBIM_DB_URL (and honors the database
 * safety guards); it does not invent a Supabase project or sign-in provider.
 */
async function main(): Promise<void> {
  const { mode, dryRun } = migrationArguments(process.argv.slice(2));
  if (mode === "hosted" && process.env.MUTINYBIM_AUTH_MODE === "native") {
    throw new Error("[migrate] use --native with MUTINYBIM_AUTH_MODE=native");
  }
  const config = mode === "native" ? nativeMigrationConfig() : loadConfig();
  const where = `${config.app ?? "local"}${config.region ? ` (${config.region})` : ""}, database ${config.dbRef}`;
  console.log(`[migrate] ${where}, image ${config.commit ?? "unknown"}`);

  const shared = loadMigrationFiles(fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  const files = mode === "native"
    ? nativeMigrationFiles(shared, loadMigrationFiles(fileURLToPath(new URL("../db/native/", import.meta.url))))
    : shared;
  const sql = connectForMigrations(config.dbUrl);
  try {
    // PostgreSQL also enforces native dry-run's no-DDL/no-DML contract.
    // Session GUCs and advisory locks are transient, not schema/data writes.
    if (mode === "native" && dryRun) await sql.unsafe("set default_transaction_read_only = on");
    await runMigrations({ session: modeCheckedMigrationSession(sql, mode), files,
      probes: mode === "native" ? {} : BASELINE_PROBES, dryRun });
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
