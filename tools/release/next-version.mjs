#!/usr/bin/env node
// Which commit to release and at what version, for .github/workflows/release.yml.
// Writes release, version, sha, tagged and publish to $GITHUB_OUTPUT.
//
//   EVENT=workflow_run RUN_SHA=<sha>   the commit whose CI passed on main
//   EVENT=push REF_NAME=v<version>     a tag a maintainer pushed
//   EVENT=workflow_dispatch [INPUT_SHA=<sha>]
//   PUBLISH=true                       publish packages and the image (repository variable MUTINYBIM_PUBLISH)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { nextVersion, parseVersion } from "./versions.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function output(values) {
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n");
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
  console.log(text);
}

function onMain(sha) {
  return spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]).status === 0;
}

try {
  const event = process.env.EVENT ?? "";
  const publish = process.env.PUBLISH === "true" ? "true" : "false";
  let sha;
  let version;
  let tagged = "false";

  if (event === "push") {
    const ref = process.env.REF_NAME ?? "";
    version = ref.replace(/^v/, "");
    if (!ref.startsWith("v") || !parseVersion(version)) throw new Error(`the tag "${ref}" is not v<major.minor.patch>`);
    sha = git("rev-list", "-n", "1", ref);
    tagged = "true";
  } else {
    sha = event === "workflow_run" ? process.env.RUN_SHA : process.env.INPUT_SHA || git("rev-parse", "origin/main");
    if (!sha) throw new Error("no commit to release");
    sha = git("rev-parse", `${sha}^{commit}`);
    const already = lines(git("tag", "--points-at", sha)).filter((t) => parseVersion(t.replace(/^v/, "")));
    if (already.length > 0) {
      console.log(`[release] ${sha} is already ${already.join(", ")}; nothing to release`);
      output({ release: "false", version: already[0].replace(/^v/, ""), sha, tagged: "true", publish });
      process.exit(0);
    }
    const manifestVersion = JSON.parse(git("show", `${sha}:package.json`)).version;
    version = nextVersion({ tags: lines(git("tag", "-l", "v*.*.*")), manifestVersion });
  }

  if (!onMain(sha)) throw new Error(`${sha} is not on main`);
  output({ release: "true", version, sha, tagged, publish });
} catch (err) {
  console.error(`::error::[release] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
