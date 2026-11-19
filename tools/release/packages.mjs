// The packages a release publishes: every workspace under packages/ plus the
// model server. One version for all of them (the release tag, without its "v").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REGISTRY = "https://npm.pkg.github.com";

export function publishableDirs(root = ROOT) {
  const packages = fs
    .readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((d) => {
      if (!d.isDirectory()) return false;
      const manifestPath = path.join(root, "packages", d.name, "package.json");
      if (!fs.existsSync(manifestPath)) return false;
      return JSON.parse(fs.readFileSync(manifestPath, "utf8")).private !== true;
    })
    .map((d) => `packages/${d.name}`)
    .sort();
  return [...packages, "services/bim-authority"];
}

export const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
export const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
