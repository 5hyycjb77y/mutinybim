/**
 * Builds the editor page bundle ahead of time (the container image does this
 * so the first visitor doesn't wait). The server builds it on start otherwise.
 *
 *   MUTINYBIM_WEB_BUILD=/app/editor-build node --import tsx apps/mutinybim-web/src/build-editor.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEditorDemo } from "../../../packages/bim-editor/demo/build";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MUTINYBIM_WEB_BUILD;
if (!outDir) {
  console.error("[mutinybim-web] set MUTINYBIM_WEB_BUILD to the folder the editor build goes in");
  process.exit(1);
}

buildEditorDemo({ entry: path.join(here, "../client/entry.tsx"), outDir: path.resolve(outDir) }).catch((err: unknown) => {
  console.error("[mutinybim-web] the editor build failed", err);
  process.exit(1);
});
