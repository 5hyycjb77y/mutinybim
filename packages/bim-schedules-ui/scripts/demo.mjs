// Serves the standalone schedules demo (packages/bim-viewer/src/schedules-demo.ts)
// with esbuild: one bundle, the grid and schedule stylesheets, and the bim-ui
// kit's Tailwind classes compiled once at start. Ctrl+C stops it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../..");
const entry = join(packages, "bim-viewer/src/schedules-demo.ts");
const out = mkdtempSync(join(tmpdir(), "mutinybim-schedules-demo-"));
mkdirSync(out, { recursive: true });

const tailwindInput = [
  '@import "tailwindcss";',
  `@source "${join(packages, "bim-ui/src")}";`,
  `@source "${join(packages, "bim-schedules-ui/src")}";`,
].join("\n");
// `from` inside this package so `@import "tailwindcss"` resolves against the repo's node_modules.
const kit = await postcss([tailwind()]).process(tailwindInput, { from: join(here, "kit.css") });
writeFileSync(join(out, "kit.css"), kit.css);

writeFileSync(
  join(out, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MutinyBIM schedules demo</title>
<link rel="stylesheet" href="/kit.css" />
<link rel="stylesheet" href="/schedules-demo.css" />
<style>
  html, body { margin: 0; height: 100%; }
  #root, [data-mutiny-root] { height: 100%; }
  .demo-shell { display: grid; grid-template-columns: 300px 1fr; height: 100%; background: var(--mutiny-surface); }
  .demo-nav { padding: 12px 16px; overflow: auto; border-right: 1px solid var(--mutiny-border); background: var(--mutiny-panel); }
  .demo-nav h1 { font-size: 16px; margin: 0 0 8px; }
  .demo-nav h2 { font-size: 14px; margin: 16px 0 8px; }
  .demo-nav ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .demo-nav a { color: inherit; }
  .demo-nav a[aria-current="page"] { font-weight: 700; }
  .demo-help { font-size: 12px; color: var(--mutiny-muted); }
  .demo-main { padding: 12px 16px; min-width: 0; }
</style>
</head>
<body><div id="root"></div><script src="/schedules-demo.js"></script></body>
</html>
`,
);

const ctx = await context({
  entryPoints: [entry],
  bundle: true,
  outdir: out,
  format: "iife",
  jsx: "automatic",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
await ctx.rebuild();
const { port } = await ctx.serve({ servedir: out, port: Number(process.env.PORT ?? 4319) });
console.log(`[schedules-demo] http://localhost:${port}/  (pid ${process.pid}; Ctrl+C to stop)`);
