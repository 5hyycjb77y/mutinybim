/**
 * @jest-environment node
 *
 * MutinyBIM layer guard (KERNEL-FOUNDATION §2, MIGRATION-PLAN §2).
 *
 * Walks the runtime imports of every `packages/bim-*` source file and
 * `services/bim-authority/src`: `import type`, `export type` and imports whose
 * names are all `type X` vanish at runtime and do not count; `export * from`
 * does. Then two checks against `import-cycles.baseline.json`:
 *
 * - Runtime import cycles, as strongly connected groups. A new group, or a
 *   group that grows past its baseline, fails. A value read at load time
 *   (`z.enum(X)`, `new Set(X)`) through a cycle is how round 4's production
 *   bundle died (`8c5fc8b56`).
 * - Layer rules: a lower layer importing a higher one fails, unless the edge
 *   is listed in the baseline (today's debts, shrink-only).
 *
 * When a baseline entry no longer occurs the test still passes and says so:
 * delete the entry (the ratchet only goes down).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const BASELINE_FILE = path.join(__dirname, "import-cycles.baseline.json");

interface Baseline {
  readonly runtimeCycleGroups: readonly (readonly string[])[];
  readonly layerViolations: Readonly<Record<string, readonly string[]>>;
}

type Graph = ReadonlyMap<string, readonly string[]>;

const IMPORT_RE = /^\s*(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^\s*import\s+["']([^"']+)["']/gm;

function isTypeOnly(clause: string): boolean {
  if (/^type\b/.test(clause)) return true;
  const braces = clause.match(/^\{([\s\S]*)\}$/);
  if (!braces?.[1]) return false;
  const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith("type "));
}

function sourceFile(candidate: string): boolean {
  return /\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile();
}

function tryFile(base: string): string | null {
  const bare = base.replace(/\.(js|mjs)$/, "");
  for (const c of [base, `${bare}.ts`, `${bare}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (sourceFile(c)) return c;
  return null;
}

const exportMaps = new Map<string, Readonly<Record<string, unknown>>>();

function resolvePackage(spec: string): string | null {
  const m = spec.match(/^@permitzip\/(bim-[a-z0-9-]+)(\/.*)?$/);
  if (!m?.[1]) return null;
  const dir = path.join(ROOT, "packages", m[1]);
  const pkgFile = path.join(dir, "package.json");
  if (!existsSync(pkgFile)) return null;
  let map = exportMaps.get(dir);
  if (!map) {
    const pkg: unknown = JSON.parse(readFileSync(pkgFile, "utf8"));
    const exp = typeof pkg === "object" && pkg !== null && "exports" in pkg ? pkg.exports : undefined;
    map = typeof exp === "string" ? { ".": exp } : typeof exp === "object" && exp !== null ? (exp as Record<string, unknown>) : {};
    exportMaps.set(dir, map);
  }
  const target = map[`.${m[2] ?? ""}`];
  return typeof target === "string" ? tryFile(path.join(dir, target)) : null;
}

function resolveSpec(from: string, spec: string): string | null {
  return spec.startsWith(".") ? tryFile(path.resolve(path.dirname(from), spec)) : resolvePackage(spec);
}

interface Edge {
  readonly to: string;
  readonly relative: boolean;
}

function valueImports(file: string): Edge[] {
  const source = readFileSync(file, "utf8");
  const out = new Map<string, Edge>();
  const add = (spec: string) => {
    const to = resolveSpec(file, spec);
    if (to && !out.has(to)) out.set(to, { to, relative: spec.startsWith(".") });
  };
  for (const m of source.matchAll(IMPORT_RE)) {
    const clause = (m[2] ?? "").replace(/\s+/g, " ").trim();
    if (m[3] && !isTypeOnly(clause)) add(m[3]);
  }
  for (const m of source.matchAll(SIDE_EFFECT_RE)) if (m[1]) add(m[1]);
  return [...out.values()];
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

function buildGraph(): { graph: Map<string, string[]>; relativeEdges: Set<string> } {
  const files: string[] = [];
  for (const pkg of readdirSync(path.join(ROOT, "packages"))) {
    const src = path.join(ROOT, "packages", pkg, "src");
    if (pkg.startsWith("bim-") && existsSync(src)) walk(src, files);
  }
  walk(path.join(ROOT, "services/bim-authority/src"), files);
  const graph = new Map<string, string[]>();
  const relativeEdges = new Set<string>();
  for (const f of files) {
    const edges = valueImports(f);
    graph.set(rel(f), edges.map((e) => rel(e.to)));
    for (const e of edges) if (e.relative) relativeEdges.add(`${rel(f)} -> ${rel(e.to)}`);
  }
  return { graph, relativeEdges };
}

/** Strongly connected groups of more than one file (or a file importing itself), each sorted. */
function cycleGroups(graph: Graph): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    let w: string | undefined;
    do {
      w = stack.pop();
      if (w === undefined) break;
      onStack.delete(w);
      group.push(w);
    } while (w !== v);
    if (group.length > 1 || (graph.get(v) ?? []).includes(v)) groups.push(group.sort());
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  return groups.sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

interface LayerRule {
  readonly id: string;
  readonly why: string;
  readonly from: (file: string) => boolean;
  readonly to: (file: string, relative: boolean) => boolean;
}

const K = "packages/bim-kernel/src/";
const inKernel = (f: string) => f.startsWith(K);
const kernelPath = (f: string) => (inKernel(f) ? f.slice(K.length) : null);
const isCommandModule = (f: string) => {
  const p = kernelPath(f);
  return p !== null && p !== "command-core.ts" && (p === "commands.ts" || p.startsWith("commands/") || /(^|\/)commands\.ts$/.test(p) || /-commands\.ts$/.test(p));
};
const UPPER_PACKAGES = ["bim-calc", "bim-lint", "bim-sheets", "bim-sync", "bim-library", "bim-ui", "bim-viewer", "bim-viewer-3d", "bim-grid", "bim-schedules-ui", "bim-devserver", "bim-mcp", "bim-mcp-packs", "bim-script-runner"];
const packageOf = (f: string) => f.match(/^packages\/(bim-[a-z0-9-]+)\//)?.[1] ?? (f.startsWith("services/bim-authority/") ? "bim-authority" : null);

const LAYER_RULES: readonly LayerRule[] = [
  {
    id: "primitives-import-no-kernel",
    why: "L0 (bim-units, bim-formula, bim-geometry) imports nothing above it",
    from: (f) => ["bim-units", "bim-formula", "bim-geometry"].includes(packageOf(f) ?? ""),
    to: (t) => !["bim-units", "bim-formula", "bim-geometry"].includes(packageOf(t) ?? ""),
  },
  {
    id: "schema-imports-no-domain",
    why: "L1 schema (registry, catalog/types, parts, types) imports no domain (connections, routing, load-points)",
    from: (f) => {
      const p = kernelPath(f);
      return p !== null && (p.startsWith("registry/") || p === "catalog/types.ts" || p === "parts.ts" || p === "types.ts");
    },
    to: (t) => {
      const p = kernelPath(t);
      return p !== null && (p.startsWith("connections/") || p.startsWith("routing/") || p.startsWith("load-points/"));
    },
  },
  {
    id: "spine-imports-no-commands",
    why: "L4 command-core.ts (the edit spine) imports no command module; domains register through its handler table",
    from: (f) => f === `${K}command-core.ts`,
    to: (t) => isCommandModule(t),
  },
  {
    id: "spine-imports-no-derived",
    why: "L4 command-core.ts imports no L5 derived output (schedules, drawing, diagrams, crop, 3D views)",
    from: (f) => f === `${K}command-core.ts`,
    to: (t) => {
      const p = kernelPath(t);
      return p !== null && (p.startsWith("schedules/") || p.startsWith("drawing/") || p.startsWith("diagrams/") || p === "crop.ts" || p === "view3d.ts");
    },
  },
  {
    id: "kernel-imports-no-upper-packages",
    why: "the kernel imports no package built on it",
    from: inKernel,
    to: (t) => UPPER_PACKAGES.includes(packageOf(t) ?? ""),
  },
  {
    id: "public-entry-only",
    why: "packages and the model server import the kernel through @permitzip/bim-kernel (or a subpath in its exports), never a relative path into its src",
    from: (f) => !inKernel(f),
    to: (t, relative) => inKernel(t) && relative,
  },
];

function layerViolations(graph: Graph, relativeEdges: ReadonlySet<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rule of LAYER_RULES) {
    const found: string[] = [];
    for (const [from, tos] of graph) {
      if (!rule.from(from)) continue;
      for (const to of tos) if (to !== from && rule.to(to, relativeEdges.has(`${from} -> ${to}`))) found.push(`${from} -> ${to}`);
    }
    out[rule.id] = found.sort();
  }
  return out;
}

interface RatchetReport {
  readonly failures: string[];
  readonly stale: string[];
}

function ratchet(groups: readonly (readonly string[])[], violations: Readonly<Record<string, readonly string[]>>, baseline: Baseline): RatchetReport {
  const failures: string[] = [];
  const stale: string[] = [];
  const matched = new Set<number>();
  for (const group of groups) {
    const at = baseline.runtimeCycleGroups.findIndex((b) => group.every((f) => b.includes(f)));
    if (at < 0) failures.push(`New or grown runtime import cycle (${group.length} files): ${group.join(", ")}`);
    else matched.add(at);
  }
  baseline.runtimeCycleGroups.forEach((b, i) => {
    if (!matched.has(i)) stale.push(`Baseline cycle group ${i} (${b.length} files) is gone: remove it from import-cycles.baseline.json`);
  });
  for (const rule of LAYER_RULES) {
    const allowed = new Set(baseline.layerViolations[rule.id] ?? []);
    const now = new Set(violations[rule.id] ?? []);
    for (const edge of now) if (!allowed.has(edge)) failures.push(`${rule.id} (${rule.why}): ${edge}`);
    for (const edge of allowed) if (!now.has(edge)) stale.push(`${rule.id}: "${edge}" no longer occurs: remove it from the baseline`);
  }
  return { failures, stale };
}

function loadBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  if (typeof raw !== "object" || raw === null || !("runtimeCycleGroups" in raw) || !("layerViolations" in raw)) throw new Error("import-cycles.baseline.json needs runtimeCycleGroups and layerViolations");
  return raw as Baseline;
}

describe("MutinyBIM import layers", () => {
  const { graph, relativeEdges } = buildGraph();
  const baseline = loadBaseline();

  it("reads runtime imports and skips type-only ones, so the checks below are not vacuous", () => {
    expect(graph.size).toBeGreaterThan(400);
    expect(graph.get(`${K}commands.ts`)).toContain(`${K}command-core.ts`);
    expect(graph.get(`${K}index.ts`)).toContain(`${K}schedules/paper.ts`);
    // command-core names `Command` with `import type` from commands.ts: no runtime edge.
    expect(graph.get(`${K}command-core.ts`)).not.toContain(`${K}commands.ts`);
    // A package import resolves through the package's exports map.
    expect(graph.get("packages/bim-pack-mechanical/src/calc/ventilation/engine.ts")).toContain(`${K}packs/index.ts`);
  });

  it("has no runtime import cycle or layer violation beyond the baseline", () => {
    const report = ratchet(cycleGroups(graph), layerViolations(graph, relativeEdges), baseline);
    for (const note of report.stale) console.warn(`[import-layers] ${note}`);
    expect(report.failures).toEqual([]);
  });

  it("fails on the round-4 shape: the spine importing view and organization commands again", () => {
    const old = new Map(graph);
    old.set(`${K}command-core.ts`, [...(graph.get(`${K}command-core.ts`) ?? []), `${K}commands/views.ts`, `${K}organization/commands.ts`]);
    const report = ratchet(cycleGroups(old), layerViolations(old, relativeEdges), baseline);
    expect(report.failures.some((f) => f.startsWith("New or grown runtime import cycle"))).toBe(true);
    expect(report.failures).toContain(`spine-imports-no-commands (${LAYER_RULES[2]?.why}): ${K}command-core.ts -> ${K}commands/views.ts`);
  });

  it("fails when a lower layer imports a higher one", () => {
    const bad = new Map(graph);
    bad.set(`${K}registry/types.ts`, [...(graph.get(`${K}registry/types.ts`) ?? []), `${K}routing/commands.ts`]);
    bad.set("packages/bim-units/src/index.ts", [...(graph.get("packages/bim-units/src/index.ts") ?? []), `${K}index.ts`]);
    const failures = ratchet(cycleGroups(bad), layerViolations(bad, relativeEdges), baseline).failures;
    expect(failures.some((f) => f.startsWith("schema-imports-no-domain") && f.endsWith(`${K}registry/types.ts -> ${K}routing/commands.ts`))).toBe(true);
    expect(failures.some((f) => f.startsWith("primitives-import-no-kernel"))).toBe(true);
  });

  it("finds a deliberately added two-file cycle", () => {
    const groups = cycleGroups(new Map([["a.ts", ["b.ts"]], ["b.ts", ["a.ts"]], ["c.ts", ["a.ts"]]]));
    expect(groups).toEqual([["a.ts", "b.ts"]]);
  });
});
