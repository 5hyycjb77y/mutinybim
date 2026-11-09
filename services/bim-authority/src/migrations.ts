import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The authority applies its own schema (db/migrations/*.sql) to its own
 * database. On Fly this runs as the deploy's release step (fly.toml
 * `release_command`), once per deploy, before any machine runs the new code;
 * a failure aborts the deploy and the running version keeps serving.
 *
 * Rules (README.md, "Database"):
 *   - Files run in filename order, each in one transaction, and are recorded in
 *     bim.schema_migrations with a sha256 of the file. A recorded file is never
 *     run again; editing one is refused (write a new file instead).
 *   - Expand only: the version still running must keep working against the new
 *     schema, because the database moves first and machines follow one at a time.
 *   - Files written before this migrator existed (through BASELINE_CUTOFF) were
 *     applied by hand. Each has a probe for an object only it creates; when the
 *     probe finds it, the file is recorded as "baselined" without running.
 */

export const MIGRATION_FILE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface RecordedMigration {
  readonly version: string;
  readonly checksum: string;
  readonly how: "applied" | "baselined";
}

export type RecordHow = RecordedMigration["how"];

/** What the migrator needs from the database. src/pg-migration-session.ts is the Postgres one. */
export interface MigrationSession {
  /** Session-level advisory lock. False when another migrator holds it. */
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;
  trackingTableExists(): Promise<boolean>;
  createTrackingTable(): Promise<void>;
  recorded(): Promise<RecordedMigration[]>;
  /** Evaluates a baseline probe: true = the file's objects are already there. */
  probe(expression: string): Promise<boolean>;
  /**
   * One transaction: take the transaction-level lock, re-check the version is
   * unrecorded, run the file (not when baselining) and record it. False when
   * it was recorded meanwhile.
   */
  record(file: MigrationFile, how: RecordHow): Promise<boolean>;
}

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function parseMigrationFiles(entries: readonly { readonly file: string; readonly sql: string }[]): MigrationFile[] {
  const files = entries
    .map(({ file, sql }) => {
      const m = MIGRATION_FILE.exec(file);
      if (!m?.[1] || !m[2]) throw new Error(`[migrate] ${file} is not named <14-digit timestamp>_<snake_case>.sql`);
      return { version: m[1], name: m[2], file, sql, checksum: checksumOf(sql) };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (let i = 1; i < files.length; i++) {
    if (files[i]?.version === files[i - 1]?.version) throw new Error(`[migrate] two files share version ${files[i]?.version}: ${files[i - 1]?.file}, ${files[i]?.file}`);
  }
  return files;
}

export function loadMigrationFiles(dir: string): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  if (names.length === 0) throw new Error(`[migrate] no .sql files in ${dir}`);
  return parseMigrationFiles(names.map((file) => ({ file, sql: readFileSync(path.join(dir, file), "utf8") })));
}

export interface MigrationSummary {
  readonly applied: readonly string[];
  readonly baselined: readonly string[];
  readonly alreadyRecorded: readonly string[];
  /** Newest version recorded in the database after this run (dry run: what it would be). */
  readonly schema: string | null;
  readonly dryRun: boolean;
}

export interface RunOptions {
  readonly session: MigrationSession;
  readonly files: readonly MigrationFile[];
  /** version → SQL boolean expression, only for files through BASELINE_CUTOFF. */
  readonly probes: Readonly<Record<string, string>>;
  readonly log?: (line: string) => void;
  /** Report what would happen without recording or running anything. */
  readonly dryRun?: boolean;
  readonly lockWaitMs?: number;
  readonly lockPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runMigrations(opts: RunOptions): Promise<MigrationSummary> {
  const { session, files, probes } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const lockWaitMs = opts.lockWaitMs ?? 60_000;
  const lockPollMs = opts.lockPollMs ?? 2_000;
  const dryRun = opts.dryRun === true;

  log(`[migrate] start: ${files.length} files in this image, newest ${files.at(-1)?.version ?? "none"}${dryRun ? " (dry run: nothing is written)" : ""}`);

  const deadline = now() + lockWaitMs;
  while (!(await session.tryLock())) {
    if (now() >= deadline) throw new Error(`[migrate] another migrator held the lock for ${Math.round(lockWaitMs / 1000)} s; nothing was applied`);
    log("[migrate] another migrator holds the lock; waiting");
    await sleep(lockPollMs);
  }

  try {
    const tracked = await session.trackingTableExists();
    if (!tracked && !dryRun) {
      await session.createTrackingTable();
      log("[migrate] created bim.schema_migrations");
    }
    const recorded = new Map((tracked ? await session.recorded() : []).map((r) => [r.version, r]));

    const known = new Set(files.map((f) => f.version));
    for (const version of [...recorded.keys()].sort()) {
      if (!known.has(version)) log(`[migrate] warning: the database has ${version}, which this image does not ship (a newer release ran here); continuing, migrations are expand-only`);
    }

    const edited = files.filter((f) => {
      const r = recorded.get(f.version);
      return r !== undefined && r.checksum !== f.checksum;
    });
    if (edited.length > 0) {
      throw new Error(`[migrate] already-recorded files were edited (checksum differs): ${edited.map((f) => f.file).join(", ")}. Restore them and put the change in a new file`);
    }

    const newestRecorded = [...recorded.keys()].sort().at(-1) ?? null;
    const pending = files.filter((f) => !recorded.has(f.version));
    const late = newestRecorded ? pending.filter((f) => f.version < newestRecorded) : [];
    if (late.length > 0) {
      throw new Error(`[migrate] ${late.map((f) => f.file).join(", ")} sort before ${newestRecorded}, which is already recorded. Rename with a newer timestamp`);
    }

    const alreadyRecorded: string[] = [];
    for (const f of files) {
      if (!recorded.has(f.version)) continue;
      alreadyRecorded.push(f.version);
      log(`[migrate] skip ${f.file} (recorded)`);
    }

    const applied: string[] = [];
    const baselined: string[] = [];
    for (const f of pending) {
      const probe = probes[f.version];
      const present = probe !== undefined && (await session.probe(probe));
      const how: RecordHow = present ? "baselined" : "applied";
      if (dryRun) {
        log(`[migrate] would ${present ? "baseline" : "apply"} ${f.file}`);
        (present ? baselined : applied).push(f.version);
        continue;
      }
      const started = now();
      if (!(await session.record(f, how))) {
        alreadyRecorded.push(f.version);
        log(`[migrate] skip ${f.file} (recorded meanwhile by another migrator)`);
        continue;
      }
      if (present) {
        baselined.push(f.version);
        log(`[migrate] baselined ${f.file} (its objects were already there; not re-run)`);
      } else {
        applied.push(f.version);
        log(`[migrate] applied ${f.file} in ${now() - started} ms`);
      }
    }

    const all = [...recorded.keys(), ...applied, ...baselined, ...alreadyRecorded].sort();
    const schema = all.at(-1) ?? null;
    log(`[migrate] done: applied ${applied.length}, baselined ${baselined.length}, already recorded ${alreadyRecorded.length}; schema at ${schema ?? "none"}${dryRun ? " (dry run)" : ""}`);
    return { applied, baselined, alreadyRecorded, schema, dryRun };
  } finally {
    // The session lock also ends with the connection; a failed unlock must not hide the real outcome.
    await session.unlock().catch((err: unknown) => console.error("[migrate] releasing the lock failed", err instanceof Error ? err.message : err));
  }
}
