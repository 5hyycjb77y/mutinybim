/**
 * A host for the reference runner, started by x11-runner-conformance with a
 * raised heap (`--max-old-space-size` on its argv and in NODE_OPTIONS, as CI's
 * Unit Tests job runs). Reads a probe's source on stdin, runs it once and
 * prints `{ hostHeapMb, result }` as one JSON line.
 */
import { getHeapStatistics } from "node:v8";
import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { SLICE_FORMAT, type ModelSlice } from "../../src/slice";
import { ProcessRunner } from "./process-runner";

const LIMITS = { memoryMb: 64, wallMs: 1500, outputBytes: 256 * 1024 };
const SLICE: ModelSlice = { format: SLICE_FORMAT, version: 1, modelId: "host", revision: 1, reads: {}, selection: [], elements: {}, connections: [], settings: DEFAULT_SETTINGS, features: [] };

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  source += chunk;
});
process.stdin.on("end", () => {
  new ProcessRunner(LIMITS)
    .run({ source, scriptHash: `sha256:${"0".repeat(64)}`, values: {}, slice: SLICE })
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ hostHeapMb: getHeapStatistics().heap_size_limit / 1048576, result })}\n`);
    })
    .catch((err: unknown) => {
      console.error("[raised-heap-host] run failed", err);
      process.exitCode = 1;
    });
});
