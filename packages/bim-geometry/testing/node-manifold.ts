import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ManifoldToplevel } from "manifold-3d";
import { createManifoldEngine } from "../src/manifold-engine";
import type { SolidEngine } from "../src/program";

/**
 * manifold-3d for Node test runs. Jest's own module system can't load an ES
 * module that finds its WASM through `import.meta.url`, so this goes through
 * Node's loader directly (Node 22 loads ES modules with `require`).
 */
let loaded: Promise<SolidEngine> | null = null;

export function nodeManifoldEngine(): Promise<SolidEngine> {
  loaded ??= (async () => {
    const nodeModule: typeof import("node:module") = process.getBuiltinModule("node:module");
    const req = nodeModule.createRequire(__filename);
    const file = (req.resolve.paths("manifold-3d") ?? []).map((d) => join(d, "manifold-3d", "manifold.js")).find((f) => existsSync(f));
    if (!file) throw new Error("manifold-3d is not installed; run npm install");
    const mod = req(file) as { default: () => Promise<ManifoldToplevel> };
    const wasm = await mod.default();
    wasm.setup();
    return createManifoldEngine(wasm);
  })();
  return loaded;
}
