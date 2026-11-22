/**
 * Gathers the docs site's pages into tools/docs-site/content/ (git-ignored):
 * the repository's hand-written docs, the reference generated fresh from the
 * code (tools/docs), llms.txt, llms-full.txt and the kit's declarations, and
 * a theme stylesheet made from the bim-ui theme. Run from the repository root
 * (`npm run assemble` in this folder does).
 *
 * Links between gathered pages stay relative; a link to anything else in the
 * repository (a package, a source file) becomes a link to it on GitHub.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { mutinyDarkTheme, mutinyDefaultTheme, themeToCssVars } from "@permitzip/bim-ui";
import { docFiles, REPO_ROOT, siteOnlyFiles } from "../docs/generate";

const SITE = join(REPO_ROOT, "tools/docs-site");
const CONTENT = join(SITE, "content");
const REPO_URL = process.env.MUTINYBIM_DOCS_REPO_URL ?? "https://github.com/permitzip/mutinybim";
const BRANCH = process.env.MUTINYBIM_DOCS_BRANCH ?? "main";

/** Root files the site carries, and where. Everything under docs/ keeps its path with docs/ dropped. */
const ROOT_PAGES: Readonly<Record<string, string>> = {
  "README.md": "index.md",
  "ROADMAP.md": "project/roadmap.md",
  "CONTRIBUTING.md": "project/contributing.md",
  "AGENTS.md": "project/agents.md",
  "GOVERNANCE.md": "project/governance.md",
  "SECURITY.md": "project/security.md",
};

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Repository path → site path, for every page the site carries. */
function sitePaths(generated: ReadonlyMap<string, string>): Map<string, string> {
  const map = new Map<string, string>(Object.entries(ROOT_PAGES));
  const handWritten = walk(join(REPO_ROOT, "docs")).map((f) => relative(REPO_ROOT, f).split("\\").join("/"));
  for (const path of [...handWritten, ...generated.keys()]) {
    // A folder's README.md is its index page (/guide/ serves guide/index.md).
    if (path.startsWith("docs/") && path.endsWith(".md")) map.set(path, path.slice("docs/".length).replace(/(^|\/)README\.md$/, "$1index.md"));
  }
  return map;
}

/** One page's Markdown, made safe for VitePress (which renders Markdown as a Vue template) and with its links mapped. */
function transform(text: string, repoPath: string, pages: ReadonlyMap<string, string>): string {
  const here = pages.get(repoPath) ?? repoPath;
  const out = text
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    // <details> is GitHub's fold; VitePress has its own container.
    .replace(/<details><summary>(.*?)<\/summary>/g, "::: details $1")
    .replace(/<\/details>/g, ":::")
    .replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
      if (/^(https?:|mailto:|#)/.test(target)) return whole;
      const [path = "", anchor] = target.split("#");
      const repoTarget = posix.normalize(posix.join(posix.dirname(repoPath), path));
      const mapped = pages.get(repoTarget);
      const hash = anchor ? `#${anchor}` : "";
      if (mapped) return `](${posix.relative(posix.dirname(here), mapped) || posix.basename(mapped)}${hash})`;
      const kind = existsSync(join(REPO_ROOT, repoTarget)) && statSync(join(REPO_ROOT, repoTarget)).isDirectory() ? "tree" : "blob";
      return `](${REPO_URL}/${kind}/${BRANCH}/${repoTarget}${hash})`;
    });
  // Outside code, Vue would read {{ }} as an expression, and markdown-it-attrs a trailing { } as attributes.
  return escapeOutsideCode(out);
}

/** Escape braces outside fenced and inline code (the site also turns raw HTML off, so `<model id>` stays text). */
function escapeOutsideCode(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;"))).join("");
}

function firstHeading(text: string, fallback: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, "").trim() ?? fallback;
}

/** The sidebar: guide, reference, then the project docs, each in a stable order. */
function sidebar(pages: ReadonlyMap<string, string>, titles: ReadonlyMap<string, string>): unknown {
  const link = (sitePath: string) => `/${sitePath.replace(/(^|\/)(README|index)\.md$/, "$1").replace(/\.md$/, "")}`;
  const items = (filter: (p: string) => boolean, order?: readonly string[]) =>
    [...pages.values()]
      .filter(filter)
      .sort((a, b) => {
        const ia = order?.indexOf(a) ?? -1;
        const ib = order?.indexOf(b) ?? -1;
        if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.localeCompare(b);
      })
      .map((p) => ({ text: titles.get(p) ?? p, link: link(p) }));
  return [
    { text: "Guide", items: items((p) => p.startsWith("guide/"), ["guide/index.md", "guide/getting-started.md", "guide/editor-tour.md", "guide/connect-claude.md"]) },
    { text: "Building on MutinyBIM", items: items((p) => !p.includes("/") && p !== "index.md", ["ARCHITECTURE.md", "SCRIPTING.md", "CONNECT-AN-AGENT.md", "ADD-ON-CONTRACT.md", "YOUR-FIRST-ADD-ON.md"]) },
    { text: "Reference", items: items((p) => p.startsWith("reference/") && !p.startsWith("reference/script-kit/"), ["reference/index.md", "reference/examples.md", "reference/recipes.md"]) },
    { text: "Script kit", collapsed: false, items: items((p) => p.startsWith("reference/script-kit/"), ["reference/script-kit/ctx.md", "reference/script-kit/define-script.md", "reference/script-kit/units.md", "reference/script-kit/building.md", "reference/script-kit/routes.md", "reference/script-kit/equipment.md", "reference/script-kit/parts.md", "reference/script-kit/part-builder.md", "reference/script-kit/documents.md", "reference/script-kit/checks.md"]) },
    { text: "Project", collapsed: true, items: items((p) => p.startsWith("project/")) },
  ];
}

/** The bim-ui theme as VitePress's light and dark variables (VitePress marks dark with html.dark). */
function themeCss(): string {
  const block = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return `/* Generated by tools/docs-site/assemble.ts from @permitzip/bim-ui's theme. */\n:root {\n${block(themeToCssVars(mutinyDefaultTheme))}\n}\nhtml.dark {\n${block(themeToCssVars(mutinyDarkTheme))}\n}\n`;
}

async function main(): Promise<void> {
  const generated = await docFiles();
  const readRepoFile = (path: string) => generated.get(path) ?? readFileSync(join(REPO_ROOT, path), "utf8");
  const pages = sitePaths(generated);

  rmSync(CONTENT, { recursive: true, force: true });
  const titles = new Map<string, string>();
  for (const [repoPath, sitePath] of pages) {
    const text = readRepoFile(repoPath);
    titles.set(sitePath, firstHeading(text, sitePath));
    const full = join(CONTENT, sitePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, transform(text, repoPath, pages));
  }

  // Served as-is: the agent index, the full text, the kit's declarations, the brand marks.
  const pub = join(CONTENT, "public");
  mkdirSync(join(pub, "reference"), { recursive: true });
  writeFileSync(join(pub, "llms.txt"), readRepoFile("llms.txt"));
  for (const [path, text] of siteOnlyFiles(generated, readRepoFile)) {
    writeFileSync(join(pub, path.replace(/^docs\//, "")), text);
  }
  cpSync(join(REPO_ROOT, "packages/bim-ui/assets"), join(pub, "brand"), { recursive: true });

  writeFileSync(join(SITE, ".vitepress/sidebar.generated.json"), JSON.stringify(sidebar(pages, titles), null, 2));
  writeFileSync(join(SITE, ".vitepress/theme/mutiny.generated.css"), themeCss());
  process.stdout.write(`assembled ${pages.size} pages into tools/docs-site/content\n`);
  process.exit(0);
}

void main();
