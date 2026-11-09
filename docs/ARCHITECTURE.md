# Architecture

This page explains how MutinyBIM is put together: the layers, how an edit
travels from a person or an agent to everyone else, where add-ons plug in, and
how we keep it fast at a million elements.

## Layers

Each layer may import only the layers below it. A test
(`packages/bim-kernel/src/__tests__/import-layers.test.ts`) walks every runtime
import in `packages/bim-*` and `services/bim-authority`. It fails on a new
import cycle or a new layer violation. Its baseline file lists today's few
known debts; that list may only shrink.

```text
 6  bim-devserver · services/bim-authority            run models, serve clients
    bim-mcp · bim-mcp-packs · bim-script-runner       serve agents, run their scripts
 5  bim-viewer · bim-viewer-3d · bim-ui · bim-grid    browser screens
    bim-schedules-ui
 4  bim-pack-* · bim-first-party                      trades, through bim-pack only
 3  bim-sync · bim-sheets · bim-ifc · bim-calc        services built on the kernel
    bim-lint · bim-library · bim-script · bim-plugin
    bim-pack (the add-on authoring surface)
 2  bim-kernel                                         the model engine
 1  bim-units · bim-formula · bim-geometry             pure primitives
```

The diagram is the intended shape. The rules the test enforces are:

- The primitives (units, formula, geometry) import nothing above them.
- The kernel imports no package built on it.
- Inside the kernel, the schema layer (registry, types, parts) imports no
  domain code (connections, routing, load points), and the edit spine
  (`command-core.ts`) imports no command module and no derived output
  (schedules, drawing, diagrams, 3D views). Domains register their commands
  through the spine's handler table.
- Every other package imports the kernel through its public entry
  (`@permitzip/bim-kernel` or a subpath in its `exports`), never a relative
  path into its source.

Separate tests keep the kernel trade-neutral: a ratchet counts trade words in
the kernel's source, and that count may only go down. Proof add-ons (civil,
structural) have tests that they need no kernel edits.

## The model

A model (`ModelState`) is a revision number, a map of **elements** by id, the
**connections** between them, and model **settings**. Everything is a plain,
serializable record.

- **Element kinds** are rows in a registry. The kernel owns a small set of
  generic kinds (levels, run segments and fittings, parts, spaces, zones,
  views, sheets, annotations, records). Add-ons register their own kinds,
  with their stored shape, their ends, how they draw, and their checks.
- **Types and parameters.** Elements can share a type. A value on the element
  wins over its type's value. Add-ons add parameter sets; every parameter
  names a unit kind.
- **Connected networks.** Runs (duct, pipe, conduit) are straight segments
  joined by fittings. Each end holds a link to what it meets, and the far side
  links back. An edit reads and writes only the elements it touches. Network
  adapters (from add-ons) walk and total flows, loads and other quantities.
- **Organization.** Every element is in a group and is built in a phase,
  optionally demolished in a later one. Locked groups refuse edits.
- **Partitions.** Elements fall into partitions (by level and area, plus a
  model-wide one). A client can load only the areas it needs.
- **Records without geometry.** Site constraints, program areas, questions,
  submittals, gates and sign-offs are model records too, so they sync, merge
  and undo like everything else.
- **No money in the model.** Models hold quantities. Prices come from the
  reader's own cost source at read time.

## How an edit travels

Every change is an **intent command**: a small JSON object such as
`{ "type": "create_level", "levelId": "lvl-2", "name": "Level 2", "elevationMm": 4000 }`.
Commands are defined with zod schemas, and the kernel parses every command
with its schema before it runs.

```text
 person or agent                   model server (or dev server)          everyone else
 ───────────────                   ─────────────────────────────          ─────────────
 build a command
 executeCommand() locally  ──────▶  receive { command, baseRevision,
 (instant preview)                    idempotencyKey, actor }
                                    planCommit():
                                      1. re-run the command on the
                                         current head with trusted code
                                      2. conflict if an authored field it
                                         sets changed since baseRevision
                                      3. derived values recompute;
                                         intent recorded since the base
                                         must still hold
                                    commit the changeset  ──────────────▶  apply changeset
 receive the outcome  ◀──────────   "committed" (maybe rebased), or
                                    "rejected" with a code (conflict,
                                    refused…) and a message in words
```

Points worth knowing:

- **The server never trusts the client's result.** It re-runs the command on
  the current model. What the command read and wrote comes from that run.
- **No last-write-wins on intent.** If two people set the same authored field
  differently, the later one gets a conflict and decides. Derived values (a
  flow total) just recompute.
- **Idempotency.** Every request carries an idempotency key. A retry gets the
  same answer. A reused key for a different change is refused.
- **Batches.** `batch_edits` runs up to 500 steps as one revision and one undo
  step. Scripts produce their output as batches.
- **Agents are actors.** An actor is a person or an agent. An agent acts for a
  person (`agent:<userId>:<runId>`), gets exactly that person's capabilities
  and never more, and is its own editing session.
- **Sessions.** Each browser tab or agent run is its own session. The same
  person in two tabs can conflict with themselves, as two people would.
- **Refusals are in words.** A refused command says why in operator language
  ("Leg 3 is 0.51 ft long, but the elbow and transition there need 1.27 ft").

## Sync

`packages/bim-sync` is backend-neutral. It defines:

- the **wire protocol** (`protocol.ts`): the client sends `hello` (actor,
  last revision, optional token, model id, loaded areas, protocol features),
  then `command`, `heartbeat`, `sync`, `interest` and `presence` messages; the
  server sends `welcome`, `changeset`, `outcome`, `head`, `advance`, `area`,
  `presence` and `denied`. Branches, merges, quantity comparisons and live
  schedules add their own messages.
- the **sequencer**, which decides commits one at a time against the head;
- the **commit store** contract: leases with fencing, idempotency and an
  atomic decide-and-write. `InMemoryCommitStore` backs the dev server;
- **group commit**: edits are shown to others as soon as they are decided and
  written in batches; the author hears "saved" only once the batch is durable;
- the **client** (`SyncClient`): local prediction, catch-up after a dropped
  connection, presence and save state;
- the **authorization contract** (`authorization.ts`, `AUTHORIZATION.md`):
  three capabilities, `model.read`, `model.edit` and `model.issue`, answered by
  a host-supplied `ModelAuthorizer`. A built-in `NativeModelAuthorizer` gives
  each model members with viewer, editor or manager roles.

**Protocol features.** Clients and servers advertise the features they read.
A writer stores a newer shape only when every peer reads it. Readers are
tolerant: they keep values they do not know. This lets a newer server run
beside older browsers during a rolling deploy.

### The two servers

- **Dev server** (`packages/bim-devserver`): one process, an in-memory store,
  a sequencer and a hub on `ws://localhost:3095/sync`, plus the demo editor
  bundled with esbuild, PDF export and a metrics page. No sign-in. For local
  work and demos only.
- **Model server** (`services/bim-authority`): the production shape. A person
  signs in before the server touches a model. One process owns each model at a
  time through a database lease judged by the database clock; every durable
  write checks the lease in the same statement, so a stale owner cannot write.
  Access is re-checked every few seconds, and a person who loses access is
  disconnected or made read-only mid-session. Clients are routed to the
  process that holds the model. It also evaluates live schedules over the
  whole model and patches them as commits land. Its schema lives in
  `services/bim-authority/db/migrations` and is applied by its own migrator.

Today the model server verifies sign-ins from a Supabase Auth project and asks
a pluggable authorizer what the person may do. Sign-in from any identity
provider is on the roadmap.

## Add-ons

An add-on (also called a pack) is a namespace plus contributions to
versioned **extension points**. The kernel, lint, calc and library layers each
declare their points next to the code that reads them. `@permitzip/bim-pack`
re-exports all of them in one place.

Kinds of points, in short (full list in [ADD-ON-CONTRACT.md](ADD-ON-CONTRACT.md)):

- **What exists:** classes, element kinds, parameter sets, services, pipe
  materials and products, connector end types, fitting families, catalog
  entries, part types, library rows.
- **How it behaves:** commands, command builders, reads, network adapters,
  derived zone rules, route constraints, rating kinds, line joins, host voids,
  bounding elements.
- **How it is checked and calculated:** lint rules, calcs, code editions,
  design limit defaults, calc sheets, finding sources.
- **How it looks and exports:** symbols, plan graphics, view graphics, diagram
  layouts, IFC import rules and relations.
- **What agents can do:** agent tool descriptors (data only) and agent tool
  packs.

**Pack sets.** A `PackSet` is an immutable set of packs built once when a
model opens and bound to that model. Kernel code reads the set in force
(`activePackSet()`), so one process can serve many models with different
add-ons, and a pack bound to one model never reaches another. Tables derived
from a set are built once per set.

**First-party add-ons** (electrical, plumbing and gas, mechanical, fire
protection, architecture, structural) are installed in every host by
`installFirstPartyAddOns()` and sit under every model's own set. Their stored
ids predate the contract, so they keep bare ids; every other add-on namespaces
its ids as `<pack>.<name>`.

**Pins.** A model stores the add-ons it uses with their exact versions. A host
that lacks one says so by name ("This model uses Zoning 1.2.0, which isn't
installed") and keeps the records it cannot read.

## Agent tools

`packages/bim-plugin` is the one place that says which agent tools belong to
which tool pack. It renders an Agent Plugins 1.0 package: `plugin.json`,
`mcp.json` (one MCP server entry per pack, under a base URL you choose) and
one Agent Skill per pack. Tools are named `bim_<verb>` for first-party tools
and `<pack>_<verb>` for others. A host serves each pack at
`<base>/packs/<slug>/mcp`.

`packages/bim-mcp` is the tool server: the one implementation of the core
tools, used by this repository's local server and by any product that hosts
MutinyBIM.

```text
 MCP client (Claude, ChatGPT, Cursor, …)
      │  stdio or streamable HTTP
      ▼
 bim-mcp ── core pack: bim_script_reference · bim_check_output · bim_run_script
      │                bim_apply_output · bim_save_part_type
      │                bim_model_summary · bim_query_elements · bim_inspect_network · bim_validation_issues
      │     add-on packs (BimToolPack), registered after the core: bim-mcp-packs
      │       (parts · routing · trades · views · drawings · library · coordination · models · calc)
      │
      ├── host.models ─────────► model server (sync protocol, as the person)
      ├── host.runner ─────────► bim-script-runner: one fresh capped process per script
      ├── host.approvals ──────► the person decides before anything lands
      └── host.library / authorize / author
```

- **Script execution first.** The agent writes a script with the kit, checks
  it, runs it for a preview that saves nothing, and lands it after a person
  approves. A landing re-runs the script and lands only what was previewed
  (same output hash, counts and risk tier) as one undo step; a moved model
  answers `stale_preview` and nothing lands. Everything else a model can do is
  a kit function, so the tool list stays small.
- **The host decides five things** (`BimToolHost`): who is calling, whether
  they may (model read before a read, model edit before an edit, a script
  run, a library save), how a person approves, where scripts run, and how the
  model server is reached. The tools never decide those themselves.
- **Scripts never run in the process serving the tools.** The local host
  runs them in a fresh capped Node process on your own computer (not
  network-sealed; your own scripts only). A host serving other people runs
  the same runner files on a sealed machine with a deny-all network.
- **Add-on packs work through a caller.** Every pack tool resolves a caller
  (`ResolveBimCaller`: the host's sign-in and permission check, then a
  session on the model server as that person, plus the host's gate before an
  edit) and takes any other service it needs as a typed capability (sheet
  PDF store, firm part library, linked models, adopted code editions…). A
  pack never reaches into its host.
- **The local host** (`@permitzip/bim-mcp/local`) is one person on their
  own computer: an in-memory model server (or a running one), approvals asked
  through the client with MCP elicitation, the local runner.

How to run it and connect an assistant: [CONNECT-AN-AGENT.md](CONNECT-AN-AGENT.md).

## Performance approach

MutinyBIM is designed for large buildings and many editors from the start.
The target sizes are 250,000 and 1,000,000 elements.

- **Incremental by default.** An edit reads and writes only what it touches.
  Network totals, indexes and caches are carried forward from the changed ids
  (`registerRevisionCarry`), never rebuilt model-wide on a hot path.
- **Indexed reads.** Spatial grids, partition indexes, class indexes and
  boundary indexes answer "what is near this" without scanning the model.
- **Structural sharing.** Model records are frozen and shared between
  revisions, so a commit copies only what changed.
- **Shared evaluation on the server.** One live schedule evaluation serves
  everyone who has it open, and updates are batched off the commit path.
- **Small first download.** Heavy kernel features live on subpaths (for
  example `@permitzip/bim-kernel/rated-routes`, `/calc-sheets`, `/schedules`),
  and each first-party add-on has a slim `/host` entry, so the editor loads
  quickly.
- **Measured budgets.** Performance tests in the packages assert time budgets
  at scale, and the perf gate checks every row of
  `docs/perf/mutinybim-budgets.json` ([PERFORMANCE.md](PERFORMANCE.md)). A
  budget is never raised to get a green build. If a hot path in
  TypeScript is still too slow after a real fix, it may move to Rust compiled
  to WebAssembly behind the same interface, with measurements in the pull
  request.
