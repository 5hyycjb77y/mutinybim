#!/usr/bin/env node
// npm run example -- <name | path/to/script.ts> [--out <dir>]
//
// Runs an example script (packages/bim-script/examples/<name>.ts, or any
// script file) the way an agent does: bim_check_output → bim_run_script →
// bim_apply_output, through the core tools, against a fresh empty model.
// Saves the model it made to <out>/<name>.model.json (default
// ./mutinybim-examples) and prints what it built. The script runs in a local
// process with your permissions: run only scripts you trust.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const examplesDir = fileURLToPath(new URL("../../bim-script/examples", import.meta.url));
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir = path.resolve(outAt >= 0 ? (args[outAt + 1] ?? "mutinybim-examples") : "mutinybim-examples");
const target = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--out"));
const names = (await readdir(examplesDir)).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)).sort();

if (!target) {
  process.stderr.write(`usage: npm run example -- <name> [--out <dir>]\nexamples: ${names.join(", ")}\n`);
  process.exit(2);
}
const file = names.includes(target) ? path.join(examplesDir, `${target}.ts`) : path.resolve(target);
const name = path.basename(file).replace(/\.ts$/, "");
let source;
try {
  source = await readFile(file, "utf8");
} catch {
  process.stderr.write(`No example "${target}". Examples: ${names.join(", ")}, or give a path to a script file.\n`);
  process.exit(2);
}

const { runExample } = await import(new URL("../src/examples.ts", import.meta.url).href);
try {
  const started = Date.now();
  const run = await runExample(source, { repoRoot, modelId: name });
  await mkdir(outDir, { recursive: true });
  const saved = path.join(outDir, `${name}.model.json`);
  await writeFile(saved, `${JSON.stringify(run.model, null, 2)}\n`);
  const kinds = Object.entries(run.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
  process.stdout.write(`${name}: ${run.label}\n  ${run.steps} edits, applied in one approval (${((Date.now() - started) / 1000).toFixed(1)} s)\n  the model now has: ${kinds}\n  saved: ${saved}\n`);
} catch (err) {
  process.stderr.write(`${name} didn't run: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
