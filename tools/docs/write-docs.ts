/**
 * Writes the generated reference (docs/reference/) and llms.txt.
 *   npm run docs          write them
 *   npm run docs:check    exit 1, naming the files, when they are stale
 * Files under docs/reference/ that the generator no longer makes are removed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { docFiles, REFERENCE_DIR, REPO_ROOT } from "./generate";

function onDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? onDisk(full) : [relative(REPO_ROOT, full)];
  });
}

/** Paths whose content differs from what the generator makes, and generated-dir files it no longer makes. */
export async function staleDocs(): Promise<{ readonly files: Map<string, string>; readonly changed: string[]; readonly extra: string[] }> {
  const files = await docFiles();
  const changed = [...files].filter(([path, text]) => {
    const full = join(REPO_ROOT, path);
    return !existsSync(full) || readFileSync(full, "utf8") !== text;
  }).map(([path]) => path);
  const extra = onDisk(join(REPO_ROOT, REFERENCE_DIR)).filter((p) => !files.has(p));
  return { files, changed, extra };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const { files, changed, extra } = await staleDocs();
  if (check) {
    if (changed.length || extra.length) {
      process.stderr.write(`The generated docs are stale. Run \`npm run docs\` and commit the result.\n${[...changed, ...extra].map((p) => `  ${p}`).join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write(`docs are current (${files.size} files)\n`);
    process.exit(0);
  }
  for (const path of changed) {
    const full = join(REPO_ROOT, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, files.get(path) ?? "");
  }
  for (const path of extra) rmSync(join(REPO_ROOT, path));
  process.stdout.write(`wrote ${changed.length} and removed ${extra.length} of ${files.size} generated files\n`);
  process.exit(0);
}

if (require.main === module) void main();
