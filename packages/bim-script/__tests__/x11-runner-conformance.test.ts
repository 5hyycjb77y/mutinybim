/**
 * @jest-environment node
 *
 * Round 11 lane X11: the ScriptRunner contract's conformance suite. A runner
 * that meets the contract passes every check; one that hands scripts the
 * network fails `no_network`, whatever it reports. Fails on round 10's code
 * (no kit, no contract).
 *
 * The runners here are the test-only reference runner (`support/process-runner.ts`).
 * The raised-heap case runs it inside a host started the way CI's Unit Tests job
 * starts node (`--max-old-space-size=8192`); a worker-thread runner inherits that
 * heap and its memory cap stops working, so the probe only ends on the clock.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONFORMANCE_PROBES, runRunnerConformance, type ConformanceTargets, type RunnerLimits, type ScriptRunResult } from "../src";
import { ProcessRunner } from "./support/process-runner";

const ROOT = resolve(__dirname, "../../..");
const RAISED_HEAP = "--max-old-space-size=8192";

describe("x11-runner-conformance", () => {
  let server: Server;
  let hits = 0;
  let dir = "";
  let targets: ConformanceTargets;
  const LIMITS: RunnerLimits = { memoryMb: 64, wallMs: 1500, outputBytes: 256 * 1024 };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "x11-conf-"));
    writeFileSync(join(dir, "secret.txt"), "x11-secret-7f3a");
    server = createServer((_req, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    targets = {
      url: `http://127.0.0.1:${port}/probe`,
      contacted: () => hits > 0,
      secretPath: join(dir, "secret.txt"),
      secret: "x11-secret-7f3a",
      markerPath: join(dir, "marker"),
      markerExists: () => existsSync(join(dir, "marker")),
    };
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    hits = 0;
  });

  it("a runner that meets the contract passes every check", async () => {
    const results = await runRunnerConformance(new ProcessRunner(LIMITS), targets);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.check)).toEqual(["limits", "fresh_process", "deterministic", "no_network", "no_files", "no_child_processes", "output_cap", "memory_cap", "time_cap"]);
  }, 60_000);

  it("the memory cap holds when the host runs with a raised heap", () => {
    const out = execFileSync(process.execPath, [RAISED_HEAP, "--import", "tsx", "packages/bim-script/__tests__/support/raised-heap-host.ts"], {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: RAISED_HEAP },
      input: CONFORMANCE_PROBES.memory,
      encoding: "utf8",
      timeout: 60_000,
    });
    const { hostHeapMb, result } = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { hostHeapMb: number; result: ScriptRunResult };
    expect(hostHeapMb).toBeGreaterThan(4096);
    expect(result).toMatchObject({ ok: false, code: "cap_memory" });
  }, 60_000);

  it("a runner that allows the network fails it", async () => {
    const results = await runRunnerConformance(new ProcessRunner(LIMITS, true), targets);
    const net = results.find((r) => r.check === "no_network");
    expect(net?.ok).toBe(false);
    expect(net?.detail).toMatch(/the script reached http:\/\/127.0.0.1/);
  }, 60_000);

  it("a runner whose caps are over the contract fails the limits check", async () => {
    const results = await runRunnerConformance(new ProcessRunner({ ...LIMITS, outputBytes: 3 * 1024 * 1024 }), targets);
    expect(results.find((r) => r.check === "limits")?.ok).toBe(false);
  }, 60_000);
});
