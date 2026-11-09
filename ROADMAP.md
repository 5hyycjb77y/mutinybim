# Roadmap

This is the public plan. It is ordered, not dated beyond rough weeks, and it
will change as contributors join. Open an issue to propose or claim work.

## Now: the engine

In this repository today:

- **The engine.** Kernel, typed units, formulas, solid geometry, sync, sheets
  and PDF output, IFC 4.3 export, calculations, coordination lint, the firm
  library format and the add-on contract.
- **Trade add-ons.** Architecture, structural, civil, site, development,
  electrical, mechanical, plumbing and gas, and fire protection.
- **Viewers and UI kit.** Plan editor, 3D view, theme and components, data
  grid and schedule screens.
- **Scripting kit.** `defineScript`, typed parameters, checks, the runner
  contract and `mutinybim-script run | check | pack`.
- **Model server.** Leases, durable commits in Postgres, live sync and live
  schedules.
- **The Building Model editor.** `packages/bim-editor` with the host contract
  in `packages/bim-editor-host` and a standalone host.
- **Tool server.** `packages/bim-mcp`: the core tool pack (run scripts, four
  reads) over MCP on stdio or HTTP, with the local script runner in
  `packages/bim-script-runner`, and every other tool family as add-on packs
  in `packages/bim-mcp-packs` (`--packs all`).
- **Demo.** `npm install && npm run demo`: the editor on an in-memory dev
  server. No database, no Docker.
- **One-command local stack.** `docker compose up`: Postgres, the model server
  on its real store, a local sign-in and the editor pointed at that server.
- **Performance gate.** Measured budgets at 250,000 elements and the
  full-size perf tests, on every pull request that touches the kernel, sync,
  viewers, editor or model server. Absolute budgets on a calibrated runner;
  relative ones (invariants, sizes, same-run ratios) on shared runners.
- **Proof-pack rule in CI.** A commit that changes the Civil add-on's code
  changes nothing in the kernel.

## Next: weeks 2 to 5

- **The rest of the editor's services open up.** Screens that today need a
  hosted app's data (libraries, design limits, stored drawings, linked models)
  get open implementations behind the host contract.
- **Linked-reference math.** Alignment, georeferencing, placement and IFC
  conversion for linked models, as an open package.
- **A sealed script runner you can run yourself.** The runner files from
  `packages/bim-script-runner` in a container with a deny-all network, for
  hosting other people's scripts. (The local runner, a fresh capped process
  for your own scripts, ships today.)
- **Model server sign-in for any provider,** with built-in member roles
  (viewer, editor, manager), so the server runs on its own. The local stack's
  sign-in moves onto it.
- **A calibrated perf runner** for absolute budgets on every pull request
  (maintainers set `PERF_RUNNER`; until then shared runners judge relative
  budgets and absolute ones run on the reference laptop).

## Then

- **A standalone web app** that runs the editor against the model server,
  beyond the local demo page.
- **A hosted free app.** Separate accounts, usage limits, and bring your own AI
  assistant.
- **Public npm packages** under `@mutinybim/*`.

## Good places to start

Look for issues labelled `good first issue` and `help wanted`. Typical
starters:

- more units and conversions, with tests;
- starter tag types for spaces and rooms;
- script recipes and examples;
- IFC 4.3 round-trip tests on synthetic buildings;
- a "write your first add-on" tutorial.

Larger work for discipline experts:

- a fire sprinkler add-on (heads, branch lines, hazard classes), built only
  through the add-on contract;
- more structural member types and load-path checks;
- civil and site basics such as grading and utilities.

Anything that needs the kernel to grow is labelled `kernel gap`. A maintainer
pairs on those.
