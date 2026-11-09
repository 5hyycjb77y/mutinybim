/**
 * @jest-environment node
 *
 * c6x-no-addon-cycle: the shared packages the add-ons build on never import an
 * add-on (by name or by a relative path into one). Before round 6 lane X,
 * bim-lint's electrical, plumbing, drainage and load rules imported
 * `@permitzip/bim-pack-electrical` / `-plumbing` while those import
 * `@permitzip/bim-pack`, which imports bim-lint: a runtime cycle.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(__dirname, "../..");
const SHARED = ["bim-lint", "bim-calc", "bim-library", "bim-sheets", "bim-pack", "bim-kernel", "bim-sync", "bim-units", "bim-formula", "bim-geometry"];
const ADDONS = ["bim-pack-electrical", "bim-pack-plumbing", "bim-pack-mechanical", "bim-pack-structural", "bim-pack-civil", "bim-first-party"];
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
const BY_NAME = new RegExp(`^@permitzip/(?:${ADDONS.join("|")})(?:/|$)`);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function intoAddon(file: string, spec: string): boolean {
  if (BY_NAME.test(spec)) return true;
  if (!spec.startsWith(".")) return false;
  const [top] = path.relative(PACKAGES, path.resolve(path.dirname(file), spec)).split(path.sep);
  return top !== undefined && ADDONS.includes(top);
}

describe("c6x-no-addon-cycle", () => {
  it("no shared package's source imports an add-on", () => {
    const offenders = SHARED.flatMap((pkg) => {
      const files = sourceFiles(path.join(PACKAGES, pkg, "src"));
      expect(files.length).toBeGreaterThan(0);
      return files.flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(IMPORT_RE)].flatMap((m) => {
          const spec = m[1] ?? m[2] ?? "";
          return intoAddon(file, spec) ? [`${path.relative(PACKAGES, file)} imports ${spec}`] : [];
        }),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the check catches what it must", () => {
    const lintFile = path.join(PACKAGES, "bim-lint", "src", "rules", "packs", "x.ts");
    for (const spec of ["@permitzip/bim-pack-electrical", "@permitzip/bim-pack-plumbing/src/x", "@permitzip/bim-first-party", "../../../../bim-pack-mechanical/src/lint/balance"]) expect(intoAddon(lintFile, spec)).toBe(true);
    for (const spec of ["@permitzip/bim-pack", "@permitzip/bim-kernel", "../format", "../../../../bim-kernel/src/questions"]) expect(intoAddon(lintFile, spec)).toBe(false);
  });
});
