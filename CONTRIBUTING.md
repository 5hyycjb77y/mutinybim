# Contributing to MutinyBIM

Thank you for helping. MutinyBIM is built by software people and by licensed
professionals in every building trade. You do not need to be both.

This guide covers sign-off, setup, tests, the rules every change follows, and
how pull requests are reviewed.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org)
(DCO) instead of a contributor license agreement. Every commit must carry a
`Signed-off-by` line with your real name and an email you can be reached at:

```text
Signed-off-by: Your Name <you@example.com>
```

Git adds it for you:

```bash
git commit -s -m "fix(sheets): keep title block text inside its box"
```

By signing off you certify, in short, that:

1. you wrote the change, or have the right to submit it under the project's
   open-source license;
2. if it is based on earlier work, that work is under a compatible open-source
   license and you have the right to submit it with your changes;
3. or someone who can certify (1) or (2) gave it to you and you have not
   changed it; and
4. you understand the contribution and your sign-off are public and kept
   permanently.

Read the full text at <https://developercertificate.org>. A check on every
pull request fails if a commit is not signed off. To fix the last commit, run
`git commit --amend -s`. To fix several, run `git rebase --signoff main` and
force-push your branch.

Contributions are licensed under the Apache License 2.0, the same as the
project.

## Set up

You need Node 22 or newer and Git.

```bash
git clone https://github.com/permitzip/mutinybim.git
cd mutinybim
npm install
npm run demo        # dev server and demo editor at http://localhost:3095
```

The demo keeps the model in memory. It needs no database, no Docker and no
accounts or keys. To work against the real model server and its Postgres
store, run `docker compose up --build` instead (see the README).

## Test

```bash
npm test            # unit tests (Jest)
npm run typecheck   # TypeScript
npm run lint        # ESLint, boundary and license rules
```

Run one package's tests while you work, for example:

```bash
npx jest packages/bim-pack-civil
```

CI runs the same checks on every pull request. It uses no secrets and calls no
AI model. A pull request that touches the kernel, sync, viewers, editor or
model server also runs the **Perf gate** (`npm run perf:bim:ci` and
`npm run perf:suites`; see [docs/PERFORMANCE.md](docs/PERFORMANCE.md)), and
every pull request runs the **proof-pack** check on its commits.

Model server tests that need Postgres run against a throwaway local database.
See `services/bim-authority/README.md`.

## The bedrock rule: build on the kernel, never beside it

MutinyBIM serves every trade from one shared kernel. Every change follows
these rules.

- **Find the general idea first.** Before you add something for one trade, ask
  what shared concept sits under it. Schedules, tags, loads, connections,
  systems, sizing, checks and units are shared. An electrical panel, a gas
  load and a plumbing fixture are instances of them. Build the shared concept
  once, then express the trade as configuration, catalog data or an add-on.
- **Trade logic goes in add-ons.** The kernel names no trade. Add-ons plug into
  versioned extension points through `@permitzip/bim-pack`. An add-on never
  reaches into kernel internals, and the kernel never imports an add-on.
- **If the kernel cannot support it, fix the kernel.** Generalize the shared
  concept in the same pull request, then build the trade on top. Do not work
  around a gap in an add-on or a tool. Label the issue `kernel gap`.
- **Typed units everywhere.** Quantities carry a unit kind from
  `@permitzip/bim-units`. No bare numbers cross a package boundary.
- **Performance is a feature.** Name the hot path your change touches and its
  budget at 250,000 and 1,000,000 elements. Use incremental updates and
  indexed reads. No full-model scans on hot paths. Measure before and after.
  Never raise a budget to get a green build.
- **Ratchets only go down.** Some tests keep counts: trade words in the
  kernel, import cycles, layer violations. A count may fall. It may never
  rise. When yours falls, lower the baseline in the same pull request.
- **Open value lists.** Stored ids stay open strings: readers keep values they
  do not know, writers are strict. A newer server must never break an older
  browser.

## Boundary rules

- **Licenses.** Every package carries a `LICENSE` file and
  `"license": "Apache-2.0"` in its `package.json`. Lint enforces this.
- **Dependencies.** Do not add a dependency on closed-source code or on
  copyleft code (GPL, AGPL, LGPL and similar). File-level copyleft such as
  MPL-2.0 is allowed only as an unmodified dependency, and it must be listed
  in `NOTICE`. Add any new third-party notice to `NOTICE` in the same pull
  request.
- **No copied text.** Do not paste code, tables or text from standards,
  manufacturer catalogs or other software unless its license allows it and
  you say where it came from. Write formulas and citations in your own words.
- **No client data.** Never commit a real project, client, address, drawing or
  model. Use synthetic buildings ("Sample Warehouse", `demo-site`).
- **No secrets.** Never commit keys, tokens or passwords. Secret scanning runs
  on every push.

## One look: the shared theme and components

Every screen, in the editor and in every app under `apps/`, is drawn with the
components and theme in `packages/bim-ui`: `Button`, `Card`, `Input`,
`Badge`, `Alert` and the rest, colored only by the `--mutiny-*` theme
variables (light, dark and the computer's setting). No hand-rolled controls,
no hex colors or inline color styles, no stylesheet with its own palette. If
a screen needs a primitive bim-ui lacks, add it to bim-ui in the same pull
request. Check light and dark before review. Printed sheets stay black on
white. Details for coding agents: [AGENTS.md](AGENTS.md).

## Engineering calculations need licensed review

A change that adds or changes an engineering calculation, a code rule, a
sizing method or a design default gets the `needs licensed review` label. It
merges only after a licensed professional in that discipline has reviewed it.
Every calculation must:

- name the method or code clause it rests on;
- carry units on every input and output;
- label built-in values that need checking for permit work;
- include a worked example in its tests.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree
   on the shape. For kernel changes this saves a lot of rework.
2. Keep pull requests small and focused. One idea per pull request.
3. Fill in the pull request template.
4. Before review, make sure:
   - every commit is signed off;
   - CI is green (typecheck, tests, lint);
   - you added or updated tests that fail without your change;
   - you named any performance budget your change touches.
5. A code owner must approve. The core maintainers own the kernel, sync, the
   model server, CI and lint config. Discipline leads co-own their add-on. See
   [GOVERNANCE.md](GOVERNANCE.md).
6. Maintainers merge. We use squash merges and keep a linear history. The
   one exception is the proof rule: a commit that changes the Civil add-on's
   code changes nothing in `packages/bim-kernel`. Put a kernel change the
   add-on needs in its own pull request first (or its own earlier commit,
   merged with a rebase rather than a squash).

## Labels

| Label | Meaning |
| --- | --- |
| `good first issue` | A well-scoped starting task. |
| `help wanted` | We would welcome a contributor here. |
| `needs licensed review` | Needs review by a licensed professional in the discipline. |
| `kernel gap` | Must be fixed in the shared kernel, not worked around in an add-on. |
| `discipline: architecture` · `structural` · `civil` · `fire protection` · `mechanical` · `electrical` · `plumbing` | Which trade it serves. |
| `area: kernel` · `add-on` · `scripting` · `sheets` · `viewer` · `model-server` · `docs` · `perf` | Which part of the code it touches. |

## Writing style

Error messages, labels and docs speak to the person using the software. Say
what happened and what to do next, in plain words. "Leg 3 is 0.5 ft long, but
the elbow there needs 1.2 ft" is better than "invalid geometry".

## Questions

Open a discussion or an issue.
