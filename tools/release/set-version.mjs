#!/usr/bin/env node
// Set one version on every published package (and the lockfiles that record
// it). In a pull request, for a minor or major release: the merge releases
// that version. The release workflow also runs it, uncommitted, to stamp each
// patch release's version before packing.
//
//   npm run release:version -- 0.2.1
import path from "node:path";
import fs from "node:fs";
import { ROOT, publishableDirs, readManifest, writeJson } from "./packages.mjs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: npm run release:version -- <major.minor.patch>");
  process.exit(2);
}

const rootLockFile = path.join(ROOT, "package-lock.json");
const rootLock = JSON.parse(fs.readFileSync(rootLockFile, "utf8"));
for (const dir of publishableDirs()) {
  const manifest = readManifest(dir);
  manifest.version = version;
  writeJson(path.join(ROOT, dir, "package.json"), manifest);
  if (rootLock.packages?.[dir]) rootLock.packages[dir].version = version;
  console.log(`${manifest.name} ${version}`);
}
rootLock.version = version;
if (rootLock.packages?.[""]) rootLock.packages[""].version = version;
writeJson(rootLockFile, rootLock);

const rootManifest = readManifest(".");
rootManifest.version = version;
writeJson(path.join(ROOT, "package.json"), rootManifest);

const serverLockFile = path.join(ROOT, "services/bim-authority/package-lock.json");
const serverLock = JSON.parse(fs.readFileSync(serverLockFile, "utf8"));
serverLock.version = version;
if (serverLock.packages?.[""]) serverLock.packages[""].version = version;
writeJson(serverLockFile, serverLock);
