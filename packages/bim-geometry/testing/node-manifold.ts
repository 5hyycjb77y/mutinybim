import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ManifoldToplevel } from "manifold-3d";
import { createManifoldEngine } from "../src/manifold-engine";
import type { SolidEngine } from "../src/program";

type ManifoldFactory = () => Promise<ManifoldToplevel>;

function extractFactory(mod: unknown): ManifoldFactory {
  if (typeof mod === "function") return mod as ManifoldFactory;
  if (mod && typeof mod === "object" && "default" in mod && typeof (mod as { default: unknown }).default === "function") {
    return (mod as { default: ManifoldFactory }).default;
  }
  throw new Error("manifold-3d module did not export a default initializer");
}

/**
 * manifold-3d for Node test runs.
 *
 * When Jest maps and transforms `manifold-3d` (as MutinyBIM's `jest.config.cjs`
 * does via `esbuild-transform.cjs`, rewriting `import.meta.url`), a plain
 * `require("manifold-3d")` works under both Node 22 and Jest 30.5+. In hosts
 * that don't map `manifold-3d` through Jest's transform, we fall back to Node's
 * native `createRequire` directly on `manifold.js`.
 */
let loaded: Promise<SolidEngine> | null = null;

export function nodeManifoldEngine(): Promise<SolidEngine> {
  loaded ??= (async () => {
    let factory: ManifoldFactory;
    try {
      factory = extractFactory(require("manifold-3d"));
    } catch {
      const nodeModule: typeof import("node:module") = process.getBuiltinModule("node:module");
      const req = nodeModule.createRequire(__filename);
      const file = (req.resolve.paths("manifold-3d") ?? []).map((d) => join(d, "manifold-3d", "manifold.js")).find((f) => existsSync(f));
      if (!file) throw new Error("manifold-3d is not installed; run npm install");
      factory = extractFactory(req(file));
    }
    const wasm = await factory();
    wasm.setup();
    return createManifoldEngine(wasm);
  })();
  return loaded;
}
