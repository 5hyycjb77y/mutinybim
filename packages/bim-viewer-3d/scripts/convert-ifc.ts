/**
 * Convert a fixture's IFC files to That Open Fragments once, cached by the IFC's
 * checksum, so the browser never parses IFC at runtime.
 *
 *   npx tsx packages/bim-viewer-3d/scripts/convert-ifc.ts <fixture export dir>
 *
 * Writes <export>/frags/<name>.frag and <export>/frags/index.json. The export
 * directory lives in the gitignored .fixtures-cache: client data never enters Git.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as FRAGS from "@thatopen/fragments";
import { configureIfcImporter } from "../src/ifc-import";

export interface FragIndexEntry {
  readonly ifcFile: string;
  readonly ifcSha256: string;
  readonly fragFile: string;
  readonly fragBytes: number;
  readonly convertMs: number;
}

// web-ifc no longer exports its package.json; its entry file sits beside the wasm.
const WASM_DIR = path.dirname(createRequire(import.meta.url).resolve("web-ifc")) + path.sep;

async function main() {
  const exportDir = process.argv[2];
  if (!exportDir) throw new Error("usage: convert-ifc.ts <fixture export dir>");
  const ifcDir = path.join(exportDir, "unpacked");
  const outDir = path.join(exportDir, "frags");
  mkdirSync(outDir, { recursive: true });
  const indexFile = path.join(outDir, "index.json");
  const previous: FragIndexEntry[] = existsSync(indexFile) ? parseIndex(readFileSync(indexFile, "utf8")) : [];

  const entries: FragIndexEntry[] = [];
  for (const name of readdirSync(ifcDir).filter((f) => f.toLowerCase().endsWith(".ifc"))) {
    const bytes = readFileSync(path.join(ifcDir, name));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const fragFile = `${name.replace(/\.ifc$/i, "")}.frag`;
    const cached = previous.find((e) => e.ifcSha256 === sha && existsSync(path.join(outDir, e.fragFile)));
    if (cached) {
      entries.push(cached);
      console.log(`[convert-ifc] cached ${name}`);
      continue;
    }
    const importer = configureIfcImporter(new FRAGS.IfcImporter());
    importer.wasm = { absolute: true, path: WASM_DIR };
    const t0 = performance.now();
    const frag = await importer.process({ bytes: new Uint8Array(bytes) });
    const convertMs = Math.round(performance.now() - t0);
    writeFileSync(path.join(outDir, fragFile), frag);
    entries.push({ ifcFile: name, ifcSha256: sha, fragFile, fragBytes: frag.byteLength, convertMs });
    console.log(`[convert-ifc] ${name}: ${(bytes.byteLength / 1e6).toFixed(1)} MB IFC -> ${(frag.byteLength / 1e6).toFixed(2)} MB frag in ${convertMs} ms`);
  }
  writeFileSync(indexFile, JSON.stringify(entries, null, 2));
}

function parseIndex(text: string): FragIndexEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (e): e is FragIndexEntry =>
      typeof e === "object" && e !== null && typeof e.ifcFile === "string" && typeof e.ifcSha256 === "string" && typeof e.fragFile === "string",
  );
}

main().catch((err) => {
  console.error("[convert-ifc] failed", err);
  process.exit(1);
});
