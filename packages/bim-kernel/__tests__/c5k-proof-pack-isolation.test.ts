/**
 * @jest-environment node
 *
 * The proof pack (civil; Structural is first-party since round 14) is built
 * only through the add-on contract (STATUS "Proof rule for 5c-6 and 5c-7"): it imports
 * `@permitzip/bim-pack`, `@permitzip/bim-units`, zod and the kernel's
 * published subpaths, never a package's `src`, never another BIM package
 * directly, never a host app. The kernel imports no pack. The per-commit half
 * of the rule (a commit touching a proof pack touches no kernel file) is
 * `scripts/bim/check-proof-pack-commits.sh` in the PR lint workflow.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const PROOF_PACKS = ["bim-pack-civil"] as const;
const IMPORT_RE = /^\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const DYNAMIC_RE = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules") out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT_RE), ...text.matchAll(DYNAMIC_RE)].map((m) => m[1] ?? "").filter(Boolean);
}

function publishedSubpaths(pkgName: "bim-kernel" | "bim-pack"): Set<string> {
  const pkg: unknown = JSON.parse(readFileSync(path.join(ROOT, `packages/${pkgName}/package.json`), "utf8"));
  const exportsField = typeof pkg === "object" && pkg !== null && "exports" in pkg ? (pkg as { exports: unknown }).exports : {};
  const keys = typeof exportsField === "object" && exportsField !== null ? Object.keys(exportsField) : ["."];
  return new Set(keys.map((k) => (k === "." ? `@permitzip/${pkgName}` : `@permitzip/${pkgName}/${k.replace(/^\.\//, "")}`)));
}

/**
 * The contract surface: `@permitzip/bim-pack`'s published entries (the root,
 * and since round 11 R11-pre `/runtime`, the run-time half an add-on imports
 * so the author tools stay off the first download), bim-units, zod and the
 * kernel's published subpaths. A package's `src` or an unpublished subpath
 * still fails.
 */
function contractSurface(): Set<string> {
  return new Set([...publishedSubpaths("bim-pack"), ...publishedSubpaths("bim-kernel"), "@permitzip/bim-units", "zod"]);
}

function allowed(spec: string, file: string, packDir: string, contract: Set<string>): boolean {
  if (spec.startsWith(".")) return path.resolve(path.dirname(file), spec).startsWith(packDir + path.sep);
  if (contract.has(spec)) return true;
  // Tests may read their own fixtures from disk.
  return file.includes(`${path.sep}__tests__${path.sep}`) && (spec.startsWith("node:") || spec === "@jest/globals");
}

describe("proof packs build only through the add-on contract", () => {
  const contract = contractSurface();

  it.each(PROOF_PACKS)("%s exists, is Apache-2.0, and imports only the contract surface", (name) => {
    const packDir = path.join(ROOT, "packages", name);
    expect(existsSync(path.join(packDir, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(path.join(packDir, "package.json"), "utf8")) as { license?: string; dependencies?: Record<string, string> };
    expect(pkg.license).toBe("Apache-2.0");
    const files = sourceFiles(packDir);
    expect(files.length).toBeGreaterThan(0);
    const offending = files.flatMap((f) => specifiers(f).filter((s) => !allowed(s, f, packDir, contract)).map((s) => `${path.relative(ROOT, f)}: ${s}`));
    expect(offending).toEqual([]);
  });

  it("the contract surface is the published entries, nothing past them", () => {
    const file = path.join(ROOT, "packages/bim-pack-civil/src/pack.ts");
    const packDir = path.join(ROOT, "packages/bim-pack-civil");
    expect(allowed("@permitzip/bim-pack/runtime", file, packDir, contract)).toBe(true);
    expect(allowed("@permitzip/bim-pack/src/runtime", file, packDir, contract)).toBe(false);
    expect(allowed("@permitzip/bim-pack/harness", file, packDir, contract)).toBe(false);
    expect(allowed("@permitzip/bim-calc", file, packDir, contract)).toBe(false);
    expect(allowed("@permitzip/bim-kernel/src/validate", file, packDir, contract)).toBe(false);
  });

  it("Civil is still a proof pack: not first-party, and refused if it reached for another add-on", () => {
    const manifests = readFileSync(path.join(ROOT, "packages/bim-kernel/src/packs/first-party/manifests.ts"), "utf8");
    expect(manifests).not.toMatch(/id: "civil"/);
    const file = path.join(ROOT, "packages/bim-pack-civil/src/pack.ts");
    const packDir = path.join(ROOT, "packages/bim-pack-civil");
    expect(allowed("@permitzip/bim-pack-structural", file, packDir, contract)).toBe(false);
    expect(allowed("@permitzip/bim-first-party", file, packDir, contract)).toBe(false);
    expect(allowed("../../bim-pack-structural/src", file, packDir, contract)).toBe(false);
  });

  it("the kernel imports no pack", () => {
    const files = sourceFiles(path.join(ROOT, "packages/bim-kernel/src"));
    const offending = files.flatMap((f) => specifiers(f).filter((s) => /^@permitzip\/bim-pack(?:-|\/|$)/.test(s)).map((s) => `${path.relative(ROOT, f)}: ${s}`));
    expect(offending).toEqual([]);
  });
});
