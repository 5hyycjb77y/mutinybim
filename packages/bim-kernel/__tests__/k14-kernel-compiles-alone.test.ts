/**
 * @jest-environment node
 *
 * Round 14 guard (K14 step 5): the kernel compiles with no add-on in the
 * build. `packages/tsconfig.k14-kernel-alone.json` maps only the kernel and
 * the generic libraries it builds on (units, formulas, geometry) and lists
 * only the kernel's entry points, so an add-on's `AddOnElementTypes` never
 * joins the program and kernel code that narrows on an add-on's kind fails
 * to compile there.
 *
 * This file checks the config's shape and that no kernel source imports an
 * add-on. The compile itself (`tsc -p packages/tsconfig.k14-kernel-alone.json`,
 * ~10 s and ~1.5 GB) runs in CI typecheck, not in a Jest worker.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.join(__dirname, "..", "..");
const SRC = path.join(__dirname, "..", "src");
const ALONE = path.join(PACKAGES, "tsconfig.k14-kernel-alone.json");
const FULL = path.join(PACKAGES, "tsconfig.bim.json");
const KERNEL_AND_LIBRARIES = /^@permitzip\/bim-(kernel|units|formula|geometry)(\/|$)/;

interface TsConfig {
  readonly extends?: string;
  readonly include?: readonly string[];
  readonly files?: readonly string[];
  readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> };
}

const isConfig = (v: unknown): v is TsConfig => typeof v === "object" && v !== null && !Array.isArray(v);

function readConfig(file: string): TsConfig {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isConfig(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the kernel compiles alone", () => {
  const alone = readConfig(ALONE);
  const full = readConfig(FULL);
  const paths = alone.compilerOptions?.paths ?? {};

  it("maps only the kernel and the libraries it builds on", () => {
    expect(alone.extends).toBe("./tsconfig.bim.json");
    expect(Object.keys(paths).filter((k) => !KERNEL_AND_LIBRARIES.test(k))).toEqual([]);
    // Every kernel alias the full build maps, so a kernel file importing its own subpath still resolves.
    const kernelAliases = Object.keys(full.compilerOptions?.paths ?? {}).filter((k) => KERNEL_AND_LIBRARIES.test(k)).sort();
    expect(Object.keys(paths).sort()).toEqual(kernelAliases);
  });

  it("compiles only kernel entry points, nothing an include could widen", () => {
    expect(alone.include).toEqual([]);
    const files = alone.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f.startsWith("./bim-kernel/src/")).toBe(true);
    expect(files).toContain("./bim-kernel/src/index.ts");
    expect(files).toContain("./bim-kernel/src/types.ts");
  });

  it("no kernel source imports an add-on or a host package", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(@permitzip\/[^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (!KERNEL_AND_LIBRARIES.test(spec)) hits.push(`${path.relative(SRC, file)}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
