import postgres from "postgres";
import type { MigrationFile, MigrationSession, RecordHow, RecordedMigration } from "./migrations";

/** One key for every migrator on a database (both lock kinds). */
const LOCK = "hashtext('bim-authority:schema-migrations')";

/**
 * A single connection for the whole run, so the session advisory lock holds
 * across files. Each file's transaction also takes the transaction-level lock
 * on the same key and re-checks its record: if the connection dropped and the
 * session lock went with it, the file still cannot run twice.
 *
 * lock_timeout is short on purpose: a migration waiting on a table lock makes
 * the live authority's commits and lease renewals queue behind it (renewals
 * must land within 7 s), so it gives up and fails the deploy instead.
 */
export function connectForMigrations(dbUrl: string): postgres.Sql {
  const transactionPooler = new URL(dbUrl).port === "6543";
  return postgres(dbUrl, {
    max: 1,
    idle_timeout: 0,
    prepare: !transactionPooler,
    onnotice: () => undefined,
    connection: {
      application_name: "bim-authority-migrate",
      statement_timeout: 120_000,
      lock_timeout: 3_000,
    },
  });
}

export function pgMigrationSession(sql: postgres.Sql): MigrationSession {
  return {
    async tryLock() {
      const [row] = await sql.unsafe<{ locked: boolean }[]>(`select pg_try_advisory_lock(${LOCK}) as locked`);
      return row?.locked === true;
    },
    async unlock() {
      await sql.unsafe(`select pg_advisory_unlock(${LOCK})`);
    },
    async trackingTableExists() {
      const [row] = await sql<{ present: boolean }[]>`select to_regclass('bim.schema_migrations') is not null as present`;
      return row?.present === true;
    },
    async createTrackingTable() {
      await sql.begin(async (tx) => {
        await tx.unsafe(`
          create schema if not exists bim;
          create table if not exists bim.schema_migrations (
            version text primary key,
            name text not null,
            checksum text not null,
            how text not null check (how in ('applied', 'baselined')),
            applied_at timestamptz not null default now()
          );
          comment on table bim.schema_migrations is
            'Files of services/bim-authority/db/migrations applied (or baselined: found already applied by hand) by the authority''s release step.';
          -- The authority's own role reads and writes it; never the Data API.
          alter table bim.schema_migrations enable row level security;
          revoke all on table bim.schema_migrations from public;
          do $$ begin
            if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table bim.schema_migrations from anon; end if;
            if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table bim.schema_migrations from authenticated; end if;
          end $$;
        `);
      });
    },
    async recorded(): Promise<RecordedMigration[]> {
      const rows = await sql<{ version: string; checksum: string; how: string }[]>`
        select version, checksum, how from bim.schema_migrations order by version`;
      return rows.map((r) => {
        if (r.how !== "applied" && r.how !== "baselined") throw new Error(`[migrate] bim.schema_migrations row ${r.version} has unknown how "${r.how}"`);
        return { version: r.version, checksum: r.checksum, how: r.how };
      });
    },
    async probe(expression: string) {
      const [row] = await sql.unsafe<{ present: boolean }[]>(`select coalesce((${expression}), false) as present`);
      return row?.present === true;
    },
    async record(file: MigrationFile, how: RecordHow) {
      const done = await sql.begin(async (tx) => {
        await tx.unsafe(`select pg_advisory_xact_lock(${LOCK})`);
        const [hit] = await tx<{ one: number }[]>`select 1 as one from bim.schema_migrations where version = ${file.version}`;
        if (hit) return false;
        // Simple protocol (no parameters): a file may hold many statements.
        if (how === "applied") await tx.unsafe(file.sql);
        await tx`
          insert into bim.schema_migrations (version, name, checksum, how)
          values (${file.version}, ${file.name}, ${file.checksum}, ${how})`;
        return true;
      });
      return done === true;
    },
  };
}

/** Newest recorded version, or null when this database has never been migrated by the authority. */
export async function recordedSchemaVersion(sql: postgres.Sql): Promise<string | null> {
  const [tracked] = await sql<{ present: boolean }[]>`select to_regclass('bim.schema_migrations') is not null as present`;
  if (tracked?.present !== true) return null;
  const [row] = await sql<{ version: string | null }[]>`select max(version) as version from bim.schema_migrations`;
  return row?.version ?? null;
}
