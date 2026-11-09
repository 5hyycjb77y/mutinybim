#!/usr/bin/env node
// Publish every package at the release version to GitHub Packages
// (npm.pkg.github.com, scope @permitzip). Run by .github/workflows/release.yml
// with the workflow's own token; there is no long-lived publish credential.
//
//   node tools/release/publish.mjs pack <version> <dir>   # check versions, write tarballs not yet published
//   node tools/release/publish.mjs push <dir>             # publish the tarballs in <dir>
//
// `pack` refuses when a package's version differs from <version>, a manifest
// is still private, or publishConfig does not point at GitHub Packages. A
// version already published is skipped, so a rerun after a partial failure
// finishes the release. The workflow attests the tarballs between the steps,
// so what is published is exactly what was attested.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REGISTRY, ROOT, publishableDirs, readManifest } from "./packages.mjs";

const [mode, ...rest] = process.argv.slice(2);

function published(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry", REGISTRY], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.trim() === version;
  if (/E404|404 Not Found|is not in this registry/.test(`${r.stdout}${r.stderr}`)) return false;
  throw new Error(`could not ask the registry about ${name}@${version}:\n${r.stdout}${r.stderr}`);
}

function pack(version, outDir) {
  const dirs = publishableDirs();
  const problems = [];
  for (const dir of dirs) {
    const m = readManifest(dir);
    if (m.version !== version) problems.push(`${m.name} is ${m.version}; the release is ${version} (npm run release:version -- ${version})`);
    if (m.private) problems.push(`${m.name} is marked private`);
    if (m.publishConfig?.registry !== REGISTRY) problems.push(`${m.name} has no publishConfig.registry ${REGISTRY}`);
  }
  if (problems.length) throw new Error(`not publishing:\n  ${problems.join("\n  ")}`);
  fs.mkdirSync(outDir, { recursive: true });
  let packed = 0;
  for (const dir of dirs) {
    const { name } = readManifest(dir);
    if (published(name, version)) {
      console.log(`[release] ${name}@${version} already published; skipped`);
      continue;
    }
    const out = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir, "--json"], { cwd: path.join(ROOT, dir), encoding: "utf8" });
    const report = JSON.parse(out); // npm 10: [{…}]; npm 11+: { "<name>": {…} }
    const info = Array.isArray(report) ? report[0] : Object.values(report)[0];
    console.log(`[release] packed ${name}@${version} → ${info.filename}`);
    packed += 1;
  }
  console.log(`[release] ${packed} to publish, ${dirs.length - packed} already published`);
}

function push(dir) {
  const tarballs = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz")).sort();
  for (const t of tarballs) {
    execFileSync("npm", ["publish", path.join(dir, t), "--registry", REGISTRY, "--ignore-scripts"], { stdio: "inherit" });
    console.log(`[release] published ${t}`);
  }
  console.log(`[release] done: ${tarballs.length} published`);
}

try {
  if (mode === "pack" && rest.length === 2) pack(rest[0], path.resolve(rest[1]));
  else if (mode === "push" && rest.length === 1) push(path.resolve(rest[0]));
  else {
    console.error("usage: publish.mjs pack <version> <dir> | publish.mjs push <dir>");
    process.exit(2);
  }
} catch (err) {
  console.error("[release] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
