/**
 * @jest-environment node
 *
 * The authority's own migrator (src/migrations.ts) against an in-memory
 * database: ordering, the checksum guard, the lock, baselining hand-applied
 * files, and the shipped files and probes themselves. The Postgres session
 * (src/pg-migration-session.ts) is exercised by the release step on deploy.
 */
import path from "node:path";
import { BASELINE_CUTOFF, BASELINE_PROBES } from "../migration-baseline";
import { checksumOf, loadMigrationFiles, parseMigrationFiles, runMigrations, type MigrationFile, type MigrationSession, type RecordHow, type RecordedMigration } from "../migrations";

class FakeDb implements MigrationSession {
  tracking = false;
  rows = new Map<string, RecordedMigration>();
  /** SQL actually executed, in order. */
  ran: string[] = [];
  /** Probe expressions that evaluate true. */
  present = new Set<string>();
  lockedByOther = 0;
  locked = false;
  unlocks = 0;
  failOn: string | null = null;
  /** Another migrator records this version just before our transaction. */
  raceOn: string | null = null;

  async tryLock() {
    if (this.lockedByOther > 0) {
      this.lockedByOther--;
      return false;
    }
    this.locked = true;
    return true;
  }
  async unlock() {
    this.locked = false;
    this.unlocks++;
  }
  async trackingTableExists() {
    return this.tracking;
  }
  async createTrackingTable() {
    this.tracking = true;
  }
  async recorded() {
    return [...this.rows.values()];
  }
  async probe(expression: string) {
    return this.present.has(expression);
  }
  async record(file: MigrationFile, how: RecordHow) {
    if (!this.locked) throw new Error("record without the lock");
    if (this.raceOn === file.version) this.rows.set(file.version, { version: file.version, checksum: file.checksum, how: "applied" });
    if (this.rows.has(file.version)) return false;
    if (how === "applied") {
      if (this.failOn === file.version) throw new Error(`relation already exists (${file.file})`);
      this.ran.push(file.version);
    }
    this.rows.set(file.version, { version: file.version, checksum: file.checksum, how });
    return true;
  }
}

const files = (...versions: string[]) => parseMigrationFiles(versions.map((v) => ({ file: `${v}_step_${v.slice(-2)}.sql`, sql: `-- ${v}\nselect 1;` })));
const quiet = { log: () => undefined, sleep: async () => undefined };

describe("migration files", () => {
  it("run in filename order whatever order the directory lists them, and refuse bad names and duplicate versions", () => {
    const parsed = parseMigrationFiles([
      { file: "20261029130000_b.sql", sql: "b" },
      { file: "20261017000100_a.sql", sql: "a" },
    ]);
    expect(parsed.map((f) => f.version)).toEqual(["20261017000100", "20261029130000"]);
    expect(parsed[0]?.checksum).toBe(checksumOf("a"));
    expect(() => parseMigrationFiles([{ file: "2026_bad.sql", sql: "" }])).toThrow(/not named/);
    expect(() =>
      parseMigrationFiles([
        { file: "20261017000100_a.sql", sql: "a" },
        { file: "20261017000100_b.sql", sql: "b" },
      ]),
    ).toThrow(/share version 20261017000100/);
  });

  it("the shipped files parse, and every probe is for a shipped file at or before the cutoff", () => {
    const shipped = loadMigrationFiles(path.join(__dirname, "../../db/migrations"));
    const versions = new Set(shipped.map((f) => f.version));
    expect(versions.has(BASELINE_CUTOFF)).toBe(true);
    for (const version of Object.keys(BASELINE_PROBES)) {
      expect(versions.has(version)).toBe(true);
      expect(version <= BASELINE_CUTOFF).toBe(true);
    }
    // Every hand-applied file can be adopted; files after the cutoff never are.
    for (const f of shipped) expect(Object.hasOwn(BASELINE_PROBES, f.version)).toBe(f.version <= BASELINE_CUTOFF);
    // A file runs inside the migrator's transaction: no transaction control or CONCURRENTLY of its own.
    for (const f of shipped) {
      const body = f.sql.replace(/--.*$/gm, "");
      expect(body).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
      expect(body).not.toMatch(/\bconcurrently\b/i);
    }
  });
});

describe("runMigrations", () => {
  it("applies every file in order on an empty database, records each, and releases the lock", async () => {
    const db = new FakeDb();
    const lines: string[] = [];
    const out = await runMigrations({ session: db, files: files("20261101000000", "20261102000000"), probes: {}, log: (l) => lines.push(l), sleep: quiet.sleep });
    expect(db.ran).toEqual(["20261101000000", "20261102000000"]);
    expect(out).toMatchObject({ applied: ["20261101000000", "20261102000000"], baselined: [], schema: "20261102000000" });
    expect(db.tracking).toBe(true);
    expect(db.locked).toBe(false);
    expect(lines[0]).toMatch(/^\[migrate\] start: 2 files/);
    expect(lines.some((l) => l.startsWith("[migrate] applied 20261101000000_step_00.sql"))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\[migrate\] done: applied 2, baselined 0, already recorded 0; schema at 20261102000000$/);
  });

  it("a second run skips what is recorded and applies only the new file", async () => {
    const db = new FakeDb();
    await runMigrations({ session: db, files: files("20261101000000"), probes: {}, ...quiet });
    const out = await runMigrations({ session: db, files: files("20261101000000", "20261103000000"), probes: {}, ...quiet });
    expect(db.ran).toEqual(["20261101000000", "20261103000000"]);
    expect(out.alreadyRecorded).toEqual(["20261101000000"]);
    expect(out.applied).toEqual(["20261103000000"]);
  });

  it("an edited, already-recorded file fails loudly and nothing runs", async () => {
    const db = new FakeDb();
    await runMigrations({ session: db, files: files("20261101000000"), probes: {}, ...quiet });
    const edited = parseMigrationFiles([
      { file: "20261101000000_step_00.sql", sql: "-- changed after it ran" },
      { file: "20261103000000_step_00.sql", sql: "select 1;" },
    ]);
    await expect(runMigrations({ session: db, files: edited, probes: {}, ...quiet })).rejects.toThrow(/checksum differs\): 20261101000000_step_00\.sql/);
    expect(db.ran).toEqual(["20261101000000"]);
    expect(db.locked).toBe(false);
  });

  it("baselines hand-applied files whose objects exist, runs the ones that are missing", async () => {
    // Both regions on Oct 29: everything through 20261019150000 by hand, then two files not yet.
    const db = new FakeDb();
    const all = files("20261017000100", "20261019150000", "20261022000000", "20261029130000");
    const probes = { "20261017000100": "p1", "20261019150000": "p2", "20261022000000": "p3", "20261029130000": "p4" };
    db.present = new Set(["p1", "p2"]);
    const out = await runMigrations({ session: db, files: all, probes, ...quiet });
    expect(out.baselined).toEqual(["20261017000100", "20261019150000"]);
    expect(out.applied).toEqual(["20261022000000", "20261029130000"]);
    expect(db.ran).toEqual(["20261022000000", "20261029130000"]);
    expect(db.rows.get("20261017000100")?.how).toBe("baselined");
    expect(db.rows.get("20261029130000")?.how).toBe("applied");
    // Probes are only consulted for unrecorded files: once recorded, a file is never probed or run again.
    db.present = new Set();
    const again = await runMigrations({ session: db, files: all, probes, ...quiet });
    expect(again.alreadyRecorded).toHaveLength(4);
    expect(db.ran).toEqual(["20261022000000", "20261029130000"]);
  });

  it("a file without a probe always runs, even when objects look present", async () => {
    const db = new FakeDb();
    db.present = new Set(["p"]);
    const out = await runMigrations({ session: db, files: files("20261101000000"), probes: {}, ...quiet });
    expect(out.applied).toEqual(["20261101000000"]);
  });

  it("a failing file stops the run: earlier files stay recorded, later ones do not run, the lock is released", async () => {
    const db = new FakeDb();
    db.failOn = "20261102000000";
    await expect(runMigrations({ session: db, files: files("20261101000000", "20261102000000", "20261103000000"), probes: {}, ...quiet })).rejects.toThrow(/relation already exists/);
    expect(db.ran).toEqual(["20261101000000"]);
    expect([...db.rows.keys()]).toEqual(["20261101000000"]);
    expect(db.locked).toBe(false);
  });

  it("waits while another migrator holds the lock, then proceeds", async () => {
    const db = new FakeDb();
    db.lockedByOther = 2;
    const lines: string[] = [];
    const out = await runMigrations({ session: db, files: files("20261101000000"), probes: {}, log: (l) => lines.push(l), sleep: quiet.sleep });
    expect(out.applied).toEqual(["20261101000000"]);
    expect(lines.filter((l) => l.includes("another migrator holds the lock"))).toHaveLength(2);
  });

  it("gives up loudly when the lock stays held past the wait, having run nothing", async () => {
    const db = new FakeDb();
    db.lockedByOther = Number.POSITIVE_INFINITY;
    let t = 0;
    await expect(
      runMigrations({ session: db, files: files("20261101000000"), probes: {}, ...quiet, lockWaitMs: 10_000, lockPollMs: 2_000, now: () => t, sleep: async (ms) => void (t += ms) }),
    ).rejects.toThrow(/held the lock for 10 s; nothing was applied/);
    expect(db.ran).toEqual([]);
    expect(db.unlocks).toBe(0);
  });

  it("a file recorded by another migrator meanwhile is skipped, not run twice", async () => {
    const db = new FakeDb();
    db.raceOn = "20261101000000";
    const out = await runMigrations({ session: db, files: files("20261101000000"), probes: {}, ...quiet });
    expect(db.ran).toEqual([]);
    expect(out.alreadyRecorded).toEqual(["20261101000000"]);
  });

  it("refuses a new file that sorts before one already recorded", async () => {
    const db = new FakeDb();
    await runMigrations({ session: db, files: files("20261105000000"), probes: {}, ...quiet });
    await expect(runMigrations({ session: db, files: files("20261101000000", "20261105000000"), probes: {}, ...quiet })).rejects.toThrow(/sort before 20261105000000/);
  });

  it("an older image (rollback) on a newer database warns and succeeds without running anything", async () => {
    const db = new FakeDb();
    await runMigrations({ session: db, files: files("20261101000000", "20261102000000"), probes: {}, ...quiet });
    const lines: string[] = [];
    const out = await runMigrations({ session: db, files: files("20261101000000"), probes: {}, log: (l) => lines.push(l), sleep: quiet.sleep });
    expect(out.applied).toEqual([]);
    expect(out.schema).toBe("20261102000000");
    expect(lines.some((l) => l.includes("warning: the database has 20261102000000"))).toBe(true);
  });

  it("a dry run reports the plan and writes nothing, not even the tracking table", async () => {
    const db = new FakeDb();
    db.present = new Set(["p1"]);
    const lines: string[] = [];
    const out = await runMigrations({ session: db, files: files("20261017000100", "20261022000000"), probes: { "20261017000100": "p1", "20261022000000": "p2" }, dryRun: true, log: (l) => lines.push(l), sleep: quiet.sleep });
    expect(out).toMatchObject({ baselined: ["20261017000100"], applied: ["20261022000000"], dryRun: true });
    expect(db.tracking).toBe(false);
    expect(db.rows.size).toBe(0);
    expect(lines).toContain("[migrate] would apply 20261022000000_step_00.sql");
  });
});
