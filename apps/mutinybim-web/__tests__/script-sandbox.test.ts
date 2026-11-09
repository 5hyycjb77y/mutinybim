/**
 * @jest-environment node
 *
 * The sealed script box on the hosted server: every flag that seals it (no
 * network, an empty environment, nobody's user, only /usr and the runner,
 * read-only), the check that refuses an unsealed box, one run at a time per
 * person with a short queue, and on a Linux machine with bubblewrap a real
 * script run inside the box (skipped elsewhere).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { KIT_ENTRIES, SLICE_FORMAT, type ModelSlice, type ScriptRunResult } from "@permitzip/bim-script";
import { buildScriptRunner } from "@permitzip/bim-script-runner";
import { limitArgs, probeProblem, sandboxArgs, ScriptSandbox } from "../src/script-sandbox";

const EMPTY: ModelSlice = { format: SLICE_FORMAT, version: 1, modelId: "none", revision: 0, reads: {}, selection: [], elements: {}, connections: [], settings: DEFAULT_SETTINGS, features: [] };
const SEALED = { interfaces: [], uid: 65534, env: [], wrote: false, reached: false, runner: true };

describe("script-sandbox", () => {
  it("seals the box: its own network and user, no environment, only /usr and the runner, read-only", () => {
    const args = sandboxArgs({ runnerDir: "/usr/local/lib/mutinybim/script-runner", requestFile: "/tmp/req.json" });
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--clearenv"]));
    expect(args).not.toContain("--share-net");
    expect(args.join(" ")).toContain("--uid 65534 --gid 65534");
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--ro-bind /usr /usr");
    expect(args.join(" ")).toContain("--ro-bind /usr/local/lib/mutinybim/script-runner /runner");
    expect(args.join(" ")).toContain("--ro-bind /tmp/req.json /request.json");
    // Nothing else of the machine is in the box, and nothing is bound writable.
    const binds = args.flatMap((a, i) => (a === "--ro-bind" || a === "--bind" ? [args[i + 1]] : []));
    expect(binds).toEqual(["/usr", "/usr/local/lib/mutinybim/script-runner", "/tmp/req.json"]);
    expect(args).not.toContain("--bind");
    expect(limitArgs({ memoryMb: 1024, wallMs: 30_000, outputBytes: 2 * 1024 * 1024 })).toEqual(["--cpu=45", "--nofile=256", "--core=0"]);
  });

  it("refuses a box that isn't sealed", () => {
    expect(probeProblem(SEALED, 10001)).toBeNull();
    expect(probeProblem({ ...SEALED, reached: true }, 10001)).toContain("internet");
    expect(probeProblem({ ...SEALED, interfaces: ["eth0"] }, 10001)).toContain("network");
    expect(probeProblem({ ...SEALED, wrote: true }, 10001)).toContain("write");
    expect(probeProblem({ ...SEALED, env: ["MUTINYBIM_WEB_DATA"] }, 10001)).toContain("settings");
    expect(probeProblem({ ...SEALED, uid: 10001 }, 10001)).toContain("real user");
    expect(probeProblem({ ...SEALED, uid: 0 }, 10001)).toContain("real user");
  });

  it("runs one script at a time per person, others in parallel, and refuses past a short queue", async () => {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const box = new ScriptSandbox({
      runnerDir: "/nowhere",
      workDir: os.tmpdir(),
      maxRunning: 2,
      maxWaitingPerPerson: 1,
      runOne: (request) =>
        new Promise<ScriptRunResult>((resolve) => {
          started.push(request.scriptHash);
          finish.set(request.scriptHash, () => resolve({ ok: true, output: { kind: "edits" }, bytes: 1, ms: 1 }));
        }),
    });
    const run = (user: string, hash: string) => box.run(user, { source: "", scriptHash: hash, values: {}, slice: EMPTY });
    const a1 = run("sam", "a1");
    const a2 = run("sam", "a2");
    const b1 = run("pat", "b1");
    expect(await run("sam", "a3")).toMatchObject({ ok: false, code: "runner_error", message: expect.stringContaining("running and waiting") });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a1", "b1"]);
    finish.get("a1")?.();
    await a1;
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a1", "b1", "a2"]);
    finish.get("a2")?.();
    finish.get("b1")?.();
    await Promise.all([a2, b1]);
  });

  const linuxBox = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/prlimit") && process.execPath.startsWith("/usr/");
  (linuxBox ? it : it.skip)("on Linux with bubblewrap: the box is sealed and runs a part script", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-box-"));
    try {
      const runnerDir = path.join(dir, "runner");
      await buildScriptRunner(runnerDir, path.resolve(__dirname, "../../.."));
      const box = new ScriptSandbox({ runnerDir, workDir: path.join(dir, "requests") });
      expect(await box.availability()).toEqual({ ok: true });
      const part = KIT_ENTRIES.find((e) => e.name === "PartBuilder.connector")?.example ?? "";
      const result = await box.run("sam", { source: part, scriptHash: "sha256:box", values: {}, slice: EMPTY });
      expect(result).toMatchObject({ ok: true, output: { kind: "part_types" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  (process.platform === "linux" ? it.skip : it)("elsewhere: scripts are refused in words, never run unsealed", async () => {
    const box = new ScriptSandbox({ runnerDir: "/nowhere", workDir: os.tmpdir() });
    expect(await box.availability()).toEqual({ ok: false, reason: expect.stringContaining("Linux") });
  });
});
