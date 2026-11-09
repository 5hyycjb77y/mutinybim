/**
 * @jest-environment node
 *
 * Every merge to main whose CI passes is a release (.github/workflows/release.yml):
 * one patch above the newest tag, unless the manifests were set higher by hand,
 * never twice for one commit, and never for a commit that is not on main.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nextVersion } from "../versions.mjs";

const SCRIPT = resolve(__dirname, "../next-version.mjs");
// The throwaway repository ignores this machine's git config (commit and tag signing would wait for a passphrase).
const GIT_ENV = { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

describe("nextVersion", () => {
  it("the first release is the manifests' version", () => {
    expect(nextVersion({ tags: [], manifestVersion: "0.2.0" })).toBe("0.2.0");
  });

  it("then one patch above the newest tag, whatever order the tags come in", () => {
    expect(nextVersion({ tags: ["v0.2.0", "v0.2.10", "v0.2.9"], manifestVersion: "0.2.0" })).toBe("0.2.11");
  });

  it("a version set higher by hand wins; pre-release and stray tags are ignored", () => {
    expect(nextVersion({ tags: ["v0.2.4", "v0.3.0-rc.1", "latest"], manifestVersion: "0.3.0" })).toBe("0.3.0");
    expect(nextVersion({ tags: ["v0.3.0"], manifestVersion: "0.3.0" })).toBe("0.3.1");
  });

  it("refuses manifests without a plain version", () => {
    expect(() => nextVersion({ tags: [], manifestVersion: "next" })).toThrow(/major.minor.patch/);
  });
});

describe("next-version.mjs on a repository", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();
  const commit = (version: string, message: string) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mutinybim", version }));
    git("add", "package.json");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const run = (env: Record<string, string>) => {
    const r = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...GIT_ENV, ...env } });
    return { status: r.status, out: Object.fromEntries(r.stdout.trim().split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string])), err: r.stderr };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "next-version-"));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a merge after v0.2.0 is v0.2.1, and the same commit is not released twice", () => {
    commit("0.2.0", "first");
    git("tag", "v0.2.0");
    const sha = commit("0.2.0", "second");
    git("update-ref", "refs/remotes/origin/main", sha);
    expect(run({ EVENT: "workflow_run", RUN_SHA: sha })).toMatchObject({ status: 0, out: { release: "true", version: "0.2.1", sha, tagged: "false", publish: "false" } });
    git("tag", "v0.2.1", sha);
    expect(run({ EVENT: "workflow_run", RUN_SHA: sha }).out).toMatchObject({ release: "false", version: "0.2.1" });
  });

  it("publishing follows MUTINYBIM_PUBLISH; a pushed tag keeps its own version", () => {
    const sha = commit("0.2.0", "first");
    git("update-ref", "refs/remotes/origin/main", sha);
    expect(run({ EVENT: "workflow_run", RUN_SHA: sha, PUBLISH: "true" }).out).toMatchObject({ version: "0.2.0", publish: "true" });
    git("tag", "v0.2.0", sha);
    expect(run({ EVENT: "push", REF_NAME: "v0.2.0" }).out).toMatchObject({ release: "true", version: "0.2.0", sha, tagged: "true" });
  });

  it("refuses a commit that is not on main", () => {
    const main = commit("0.2.0", "first");
    git("update-ref", "refs/remotes/origin/main", main);
    git("checkout", "-q", "-b", "side");
    const side = commit("0.2.0", "side");
    const r = run({ EVENT: "workflow_run", RUN_SHA: side });
    expect(r.status).toBe(1);
    expect(r.err).toContain("is not on main");
  });
});
