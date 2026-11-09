#!/usr/bin/env node
// mutinybim-script run, check, pack, publish and yank on a local machine: runCli with node:fs
// and a TypeScript loader. A script runs in this process with your own
// permissions, so run only scripts you trust. Hosts that run other people
// scripts use a sealed runner behind the ScriptRunner contract.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { register } from "tsx/esm/api";

register();

const KIT_MODULE = "@permitzip/bim-script";
const kitUrl = new URL("../src/index.ts", import.meta.url).href;
const { runCli } = await import(new URL("../src/cli.ts", import.meta.url).href);

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const io = {
  readFile: async (file) => new Uint8Array(await readFile(file)),
  readFileIfExists: async (file) => {
    try {
      return new Uint8Array(await readFile(file));
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
  },
  writeFile: async (file, bytes) => {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, bytes);
  },
  listFiles: (dir) => listFiles(dir),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  loadScript: async (source) => {
    const kitSpecifier = new RegExp("([\"'])" + KIT_MODULE.replace("/", "\\/") + "\\1", "g");
    const js = stripTypeScriptTypes(source).replace(kitSpecifier, JSON.stringify(kitUrl));
    const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
    return mod.default;
  },
};

process.exitCode = await runCli(process.argv.slice(2), io);
