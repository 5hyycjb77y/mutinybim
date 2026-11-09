#!/usr/bin/env node
/**
 * Dependency license check and THIRD_PARTY_LICENSES.md for MutinyBIM.
 *
 *   node tools/licenses/dependency-licenses.mjs            # check the installed tree
 *   node tools/licenses/dependency-licenses.mjs --write    # also rewrite THIRD_PARTY_LICENSES.md
 *   node tools/licenses/dependency-licenses.mjs --root DIR --modules DIR[,DIR]   # fall back to another install
 *
 * Runtime dependencies are every package the shipped code imports (src/ and
 * bin/ of each package, the model server's src/ and its package.json), plus
 * everything they depend on. Each must carry a license in RUNTIME_ALLOWED.
 * MPL-2.0 is allowed only as an unmodified dependency: the check fails if a
 * patch for it, or a copy of its files, sits in this repository.
 * Development tooling (tests, lint, typecheck) may also use the permissive
 * licenses in TOOLING_ALSO_ALLOWED. Everything else, including GPL, AGPL,
 * LGPL, SSPL, BUSL and a missing or unreadable license, fails.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROOT = path.resolve(flag("--root") ?? process.cwd());
const MODULES = (flag("--modules") ?? "").split(",").filter(Boolean).map((d) => path.resolve(d));
const WRITE = args.includes("--write");
const OUT = path.join(ROOT, "THIRD_PARTY_LICENSES.md");

const RUNTIME_ALLOWED = new Set(["Apache-2.0", "MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0", "Unlicense", "MPL-2.0", "Zlib"]);
const TOOLING_ALSO_ALLOWED = new Set(["BlueOak-1.0.0", "Python-2.0", "CC-BY-4.0", "CC-BY-3.0", "BSD-3-Clause-Clear", "WTFPL"]);
const COPYLEFT = /\b(A?GPL|LGPL|SSPL|BUSL|EUPL|CPAL|OSL|RPL|Commons-Clause|Elastic)/i;
const MPL_ONLY_UNMODIFIED = "MPL-2.0";

/**
 * Reviewed exceptions, each with its reason. Adding one needs a maintainer's
 * review in the pull request; the report and THIRD_PARTY_LICENSES.md list them.
 */
const EXCEPTIONS = [
  {
    match: (name) => name.startsWith("@img/sharp-libvips-"),
    license: "LGPL-3.0-or-later",
    reason:
      "sharp's prebuilt libvips binary, installed only because manifold-3d declares its glTF command-line tools' dependencies (manifold-3d > @gltf-transform/functions > ndarray-pixels > sharp). MutinyBIM loads only manifold-3d's WASM core and never loads sharp; the binary is unmodified, dynamically linked and not redistributed in this repository.",
  },
];
const exceptionFor = (e) => EXCEPTIONS.find((x) => x.match(e.name) && e.license === x.license);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (p) => fs.existsSync(p);

/** Directories a require from `fromDir` would search, nearest first. */
function searchDirs(fromDir) {
  const dirs = [];
  let dir = fromDir;
  for (;;) {
    dirs.push(path.join(dir, "node_modules"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.push(...MODULES);
  return dirs;
}

function resolvePackage(name, fromDir) {
  for (const dir of searchDirs(fromDir)) {
    const pj = path.join(dir, name, "package.json");
    if (exists(pj)) return fs.realpathSync(path.dirname(pj));
  }
  return undefined;
}

/** Legacy spellings older packages use for SPDX ids. */
const LEGACY_NAMES = { "Apache 2.0": "Apache-2.0", "Apache License 2.0": "Apache-2.0", "Apache License, Version 2.0": "Apache-2.0", "MIT License": "MIT", "BSD": "BSD-2-Clause" };
const normalise = (lic) => lic.split(/( OR | AND )/).map((part) => LEGACY_NAMES[part.replace(/[()]/g, "").trim()] ?? part).join("");

/** SPDX license of an installed package, normalised; LICENSE text when package.json has none. */
function licenseOf(dir, pkg) {
  let lic = pkg.license;
  if (lic && typeof lic === "object") lic = lic.type;
  if (!lic && Array.isArray(pkg.licenses)) lic = pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  if (typeof lic === "string" && lic.trim() && !/^SEE LICEN[CS]E/i.test(lic)) return normalise(lic.trim());
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (!file) return "UNKNOWN";
  const text = fs.readFileSync(path.join(dir, file), "utf8").slice(0, 4000);
  if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  if (/Mozilla Public License,? v(ersion)?\.? ?2\.0/i.test(text)) return "MPL-2.0";
  if (/GNU (Lesser |Affero )?General Public License/i.test(text)) return "GPL-family (from LICENSE text)";
  return `UNKNOWN (${file})`;
}

/** Whether an SPDX expression is satisfied by `allowed` (OR: any branch; AND: every term). */
function satisfies(expr, allowed) {
  const clean = expr.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return clean.split(/ OR /i).some((branch) => branch.split(/ AND /i).every((term) => allowed.has(term.replace(/\+$/, "").replace(/ WITH .*/i, "").trim())));
}

function sourceUrl(pkg, name) {
  let repo = pkg.repository;
  if (repo && typeof repo === "object") repo = repo.url;
  if (typeof repo === "string" && repo) {
    if (/^[\w-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo}`;
    if (repo.startsWith("github:")) return `https://github.com/${repo.slice(7)}`;
    return repo.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  }
  return pkg.homepage ?? `https://www.npmjs.com/package/${name}`;
}

/** External packages the shipped (non-test) code imports, per importing directory. */
function shippedImports() {
  const found = new Map(); // name -> dir to resolve from
  const re = /(?:^|[\s;{}])(?:import|export)\s[^"'`;]*?from\s*["']([^"'\n]+)["']|(?:^|[\s;{}(=,])import\s*\(\s*["']([^"'\n]+)["']\s*\)|(?:^|[\s;{}(=,])require\s*\(\s*["']([^"'\n]+)["']\s*\)|^\s*import\s+["']([^"'\n]+)["']/gm;
  const visit = (dir, base) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "__tests__" || ent.name === "testing") continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(abs, base);
      else if (/\.(m?[jt]sx?|cjs)$/.test(ent.name) && !/\.(test|spec)\.[jt]sx?$/.test(ent.name)) {
        const text = fs.readFileSync(abs, "utf8");
        let m;
        while ((m = re.exec(text))) {
          const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
          if (!spec || /^(\.|\/|node:|data:|@permitzip\/bim-)/.test(spec)) continue;
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (!found.has(name)) found.set(name, base);
        }
      }
    }
  };
  const packages = path.join(ROOT, "packages");
  for (const p of fs.readdirSync(packages)) {
    const base = path.join(packages, p);
    for (const sub of ["src", "bin"]) if (exists(path.join(base, sub))) visit(path.join(base, sub), base);
    if (exists(path.join(base, "package.json"))) {
      const pkg = readJson(path.join(base, "package.json"));
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) if (!name.startsWith("@permitzip/bim-") && !found.has(name)) found.set(name, base);
    }
  }
  const authority = path.join(ROOT, "services/bim-authority");
  if (exists(authority)) {
    visit(path.join(authority, "src"), authority);
    for (const name of Object.keys(readJson(path.join(authority, "package.json")).dependencies ?? {})) if (!found.has(name)) found.set(name, authority);
  }
  return found;
}

const BUILTINS = new Set(["fs", "path", "url", "crypto", "util", "zlib", "os", "stream", "events", "http", "https", "child_process", "worker_threads", "assert", "buffer", "module", "v8", "vm", "perf_hooks", "readline", "net", "tls", "dns", "timers", "process", "string_decoder", "querystring"]);

/** Walk dependencies from roots; returns Map dir -> {name, version, license, url, runtime}. */
function walk(roots, runtime, seen) {
  const missing = [];
  const queue = [...roots];
  while (queue.length) {
    const [name, fromDir, optional, via] = queue.shift();
    if (BUILTINS.has(name)) continue;
    const dir = resolvePackage(name, fromDir);
    if (!dir) {
      if (!optional) missing.push(name);
      continue;
    }
    const prior = seen.get(dir);
    if (prior) {
      if (runtime) prior.runtime = true;
      if (prior.visitedAs === "runtime" || !runtime) continue;
    }
    const pkg = readJson(path.join(dir, "package.json"));
    seen.set(dir, { name: pkg.name ?? name, version: pkg.version ?? "?", license: licenseOf(dir, pkg), url: sourceUrl(pkg, name), runtime: runtime || prior?.runtime === true, visitedAs: runtime ? "runtime" : "tooling", via: prior?.via ?? via });
    const chain = via ? `${via} > ${pkg.name ?? name}` : (pkg.name ?? name);
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, dir, false, chain]);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push([dep, dir, true, chain]);
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) queue.push([dep, dir, true, chain]);
  }
  return missing;
}

function main() {
  const seen = new Map();
  const runtimeRoots = [...shippedImports()].map(([name, from]) => [name, from, false]);
  const missingRuntime = walk(runtimeRoots, true, seen);
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const toolingRoots = Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies }).map((n) => [n, ROOT, false]);
  const authorityPkg = exists(path.join(ROOT, "services/bim-authority/package.json")) ? readJson(path.join(ROOT, "services/bim-authority/package.json")) : {};
  toolingRoots.push(...Object.keys(authorityPkg.devDependencies ?? {}).map((n) => [n, path.join(ROOT, "services/bim-authority"), false]));
  const missingTooling = walk(toolingRoots, false, seen);

  const problems = [];
  for (const name of missingRuntime) problems.push(`runtime dependency ${name} is not installed: cannot read its license`);
  for (const name of missingTooling) problems.push(`dependency ${name} is not installed: cannot read its license`);
  const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  for (const e of entries) {
    const where = e.via ? ` (via ${e.via})` : "";
    if (exceptionFor(e)) continue;
    if (COPYLEFT.test(e.license)) problems.push(`${e.name}@${e.version}${where}: ${e.license} is not allowed`);
    else if (e.runtime && !satisfies(e.license, RUNTIME_ALLOWED)) problems.push(`${e.name}@${e.version} (runtime${where}): ${e.license} is not an allowed license`);
    else if (!e.runtime && !satisfies(e.license, new Set([...RUNTIME_ALLOWED, ...TOOLING_ALSO_ALLOWED]))) problems.push(`${e.name}@${e.version} (tooling${where}): ${e.license} is not an allowed license`);
  }

  // MPL-2.0 is file-level copyleft: fine unmodified, so no patch and no copy of its files may live here.
  const mpl = entries.filter((e) => e.license.includes(MPL_ONLY_UNMODIFIED));
  if (mpl.length) {
    if (exists(path.join(ROOT, "patches"))) {
      for (const f of fs.readdirSync(path.join(ROOT, "patches"))) for (const e of mpl) if (f.startsWith(`${e.name.replace("/", "+")}+`)) problems.push(`patches/${f} modifies MPL-2.0 ${e.name}; it must stay unmodified`);
    }
    const copies = [];
    const scan = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) scan(abs);
        else if (/\.wasm$/i.test(ent.name) || mpl.some((e) => ent.name.toLowerCase().includes(e.name.split("/").pop().toLowerCase()) && /\.(m?js|wasm|d\.ts)$/.test(ent.name))) copies.push(path.relative(ROOT, abs));
      }
    };
    scan(ROOT);
    for (const c of copies) problems.push(`${c} looks like a copy of an MPL-2.0 dependency's file; depend on the package instead (or keep it unmodified with its MPL-2.0 header and list it in NOTICE)`);
  }

  const runtime = entries.filter((e) => e.runtime);
  const counts = new Map();
  for (const e of entries) counts.set(e.license, (counts.get(e.license) ?? 0) + 1);
  console.log(`[dependency-licenses] ${entries.length} installed packages checked (${runtime.length} runtime, ${entries.length - runtime.length} tooling only)`);
  console.log(`[dependency-licenses] licenses: ${[...counts].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")}`);
  for (const e of entries.filter(exceptionFor)) console.log(`[dependency-licenses] reviewed exception: ${e.name}@${e.version} ${e.license}: ${exceptionFor(e).reason}`);
  if (mpl.length) console.log(`[dependency-licenses] MPL-2.0, used unmodified: ${mpl.map((e) => `${e.name}@${e.version}${e.runtime ? " (runtime)" : ""}`).join(", ")}`);

  const doc = [
    "# Third-party licenses",
    "",
    "Generated by `node tools/licenses/dependency-licenses.mjs --write` from the installed dependency tree.",
    "These packages are installed by npm and are not copied into this repository.",
    "MPL-2.0 packages are used unmodified; their source is at the link given.",
    "",
    "## Runtime dependencies",
    "",
    "Everything the shipped code (the packages' `src/` and `bin/`, and the model server) imports, and their dependencies.",
    "",
    "| Package | Version | License | Source |",
    "| --- | --- | --- | --- |",
    ...runtime.map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.url} |`),
    "",
    ...(entries.some(exceptionFor)
      ? ["## Reviewed exceptions", "", ...entries.filter(exceptionFor).map((e) => `- ${e.name} ${e.version} (${e.license}): ${exceptionFor(e).reason}`), ""]
      : []),
    "## Development tooling",
    "",
    "Used to test, lint and typecheck; not needed to run MutinyBIM.",
    "",
    "| Package | Version | License | Source |",
    "| --- | --- | --- | --- |",
    ...entries.filter((e) => !e.runtime).map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.url} |`),
    "",
  ].join("\n");
  if (WRITE) {
    fs.writeFileSync(OUT, doc);
    console.log(`[dependency-licenses] wrote ${path.relative(process.cwd(), OUT) || OUT}`);
  } else if (exists(OUT) && fs.readFileSync(OUT, "utf8") !== doc) {
    console.log("[dependency-licenses] note: THIRD_PARTY_LICENSES.md is out of date; run with --write and commit it");
  }

  if (problems.length) {
    console.error(`[dependency-licenses] ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("[dependency-licenses] clean");
}

try {
  main();
} catch (err) {
  console.error("[dependency-licenses] failed", err);
  process.exit(1);
}
