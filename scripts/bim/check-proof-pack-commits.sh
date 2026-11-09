#!/usr/bin/env bash
# MutinyBIM proof rule: a commit that
# changes a proof pack's code (civil) changes no file under
# packages/bim-kernel. A kernel change the pack needed lands as its own commit
# first and counts against the foundation, not the pack.
#
# Structural left the list in round 14 (K14) when it became a first-party
# add-on, like Architecture: its classes came out of the kernel in the same
# change, so it is no longer the proof. Civil, still a Preview add-on, is.
#
# Only the pack's own code counts: its tests and fixtures may be re-pointed in
# the same commit as a kernel refactor that moves what they import, because
# that says nothing about what the pack itself needed from the kernel. The
# pack's source importing only the published add-on surface is enforced
# separately (c5k-proof-pack-isolation test and the ESLint block).
#
# A package's package.json is not code when the only fields that differ are
# release metadata (version, repository, publishConfig, files, license,
# author, homepage, bugs, private), plus internal @permitzip/* dependency
# ranges moved to that same release version. A release bump touches every
# manifest in one commit and says nothing about what the pack needed. Adding
# or removing a dependency, or changing scripts, exports, main, types or any
# other field, still counts.
#
# Usage: scripts/bim/check-proof-pack-commits.sh <base-sha> <head-sha>
#        scripts/bim/check-proof-pack-commits.sh --self-test
set -euo pipefail

# Exit 0 when <commit>:<path> differs from <commit>^:<path> only in release
# metadata. A manifest added, removed, unreadable or unparsable counts.
RELEASE_ONLY_JS='
const { execFileSync } = require("node:child_process");
const [commit, path] = process.argv.slice(1);
const RELEASE_FIELDS = new Set(["version", "repository", "publishConfig", "files", "license", "author", "homepage", "bugs", "private"]);
const DEPENDENCY_FIELDS = new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);
const read = (rev) => JSON.parse(execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
let before, after;
try {
  before = read(`${commit}^`);
  after = read(commit);
} catch {
  process.exit(1);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const releaseRange = (range) => typeof range === "string" && range.replace(/^workspace:/, "").replace(/^[\^~=]/, "") === after.version;
for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (same(before[field], after[field]) || RELEASE_FIELDS.has(field)) continue;
  if (!DEPENDENCY_FIELDS.has(field)) process.exit(1);
  const was = before[field] ?? {};
  const now = after[field] ?? {};
  if (!same(Object.keys(was).sort(), Object.keys(now).sort())) process.exit(1);
  for (const name of Object.keys(now)) {
    if (was[name] === now[name]) continue;
    if (!name.startsWith("@permitzip/") || !releaseRange(now[name])) process.exit(1);
  }
}
'

check_range() {
  local base="$1" head="$2"
  local proof_packs_re='^packages/bim-pack-civil/'
  local pack_tests_re='^packages/bim-pack-civil/(__tests__|__fixtures__|test|tests)/|^packages/bim-pack-civil/.*\.(test|spec)\.[cm]?[jt]sx?$'
  local kernel_re='^packages/bim-kernel/'
  local manifest_re='^packages/[^/]+/package\.json$'

  local failed=0 checked=0 commit files counted f pack_code
  while read -r commit; do
    [ -n "$commit" ] || continue
    files="$(git diff-tree --no-commit-id --name-only -r "$commit")"
    counted=""
    while read -r f; do
      [ -n "$f" ] || continue
      if [[ "$f" =~ $manifest_re ]] && node -e "$RELEASE_ONLY_JS" "$commit" "$f"; then continue; fi
      counted+="$f"$'\n'
    done <<< "$files"
    pack_code="$(printf '%s' "$counted" | grep -E "$proof_packs_re" | grep -Ev "$pack_tests_re" || true)"
    if [ -n "$pack_code" ]; then
      checked=$((checked + 1))
      if printf '%s' "$counted" | grep -Eq "$kernel_re"; then
        echo "::error::Commit $(git log -1 --format='%h %s' "$commit") changes a proof pack's code and the kernel together. Land the kernel change in its own commit first:"
        printf '%s\n' "$pack_code" | sed 's/^/  pack: /'
        printf '%s' "$counted" | grep -E "$kernel_re" | sed 's/^/  kernel: /'
        failed=1
      fi
    fi
  done < <(git rev-list --no-merges "$base..$head")

  if [ "$failed" -ne 0 ]; then return 1; fi
  echo "[proof-packs] $checked commit(s) touch a proof pack's code; none touches packages/bim-kernel."
}

self_test() {
  local script tmp failures=0
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  (
    set -euo pipefail
    cd "$tmp"
    git init -q -b main .
    git config user.email self-test@example.invalid
    git config user.name "proof-pack self-test"
    git config commit.gpgsign false
    mkdir -p packages/bim-kernel/src packages/bim-pack-civil/src
    cat > packages/bim-kernel/package.json <<'JSON'
{
  "name": "@permitzip/bim-kernel",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@permitzip/bim-units": "0.1.0" }
}
JSON
    cat > packages/bim-pack-civil/package.json <<'JSON'
{
  "name": "@permitzip/bim-pack-civil",
  "version": "0.1.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@permitzip/bim-kernel": "0.1.0" }
}
JSON
    echo 'export const kernel = 1;' > packages/bim-kernel/src/index.ts
    echo 'export const civil = 1;' > packages/bim-pack-civil/src/index.ts
    git add -A && git commit -q -m base
  ) || { echo "[proof-packs self-test] could not build the scratch repo" >&2; return 1; }

  # <name> <expect pass|fail> <node script editing the files, run in the repo>
  run_case() {
    local name="$1" expect="$2" edit="$3" result
    (
      set -euo pipefail
      cd "$tmp"
      git checkout -q -B "case" main
      node -e "$edit"
      git add -A && git commit -q -m "$name"
    ) || { echo "[proof-packs self-test] $name: could not build the commit" >&2; failures=$((failures + 1)); return; }
    if (cd "$tmp" && bash "$script" main case >/dev/null 2>&1); then result=pass; else result=fail; fi
    if [ "$result" = "$expect" ]; then
      echo "[proof-packs self-test] ok   $name ($result)"
    else
      echo "[proof-packs self-test] FAIL $name: expected $expect, got $result" >&2
      failures=$((failures + 1))
    fi
  }

  local EDIT_JS='
const fs = require("node:fs");
const edit = (path, fn) => { const j = JSON.parse(fs.readFileSync(path, "utf8")); fn(j); fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n"); };
const append = (path, text) => fs.appendFileSync(path, text);
const release = (j, dir) => {
  j.version = "0.2.0";
  delete j.private;
  j.repository = { type: "git", url: "git+https://github.com/permitzip/mutinybim.git", directory: dir };
  j.publishConfig = { registry: "https://npm.pkg.github.com" };
  j.files = ["src"];
  for (const name of Object.keys(j.dependencies ?? {})) if (name.startsWith("@permitzip/")) j.dependencies[name] = "^0.2.0";
};
'
  run_case "release bump of kernel and pack manifests" pass "$EDIT_JS
edit('packages/bim-kernel/package.json', (j) => release(j, 'packages/bim-kernel'));
edit('packages/bim-pack-civil/package.json', (j) => release(j, 'packages/bim-pack-civil'));"

  run_case "kernel code and pack code together" fail "$EDIT_JS
append('packages/bim-kernel/src/index.ts', 'export const more = 2;\n');
append('packages/bim-pack-civil/src/index.ts', 'export const more = 2;\n');"

  run_case "kernel manifest adds a dependency, pack code changes" fail "$EDIT_JS
edit('packages/bim-kernel/package.json', (j) => { j.dependencies['left-pad'] = '1.3.0'; });
append('packages/bim-pack-civil/src/index.ts', 'export const more = 2;\n');"

  run_case "release bump that also adds a kernel dependency, pack code changes" fail "$EDIT_JS
edit('packages/bim-kernel/package.json', (j) => { release(j, 'packages/bim-kernel'); j.dependencies['left-pad'] = '1.3.0'; });
append('packages/bim-pack-civil/src/index.ts', 'export const more = 2;\n');"

  run_case "kernel manifest changes exports, pack code changes" fail "$EDIT_JS
edit('packages/bim-kernel/package.json', (j) => { j.exports['./extra'] = './src/extra.ts'; });
append('packages/bim-pack-civil/src/index.ts', 'export const more = 2;\n');"

  run_case "internal range moved to a version that is not the release, pack code changes" fail "$EDIT_JS
edit('packages/bim-kernel/package.json', (j) => { j.version = '0.2.0'; j.dependencies['@permitzip/bim-units'] = '0.3.0'; });
append('packages/bim-pack-civil/src/index.ts', 'export const more = 2;\n');"

  run_case "pack manifest adds a script, kernel code changes" fail "$EDIT_JS
edit('packages/bim-pack-civil/package.json', (j) => { j.scripts = { build: 'tsc' }; });
append('packages/bim-kernel/src/index.ts', 'export const more = 2;\n');"

  rm -rf "$tmp"
  if [ "$failures" -ne 0 ]; then
    echo "[proof-packs self-test] $failures case(s) failed" >&2
    return 1
  fi
  echo "[proof-packs self-test] all cases passed"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  check_range "${1:?base sha}" "${2:?head sha}"
fi
