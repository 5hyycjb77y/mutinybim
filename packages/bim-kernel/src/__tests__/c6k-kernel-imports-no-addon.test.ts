/**
 * @jest-environment node
 *
 * Round 6 lane K, the CI half of eslint's boundary: kernel source imports no
 * add-on package (`@permitzip/bim-pack*`) and not the first-party list
 * (`@permitzip/bim-first-party`). Add-ons build on the kernel; never the
 * other way round.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN = /^@permitzip\/(?:bim-pack(?:-[a-z0-9-]+)?|bim-first-party)(?:\/|$)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("c6k kernel imports no add-on", () => {
  it("no kernel source file imports @permitzip/bim-pack* or @permitzip/bim-first-party", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(IMPORT_RE)].flatMap((m) => {
        const spec = m[1] ?? m[2] ?? "";
        return FORBIDDEN.test(spec) ? [`${path.relative(SRC, file)} imports ${spec}`] : [];
      }),
    );
    expect(offenders).toEqual([]);
  });

  it("the pattern catches what it must", () => {
    for (const spec of ["@permitzip/bim-pack", "@permitzip/bim-pack-electrical", "@permitzip/bim-pack/harness", "@permitzip/bim-first-party"]) expect(FORBIDDEN.test(spec)).toBe(true);
    for (const spec of ["@permitzip/bim-units", "@permitzip/bim-packing", "./packs/set"]) expect(FORBIDDEN.test(spec)).toBe(false);
  });
});
