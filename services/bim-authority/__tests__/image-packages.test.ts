/**
 * @jest-environment node
 *
 * The model server's image carries every package its code reaches. CI and
 * deploy build the image from `stage.sh`'s context, and the Dockerfile copies
 * from that context, so a package missing from either list fails the build
 * (round 13: `bim-pack-architecture` was in the Dockerfile but not staged).
 * Every `@permitzip/*` package reachable from `src/` must be staged, copied
 * and mapped in `tsconfig.json`, and the two copy lists must match.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SERVICE = path.join(ROOT, "services/bim-authority");

const staged = new Set([...fs.readFileSync(path.join(SERVICE, "stage.sh"), "utf8").matchAll(/^copy packages\/([\w-]+)$/gm)].map((m) => m[1]));
const copied = new Set([...fs.readFileSync(path.join(SERVICE, "Dockerfile"), "utf8").matchAll(/^COPY packages\/([\w-]+) /gm)].map((m) => m[1]));
const tsconfig = fs.readFileSync(path.join(SERVICE, "tsconfig.json"), "utf8");

const folders = new Map<string, string>();
for (const dir of fs.readdirSync(path.join(ROOT, "packages"))) {
  const pkg = path.join(ROOT, "packages", dir, "package.json");
  if (fs.existsSync(pkg)) folders.set(String(JSON.parse(fs.readFileSync(pkg, "utf8")).name), dir);
}

/** Package folders the server's source reaches through value and dynamic imports (type-only imports skipped), following each package's own imports. */
function reachedPackages(): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [path.join(SERVICE, "src")];
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "__tests__" || e.name === "node_modules" ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  while (queue.length > 0) {
    const dir = queue.pop() ?? "";
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const file of files(dir)) {
      // Type-only imports are erased at runtime; they need no package in the image.
      const source = fs.readFileSync(file, "utf8").replace(/(^|\n)\s*(import|export) type [^;]*;/g, "$1");
      for (const m of source.matchAll(/(?:from|import\()\s*["'](@permitzip\/[\w-]+)/g)) {
        const folder = folders.get(m[1] ?? "");
        if (folder && !out.has(folder)) {
          out.add(folder);
          queue.push(path.join(ROOT, "packages", folder, "src"));
        }
      }
    }
  }
  return [...out].sort();
}

describe("bim-authority image packages", () => {
  it("stage.sh and the Dockerfile copy the same packages", () => {
    expect([...staged].sort()).toEqual([...copied].sort());
  });

  it("every package the server reaches is staged, copied and mapped", () => {
    const missing = reachedPackages().filter((folder) => {
      const name = [...folders].find(([, f]) => f === folder)?.[0] ?? folder;
      return !staged.has(folder) || !copied.has(folder) || !tsconfig.includes(`"${name}"`);
    });
    expect(missing).toEqual([]);
  });
});
