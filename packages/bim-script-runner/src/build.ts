/**
 * Bundles the script runner: `script-runner.cjs` (no dependencies) and
 * `script-child.cjs` (the kit, kernel, library, units, zod and the add-ons it
 * carries, `addons.ts`, inside). A sealed host bakes the output directory into
 * its image, root-owned; `LocalScriptRunner` builds it once into a cache
 * directory.
 *
 *   node --import tsx packages/bim-script-runner/src/build.ts <out-dir>   (from the checkout root)
 */
import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCRIPT_CHILD_FILE, SCRIPT_RUNNER_FILE } from "./protocol";

const HERE = "packages/bim-script-runner/src";

export interface BuildScriptRunnerOptions {
  /** A path map for the kit, kernel and add-ons; default: the checkout's tsconfig.json when it has one. */
  readonly tsconfig?: string | null;
}

/** `repoRoot`: the checkout holding `packages/` (the kit resolves through its path map, else its node_modules links). */
export async function buildScriptRunner(outDir: string, repoRoot = process.cwd(), options: BuildScriptRunnerOptions = {}): Promise<{ runner: string; child: string }> {
  mkdirSync(outDir, { recursive: true });
  const runner = join(outDir, SCRIPT_RUNNER_FILE);
  const child = join(outDir, SCRIPT_CHILD_FILE);
  const common = { bundle: true, platform: "node", format: "cjs", target: "node22", logLevel: "error", legalComments: "none", absWorkingDir: repoRoot } as const;
  await build({ ...common, entryPoints: [join(repoRoot, HERE, "supervisor.ts")], outfile: runner });
  // The checkout's own path map, so the kit, kernel and add-ons bundled are this checkout's (a worktree's node_modules links can lead to another checkout's packages).
  const rootConfig = join(repoRoot, "tsconfig.json");
  const tsconfig = options.tsconfig === undefined ? (existsSync(rootConfig) ? rootConfig : null) : options.tsconfig;
  await build({ ...common, entryPoints: [join(repoRoot, HERE, "child.ts")], outfile: child, ...(tsconfig ? { tsconfig } : {}) });
  return { runner, child };
}

if (process.argv[1]?.endsWith(`${HERE}/build.ts`)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: build.ts <out-dir>");
    process.exitCode = 2;
  } else {
    buildScriptRunner(resolve(out))
      .then((files) => console.log(`[script-runner] built ${files.runner} and ${files.child}`))
      .catch((err: unknown) => {
        console.error("[script-runner] build failed", err);
        process.exitCode = 1;
      });
  }
}
