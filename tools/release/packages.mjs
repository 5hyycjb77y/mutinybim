// The packages a release publishes: every workspace under packages/ plus the
// model server. One version for all of them (the release tag, without its "v").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REGISTRY = "https://npm.pkg.github.com";

export function publishableDirs() {
  const packages = fs
    .readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, "packages", d.name, "package.json")))
    .map((d) => `packages/${d.name}`)
    .sort();
  return [...packages, "services/bim-authority"];
}

export const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
