/**
 * MutinyBIM license check: every package under packages/bim-* and
 * services/bim-authority declares `"license": "Apache-2.0"`, carries the
 * Apache-2.0 text in a LICENSE file, and declares no runtime dependency the
 * open-source boundary refuses (closed @permitzip packages, the named
 * commercial / GPL list, or an installed package with a GPL / AGPL /
 * commercial license). Chat packages (packages/chat-*) get the dependency
 * check only, since their license is not chosen yet. Imports are checked
 * file by file by the
 * `permitzip-mutinybim-oss/no-closed-or-copyleft-import` ESLint rule.
 *
 *   node eslint/plugins/mutinybim-oss-boundary-licenses.mjs
 *
 * Prints each problem and exits 1 when there are any. Jest runs the same
 * check in eslint/plugins/__tests__/mutinybim-oss-boundary.test.ts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DENIED_PACKAGES, installedManifest, licenseProblem } from "./mutinybim-oss-boundary.mjs";

export const MUTINYBIM_LICENSE = "Apache-2.0";

/** Every MutinyBIM package directory (repo-relative) that has a package.json. */
export function mutinybimPackageDirs(repoRoot) {
  const out = [];
  const packages = path.join(repoRoot, "packages");
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("bim-") && existsSync(path.join(packages, entry.name, "package.json"))) out.push(`packages/${entry.name}`);
    }
  }
  if (existsSync(path.join(repoRoot, "services/bim-authority/package.json"))) out.push("services/bim-authority");
  return out.sort();
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[mutinybim-licenses] cannot read ${file}`, err);
    return null;
  }
}

/** Plain-language problems, one per finding; empty when every package is clean. */
export function checkMutinyBimLicenses(repoRoot) {
  const problems = [];
  for (const dir of mutinybimPackageDirs(repoRoot)) {
    const abs = path.join(repoRoot, dir);
    const pkg = readJson(path.join(abs, "package.json"));
    if (!pkg) {
      problems.push(`${dir}/package.json is not valid JSON`);
      continue;
    }
    if (pkg.license !== MUTINYBIM_LICENSE) {
      problems.push(`${dir}/package.json declares license ${pkg.license === undefined ? "nothing" : JSON.stringify(pkg.license)}; MutinyBIM packages are "${MUTINYBIM_LICENSE}"`);
    }
    const licenseFile = path.join(abs, "LICENSE");
    if (!existsSync(licenseFile)) problems.push(`${dir} has no LICENSE file (copy the Apache-2.0 text from packages/bim-formula/LICENSE)`);
    else {
      const text = readFileSync(licenseFile, "utf8");
      if (!/Apache License/.test(text) || !/Version 2\.0/.test(text)) problems.push(`${dir}/LICENSE is not the Apache License, Version 2.0 text`);
    }
    problems.push(...dependencyProblems(dir, abs, pkg, "@permitzip/bim-"));
  }
  return problems;
}

function dependencyProblems(dir, abs, pkg, scope) {
  const problems = [];
  const runtime = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  for (const name of Object.keys(runtime).sort()) {
    if (name.startsWith("@permitzip/")) {
      if (!name.startsWith(scope)) problems.push(`${dir} depends on ${name}, a closed PermitZIP package`);
      continue;
    }
    const denied = DENIED_PACKAGES.find((d) => d.match.test(name));
    if (denied) {
      problems.push(`${dir} depends on ${name}: ${denied.why}`);
      continue;
    }
    const manifest = installedManifest(name, abs);
    const problem = manifest ? licenseProblem(manifest.license ?? manifest.licenses) : null;
    if (problem) problems.push(`${dir} depends on ${name}, licensed "${problem}"`);
  }
  return problems;
}

/** Every chat product package directory (repo-relative) that has a package.json. */
export function chatPackageDirs(repoRoot) {
  const packages = path.join(repoRoot, "packages");
  if (!existsSync(packages)) return [];
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("chat-") && existsSync(path.join(packages, entry.name, "package.json")))
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

/**
 * Chat packages declare no closed, commercial or copyleft runtime dependency.
 * Their license is not chosen yet, so the field and LICENSE file are not checked.
 */
export function checkChatDependencies(repoRoot) {
  const problems = [];
  for (const dir of chatPackageDirs(repoRoot)) {
    const abs = path.join(repoRoot, dir);
    const pkg = readJson(path.join(abs, "package.json"));
    if (!pkg) {
      problems.push(`${dir}/package.json is not valid JSON`);
      continue;
    }
    problems.push(...dependencyProblems(dir, abs, pkg, "@permitzip/chat-"));
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const problems = [...checkMutinyBimLicenses(repoRoot), ...checkChatDependencies(repoRoot)];
  for (const p of problems) console.error(`[mutinybim-licenses] ${p}`);
  if (problems.length > 0) {
    console.error(`[mutinybim-licenses] ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`[mutinybim-licenses] ${mutinybimPackageDirs(repoRoot).length} packages, all ${MUTINYBIM_LICENSE}; ${chatPackageDirs(repoRoot).length} chat packages, no refused dependencies`);
}
