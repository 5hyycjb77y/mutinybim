/**
 * Writes `plugin.json`, `mcp.json`, the rendered parts of each
 * `skills/<pack>/SKILL.md` (frontmatter and tools block; the guidance between
 * them is kept) and `src/skill-files.ts`. Run after changing a SKILL.md,
 * `src/catalogue.ts` or `src/files.ts`; `__tests__/t10-plugin-json-valid.test.ts`
 * fails until the files match.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BIM_TOOL_PACKS } from "../src/catalogue";
import { renderPackageFiles, renderSkillFilesModule } from "../src/files";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const current: Record<string, string> = {};
for (const pack of BIM_TOOL_PACKS) {
  const path = join(root, "skills", pack.skill, "SKILL.md");
  if (existsSync(path)) current[pack.skill] = readFileSync(path, "utf8");
}
const files = renderPackageFiles(undefined, current);
for (const [path, contents] of files) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  console.info(`[bim-plugin] wrote ${path}`);
}
writeFileSync(join(root, "src", "skill-files.ts"), renderSkillFilesModule(files));
console.info("[bim-plugin] wrote src/skill-files.ts");
