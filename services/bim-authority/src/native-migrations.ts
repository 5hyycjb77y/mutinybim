import type postgres from "postgres";
import { nativeDatabaseUrl } from "./config";
import { parseMigrationFiles, type MigrationFile, type MigrationSession } from "./migrations";
import { pgMigrationSession } from "./pg-migration-session";

/** Last immutable hosted file represented by the explicit native baseline.
 * Native installs record the baseline they actually execute, never these
 * historical hosted files. Later additive files are shared by both modes.
 */
export const NATIVE_BASELINE_COVERS_THROUGH = "20261103100200";
export const NATIVE_BASELINE_VERSION = "20261125000000";
export type MigrationMode = "hosted" | "native";

export function migrationArguments(args: readonly string[]): { mode: MigrationMode; dryRun: boolean } {
  const unknown = args.filter((arg) => arg !== "--native" && arg !== "--dry-run");
  if (unknown.length) throw new Error("[migrate] use only --native and/or --dry-run");
  return { mode: args.includes("--native") ? "native" : "hosted", dryRun: args.includes("--dry-run") };
}

/** Installation needs a database, not an already configured browser host or
 * served model. Keep the existing forbidden-database and explicit local-mode
 * guards; do not require fake Supabase settings to install plain PostgreSQL.
 */
export function nativeMigrationConfig(env: NodeJS.ProcessEnv = process.env): {
  dbUrl: string; dbRef: string; commit: string | null; app: string | null; region: string | null;
} {
  const dbUrl = nativeDatabaseUrl(env);
  return { dbUrl, dbRef: "native", commit: env.BIM_AUTHORITY_COMMIT ?? null,
    app: env.FLY_APP_NAME ?? null, region: env.FLY_REGION ?? null };
}

export function nativeMigrationFiles(historicalAndShared: readonly MigrationFile[], native: readonly MigrationFile[]): MigrationFile[] {
  if (native.length === 0) throw new Error("[migrate] this image has no native baseline");
  return parseMigrationFiles([
    ...native,
    ...historicalAndShared.filter((file) => file.version > NATIVE_BASELINE_COVERS_THROUGH),
  ].map(({ file, sql }) => ({ file, sql })));
}

/** Databases predating the native installer have no mode marker. */
export async function installedMode(sql: postgres.Sql): Promise<MigrationMode | null> {
  const [known] = await sql<{ present: boolean }[]>`select to_regclass('bim.installation') is not null as present`;
  if (!known?.present) return null;
  const rows = await sql<{ mode: string; format_version: number }[]>`select mode,format_version from bim.installation where id`;
  const [row] = rows;
  if (rows.length !== 1 || row?.format_version !== 1 || (row.mode !== "native" && row.mode !== "hosted")) {
    throw new Error("Unrecognized bim.installation marker. Check the configured authority database.");
  }
  return row.mode;
}

/** Read-only preflight, called while holding the migrator's shared session
 * lock. A failed first baseline may leave only the empty stock tracking table;
 * allow that exact state to retry. Never reinterpret populated hosted storage
 * or guess that an unrecorded native-looking schema was installed correctly.
 */
export async function checkMigrationMode(sql: postgres.Sql, mode: MigrationMode): Promise<void> {
  if (mode === "native") {
    const [version] = await sql<{ version: number }[]>`select current_setting('server_version_num')::int as version`;
    if (!version || version.version < 170000) throw new Error("[migrate] native storage requires PostgreSQL 17 or newer");
  }
  const installed = await installedMode(sql);
  if (installed) {
    if (installed !== mode) {
      throw new Error(`[migrate] this is a ${installed} installation; ${mode === "native" ? "--native never converts a hosted database" : "use --native for its migration stream"}`);
    }
    const [tracked] = await sql<{ present: boolean }[]>`select to_regclass('bim.schema_migrations') is not null as present`;
    if (!tracked?.present) throw new Error("[migrate] installation marker has no migration ledger; refusing to infer applied migrations");
    if (mode === "native") {
      const [baseline] = await sql<{ how: string }[]>`select how from bim.schema_migrations where version = ${NATIVE_BASELINE_VERSION}`;
      if (baseline?.how !== "applied") throw new Error("[migrate] native marker has no applied native baseline record; refusing to infer or baseline existing native objects");
      const [legacy] = await sql<{ present: boolean }[]>`select exists(select 1 from bim.schema_migrations where version <= ${NATIVE_BASELINE_COVERS_THROUGH}) as present`;
      if (legacy?.present) throw new Error("[migrate] native marker has hosted migration history; refusing a mixed stream");
    }
    return;
  }
  if (mode === "hosted") return; // Unchanged historical hosted adoption path.

  const [tracking] = await sql<{ present: boolean }[]>`select to_regclass('bim.schema_migrations') is not null as present`;
  if (tracking?.present) {
    const [recorded] = await sql<{ present: boolean }[]>`select exists(select 1 from bim.schema_migrations) as present`;
    if (recorded?.present) throw new Error("[migrate] --native requires an empty database or a recorded native installation; existing history is not converted");
  }
  // Every schema-scoped application object depends on its namespace, either
  // directly or through the object that owns it. Inspect those dependencies
  // so a schema with only a collation, for example, still counts as occupied.
  const objects = await sql`
    with ledger as (
      select oid, reltype from pg_class where oid = to_regclass('bim.schema_migrations')
    ), ledger_objects(classid, objid) as (
      select 'pg_class'::regclass, oid from ledger
      union all select 'pg_class'::regclass, i.indexrelid from pg_index i join ledger l on l.oid = i.indrelid
      union all select 'pg_constraint'::regclass, c.oid from pg_constraint c join ledger l on l.oid = c.conrelid
      union all select 'pg_type'::regclass, t.oid from pg_type t join ledger l on l.reltype = t.oid
      union all select 'pg_type'::regclass, t.typarray from pg_type t join ledger l on l.reltype = t.oid
    )
    select n.nspname from pg_namespace n
    where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
      and (
        (n.nspname <> 'public' and (n.nspname <> 'bim' or not exists (select 1 from ledger)))
        or exists (
          select 1 from pg_depend d
          where d.refclassid = 'pg_namespace'::regclass and d.refobjid = n.oid
            and not exists (select 1 from ledger_objects l where l.classid = d.classid and l.objid = d.objid)
        )
      )
    limit 1`;
  if (objects.length) throw new Error("[migrate] --native requires an empty PostgreSQL database; existing application objects are not adopted or replaced");
}

/** Both modes take exactly the stock lock; checking after lock acquisition
 * prevents two first-start installers from choosing conflicting streams.
 */
export function modeCheckedMigrationSession(sql: postgres.Sql, mode: MigrationMode): MigrationSession {
  const session = pgMigrationSession(sql);
  return {
    ...session,
    async tryLock() {
      if (!(await session.tryLock())) return false;
      try { await checkMigrationMode(sql, mode); return true; }
      catch (err) { await session.unlock().catch(() => undefined); throw err; }
    },
  };
}
