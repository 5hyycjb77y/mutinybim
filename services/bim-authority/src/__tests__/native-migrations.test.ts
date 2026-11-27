/** @jest-environment node */
import path from "node:path";
import { loadMigrationFiles, parseMigrationFiles } from "../migrations";
import {
  migrationArguments,
  nativeMigrationConfig,
  nativeMigrationFiles,
  NATIVE_BASELINE_COVERS_THROUGH,
  NATIVE_BASELINE_VERSION,
} from "../native-migrations";

describe("migration command arguments", () => {
  it("keeps hosted as the default and makes native installation explicit", () => {
    expect(migrationArguments([])).toEqual({ mode: "hosted", dryRun: false });
    expect(migrationArguments(["--dry-run"])).toEqual({ mode: "hosted", dryRun: true });
    expect(migrationArguments(["--native"])).toEqual({ mode: "native", dryRun: false });
    expect(migrationArguments(["--native", "--dry-run"])).toEqual({ mode: "native", dryRun: true });
    expect(migrationArguments(["--dry-run", "--native"])).toEqual({ mode: "native", dryRun: true });
  });

  it.each(["--nativ", "--native=true", "--dryrun", "install"])("refuses %s instead of silently choosing another mode", (arg) => {
    expect(() => migrationArguments([arg])).toThrow(/use only --native and\/or --dry-run/);
  });
});

describe("native installation configuration", () => {
  const dbUrl = "postgresql://installer@127.0.0.1:5432/native";

  it("needs only the database URL, with no sign-in source, served model or Supabase project", () => {
    expect(nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl })).toEqual({
      dbUrl, dbRef: "native", commit: null, app: null, region: null,
    });
  });

  it("requires a database URL", () => {
    expect(() => nativeMigrationConfig({})).toThrow(/requires MUTINYBIM_DB_URL/);
  });

  it.each([
    "not-a-url:with-a-secret",
    "https://installer:synthetic-secret@db.invalid/native",
    "postgres:///native",
  ])("refuses an invalid PostgreSQL URL without echoing credentials (%#)", (value) => {
    let error: unknown;
    try { nativeMigrationConfig({ MUTINYBIM_DB_URL: value }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/must be a PostgreSQL URL/);
    expect((error as Error).message).not.toContain(value);
    expect((error as Error).message).not.toContain("synthetic-secret");
  });

  it("accepts both PostgreSQL URL schemes", () => {
    expect(nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl.replace("postgresql:", "postgres:") }).dbRef).toBe("native");
  });

  it("refuses the known transaction-pooler port because the migration lock is session-scoped", () => {
    expect(() => nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl.replace(":5432/", ":6543/") })).toThrow(/direct or session-pooled/);
  });

  it("honors the existing forbidden-ref list, including trimmed entries", () => {
    const project = "abcdefghijklmnopqrst";
    expect(() => nativeMigrationConfig({
      MUTINYBIM_DB_URL: `postgresql://installer@db.${project}.supabase.co/native`,
      MUTINYBIM_FORBIDDEN_DB_REFS: ` other-ref, ${project} , `,
    })).toThrow(/refusing a forbidden database/);
  });

  it("checks a disposable project ref when an operator supplied one", () => {
    const project = "abcdefghijklmnopqrst";
    expect(() => nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl, MUTINYBIM_DISPOSABLE_PROJECT_REF: project })).toThrow(/not on the configured disposable project/);
    const matched = `postgresql://installer@db.${project}.supabase.co/native`;
    expect(nativeMigrationConfig({ MUTINYBIM_DB_URL: matched, MUTINYBIM_DISPOSABLE_PROJECT_REF: project }).dbUrl).toBe(matched);
  });

  it("preserves explicit local-mode restrictions without requiring local mode for a native database", () => {
    const remote = "postgresql://installer@db.invalid/native";
    expect(nativeMigrationConfig({ MUTINYBIM_DB_URL: remote }).dbUrl).toBe(remote);
    expect(nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl, MUTINYBIM_LOCAL_STACK: "1" }).dbUrl).toBe(dbUrl);
    expect(() => nativeMigrationConfig({ MUTINYBIM_DB_URL: remote, MUTINYBIM_LOCAL_STACK: "1" })).toThrow(/requires a local database/);
    expect(() => nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl, MUTINYBIM_LOCAL_STACK: "1", FLY_APP_NAME: "synthetic-app" })).toThrow(/refused on Fly/);
    expect(() => nativeMigrationConfig({ MUTINYBIM_DB_URL: dbUrl, MUTINYBIM_LOCAL_STACK: "true" })).toThrow(/must be 0 or 1/);
  });
});

describe("native migration history", () => {
  const shared = loadMigrationFiles(path.join(__dirname, "../../db/migrations"));
  const native = loadMigrationFiles(path.join(__dirname, "../../db/native"));

  it("ships an explicit native baseline without claiming the sixteen hosted files ran", () => {
    const historical = shared.filter((file) => file.version <= NATIVE_BASELINE_COVERS_THROUGH);
    const selected = nativeMigrationFiles(shared, native);
    expect(historical).toHaveLength(16);
    expect(native.some((file) => file.version === NATIVE_BASELINE_VERSION)).toBe(true);
    expect(native.every((file) => file.version > NATIVE_BASELINE_COVERS_THROUGH)).toBe(true);
    expect(selected.filter((file) => historical.some((old) => old.version === file.version))).toEqual([]);
    expect(selected).toEqual([...native, ...shared.filter((file) => file.version > NATIVE_BASELINE_COVERS_THROUGH)]
      .sort((a, b) => a.version.localeCompare(b.version)));
  });

  it("carries the same shared file bytes and checksums into both streams", () => {
    const selected = nativeMigrationFiles(shared, native);
    const additive = shared.filter((file) => file.version > NATIVE_BASELINE_COVERS_THROUGH);
    expect(additive.length).toBeGreaterThan(0);
    for (const file of additive) expect(selected.find((candidate) => candidate.version === file.version)).toEqual(file);
  });

  it("includes future shared additions in order without changing the source lists", () => {
    const future = parseMigrationFiles([{ file: "20990101000000_future_addition.sql", sql: "select 1;" }]);
    const inputs = [...future, ...shared].reverse();
    const originalOrder = inputs.map((file) => file.file);
    const selected = nativeMigrationFiles(inputs, native);
    expect(selected.at(-1)).toEqual(future[0]);
    expect(inputs.map((file) => file.file)).toEqual(originalOrder);
  });

  it("fails if an image omitted its native baseline", () => {
    expect(() => nativeMigrationFiles(shared, [])).toThrow(/no native baseline/);
  });

  it("refuses a version collision across native and shared directories", () => {
    const collision = parseMigrationFiles([{ file: `${NATIVE_BASELINE_VERSION}_shared_collision.sql`, sql: "select 1;" }]);
    expect(() => nativeMigrationFiles([...shared, ...collision], native)).toThrow(/two files share version/);
  });
});
