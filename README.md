# MutinyBIM

MutinyBIM is a browser-based building information modeling (BIM) engine. It is
built for many people and many AI agents editing the same model at the same
time. It is meant for every trade on a building project: architecture,
structural, civil, mechanical, electrical, plumbing, fire protection, the
general contractor, and the owner or developer who tracks cost.

The core idea is one shared kernel with trade add-ons on top. The kernel knows
elements, types, parameters, typed units, connected networks, spaces, phases,
sheets and commits. It does not know what a duct, a panel or a beam is. Each
trade is an add-on that plugs into versioned extension points. The add-ons in
this repository are built only through that contract, and tests hold them to
it.

MutinyBIM is open source under the Apache License 2.0. PermitZIP maintains it
and runs it in production in its own engineering work.

**Start here:** [`packages/bim-script/examples`](packages/bim-script/examples)
has four short scripts that each build something whole: a small office, a
rooftop unit with its ducts, a plumbing riser and an electrical room. Run one
with `npm run example -- rooftop-unit`, or paste it to an assistant connected
to the tool server.

## Status: early, and honest about it

This is the engine, not yet the full product.

**In this repository now**

- The engine: kernel, typed units, formulas, solid geometry, sync, sheets and
  PDF output, IFC 4.3 export, calculations, coordination lint, the firm
  library format, and the add-on contract.
- Trade add-ons: architecture, structural, civil, site, development (pro forma),
  electrical, mechanical, plumbing and gas, plus fire protection inside the
  first-party bundle.
- Viewers and UI kit: a plan editor, a 3D view, a theme and component kit, a
  virtualized data grid and schedule screens.
- The Building Model editor (`packages/bim-editor`): plan, 3D and sheet views,
  placing, routing and sizing, levels, spaces, schedules, notes, sheets,
  branches and versions. It runs in any app that implements the small host
  contract in `packages/bim-editor-host`, and ships with a standalone host.
- A dev server with the editor demo that runs in memory. No database, no Docker.
- The scripting kit, with the `mutinybim-script run | check | pack` command.
- The tool server (`packages/bim-mcp`): MutinyBIM's agent tools over the Model
  Context Protocol (MCP), on stdio or HTTP, for Claude, ChatGPT, Cursor and
  any other MCP client. Its main job is running the scripts an assistant
  writes. A local script runner (`packages/bim-script-runner`) comes with it,
  and every other tool family (parts, routing and fittings, electrical and
  plumbing, views, sheets and drafting, schedules, coordination) is an add-on
  pack in `packages/bim-mcp-packs`.
- The model server: one owner per model, durable commits in Postgres, live
  sync over WebSocket.
- The free hosted app is in `apps/mutinybim-web`: accounts, saved models,
  sharing, the editor, bring-your-own AI, and the tool server at `/mcp` that
  Claude, ChatGPT and Grok connect to by address (`npm run web`).
- A one-command local stack: `docker compose up` starts Postgres, the model
  server on its real Postgres store, a local sign-in and the editor pointed
  at that server.
- The performance gate: measured budgets for 250,000-element models, run on
  every pull request that touches the kernel, sync, viewers, editor or model
  server ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

**Not in this repository yet**

- The editor screens that need a hosted app's data (saved preferences, a
  firm's part libraries, design limits, stored drawings, linked Revit models,
  code studies, file storage and a built-in agent). In the local demo they say
  "not available here"; the rest of the editor works.
- Model server sign-in for any provider, with built-in member roles. Today it
  verifies tokens from one configured sign-in service; the local stack brings
  its own, for one computer.

See [ROADMAP.md](ROADMAP.md).

## Quick start

You need Node 22.13 or newer.

```bash
npm install
npm run demo
```

Open <http://127.0.0.1:3095>. The editor runs against an in-memory model on
the dev server. The first start builds the editor (about a minute); later
starts reuse that build. Open the same address in a second window with
`&name=Priya` added to edit together. Nothing is saved when you stop the server.

### The full stack, with Docker

You need Docker with Compose v2.

```bash
docker compose up --build
```

Open <http://localhost:3095/m/demo?view=plan>. This time the editor talks to
the real model server, which keeps every edit in Postgres: stop the stack,
start it again, and the model is still there. Open a second window with
`&name=Avery` to edit together. The people who can sign in are You, Avery,
Priya and Sam (a local sign-in for one computer; never expose it).
`docker compose down -v` deletes the model. What each service does:
[docker-compose.yml](docker-compose.yml).

Other root commands:

```bash
npm test           # unit tests (Jest)
npm run typecheck  # TypeScript across the packages
npm run lint       # ESLint, including the boundary and license rules
npm run example -- rooftop-unit   # run an example script against a fresh model (packages/bim-script/examples)
npm run mutinybim-script -- run script.json --slice slice.json   # run a script against a model slice
npm run mcp        # the tool server on stdio, for an assistant to start (see below)
npm run mcp:http   # the tool server at http://127.0.0.1:3333/mcp
npm run perf:bim:ci    # the perf gate at 250k (MUTINYBIM_PERF_BUDGETS=relative on a busy machine)
npm run perf:suites    # the perf tests that build a full-size model, one at a time
npm run proof-packs -- origin/main HEAD   # the proof-pack commit rule over a range
```

`BIM_DEV_PORT=3096 npm run demo` starts the demo on another port.

## Repository map

Package names use the `@permitzip/bim-*` prefix. Tagged releases publish
them to GitHub Packages (see [docs/RELEASING.md](docs/RELEASING.md)). To
change the code, work in this workspace.

**Foundations**

| Package | What it does |
| --- | --- |
| `packages/bim-units` | Typed quantities: dimensions, quantity kinds, a unit registry for every trade, explicit conversion, display profiles. No dependencies. |
| `packages/bim-formula` | A small, pure formula language over fields with units, for schedule columns, tags and library calculations. |
| `packages/bim-geometry` | Solid programs (profiles, extrude, revolve, join, cut, intersect) turned into triangle meshes with manifold-3d, with a mesh cache. |

**Kernel**

| Package | What it does |
| --- | --- |
| `packages/bim-kernel` | The model engine: element kinds and types, intent commands, connected routing, propagation, validation, derived values, the commit policy, the sheet scene graph and the add-on extension points. Runs the same in the browser, on a server and in workers. |

**Services on the kernel**

| Package | What it does |
| --- | --- |
| `packages/bim-sync` | Backend-neutral sync: the wire protocol, the sequencer, the commit store contract (leases, idempotency), group commit, the client with catch-up, and the authorization contract. |
| `packages/bim-sheets` | Vector PDF output for sheets, and IFC plan backgrounds cut on Node. |
| `packages/bim-ifc` | IFC 4.3 export: kernel model to STEP Part 21, reading the add-on registries so anything an add-on defines exports with no exporter change. |
| `packages/bim-calc` | Calculation plugins: one deterministic, unit-typed interface for every trade, with versioned code and design-criteria packs. Every result names the clause or method it rests on. |
| `packages/bim-lint` | Coordination checks over a model revision: clashes, equipment placement, nearby elements, document checks. Read-only. |
| `packages/bim-library` | The firm library format (classes, fields, calculations, schedule and tag templates, scripts), layering and pinning, the add-on package format, and a file-backed library provider. |

**Add-on contract**

| Package | What it does |
| --- | --- |
| `packages/bim-pack` | The one import an add-on uses: the versioned pack contract, every extension point, a test harness and the conformance suite. |
| `packages/bim-plugin` | MutinyBIM's agent tools as an Agent Plugins 1.0 package: the tool pack catalogue, one Agent Skill and one MCP server entry per pack. |
| `packages/bim-first-party` | Installs the add-ons every host loads: electrical, plumbing and gas, mechanical, fire protection, architecture and structural. One call: `installFirstPartyAddOns()`. |

**Trade add-ons**

| Package | What it does |
| --- | --- |
| `packages/bim-pack-architecture` | Grids, walls, doors, windows, openings, floors, ceilings, roofs, columns and stairs, with joins, host voids and room bounding. |
| `packages/bim-pack-structural` | Steel beams, columns and pad footings, a small wide-flange catalogue, live loads by use, tributary areas and the gravity load path. |
| `packages/bim-pack-civil` | Storm catchments, inlets, manholes, outfalls and alignments, with rational-method runoff down a gravity network. |
| `packages/bim-pack-site` | Site constraints (setbacks, easements, flood zones, utility capacity) and parcels as records, so site rules hold before a building is drawn. |
| `packages/bim-pack-development` | Program areas and deal assumptions, and a pro forma priced with the reader's own cost source. The model never stores money. |
| `packages/bim-pack-electrical` | Panels, circuits, feeders and loads, load flow, the one-line diagram, panel schedules, symbols and electrical calcs and checks. |
| `packages/bim-pack-mechanical` | Air networks, duct design and sizing, insulation, ventilation, pressurization and make-up air. |
| `packages/bim-pack-plumbing` | Water, drainage, vent and fuel gas networks, fixture units, hydraulics, gas pressure zones, risers and isometrics. |

**Viewers and UI**

| Package | What it does |
| --- | --- |
| `packages/bim-viewer` | The browser plan editor used by the demo: plan editing, live presence and a live sheet. |
| `packages/bim-viewer-3d` | The 3D view: three.js geometry from the kernel, linked IFC references, plan cut, section box and picking. |
| `packages/bim-ui` | Brand, theme contract and provider (scoped `--mutiny-*` CSS variables), and vendored shadcn/ui primitives. |
| `packages/bim-grid` | A virtualized data grid: windowing, keyboard, ranges, clipboard, editors, frozen columns, ARIA grid. Knows nothing about BIM. |
| `packages/bim-schedules-ui` | Schedule screens: the schedule grid, the schedule builder and the library browser. |

**Tools and servers**

| Package | What it does |
| --- | --- |
| `packages/bim-script` | The scripting kit: `defineScript`, typed parameters, a recorder over kernel commands, checks, the runner contract and the `mutinybim-script` command. |
| `packages/bim-script-runner` | Runs one script per fresh Node process with the kit's caps and an empty environment. Bundles to two files a sealed host bakes into its image; `LocalScriptRunner` runs them on your own computer. |
| `packages/bim-mcp-packs` | Every tool family beyond the core as add-on packs for the tool server, each over the same caller and typed host services (where sheets are stored, the firm's part library, linked models…), with local versions for your own computer. `--packs all` serves them. |
| `packages/bim-mcp` | The tool server: a small core tool pack (run scripts, four reads), a host interface (identity, permissions, approvals, script runner, model server), an extension point for more packs, and the `mutinybim-mcp` command (stdio or HTTP). |
| `packages/bim-editor` | The Building Model editor: its screens, vendored shadcn/ui primitives, the host provider and a standalone host for this computer. |
| `packages/bim-editor-host` | The host contract the editor runs on (model server address, identity, storage, optional services) and its conformance check. |
| `packages/bim-devserver` | The dev server and demo editor: an in-memory sequencer behind the real sync protocol. Not a production service. |
| `services/bim-authority` | The model server: sign-in first, one lease-holding owner per model, durable commits in Postgres, live sync and live schedules over WebSocket. |

## Architecture in one page

Layers, lowest first. A lower layer never imports a higher one. A test walks
every import and fails on a new violation or a new import cycle.

1. Units, formula and geometry.
2. The kernel.
3. Sync, sheets, IFC, calculations, lint and the library.
4. Add-ons, through the contract only.
5. Viewers and UI.
6. The dev server and the model server.

Every change to a model is an **intent command** (`route_run`, `move_elements`,
`create_level`, …). A client runs the command locally to preview it. The server
runs the same command again on the current model with its own code, checks for
conflicts with edits made since the client's base revision, and commits a
**changeset**. Everyone else receives the changeset. People and agents use the
same commands and the same checks.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/ADD-ON-CONTRACT.md](docs/ADD-ON-CONTRACT.md),
[docs/SCRIPTING.md](docs/SCRIPTING.md),
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Working with AI assistants

MutinyBIM is agent-first. Connect Claude, ChatGPT, Cursor or any other MCP
client to the tool server and ask it to change the model:

```bash
npm run mcp:http    # or let your assistant start `npm run mcp` itself (stdio)
```

The tool server has a deliberately small tool list. Its main job is running
scripts: the assistant reads the kit's reference, writes a script, checks
it, runs it for a preview that changes nothing, and lands it after you
approve in your assistant. Walls, routes, equipment, circuits, sheets and
schedules are kit functions inside a script, not more tools, so the
assistant's context stays small however much the kit grows. Setup for each
assistant and a worked example: [docs/CONNECT-AN-AGENT.md](docs/CONNECT-AN-AGENT.md).

Assistants can also work without the tool server:

- **Scripts on the command line.** `mutinybim-script` runs a script against a
  slice of a model and checks the output.
- **The sync protocol.** A program connects to the dev server (or the model
  server) over WebSocket and sends the same commands a person's editor sends.
- **The plugin standard.** `packages/bim-plugin` describes the agent tools as
  an Agent Plugins 1.0 package: tool packs, skills and MCP server entries.

Agents never get more access than the person they act for. An agent edits
under its own name, tied to that person, and nothing lands until a person
approves it.

## Contributing

We welcome contributions from engineers, architects, contractors, developers
and software people. You do not need to be added to the repository. Fork it,
open an issue, or send a pull request. Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

- A starting task: [good first issue](https://github.com/permitzip/mutinybim/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
- Questions, ideas and show-and-tell go in [Discussions](https://github.com/permitzip/mutinybim/discussions). Bug reports and feature requests use the issue forms.
- Every commit needs a DCO sign-off (`git commit -s`). No other paperwork.
- Build on the shared kernel, never beside it. Trade logic goes in add-ons.
- Engineering calculations get the `needs licensed review` label and a review
  by a licensed professional in that discipline.

Please read [Governance](GOVERNANCE.md). Report security problems privately: see
[SECURITY.md](SECURITY.md).

## Engineering disclaimer

MutinyBIM is software, not engineering judgment. Built-in values and formulas
are labelled where they need checking for permit work, and licensed tables
(such as fitting loss databases) are not bundled. A licensed professional is
responsible for any design that relies on it.

## License and trademarks

Code is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE)
for third-party notices.

The MutinyBIM name and logo are trademarks and are not covered by the code
license. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright 2026 PermitZIP.
