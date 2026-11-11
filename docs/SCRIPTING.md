# Scripting

The scripting kit (`packages/bim-script`, `@permitzip/bim-script`) lets a
person or an AI assistant write a small TypeScript program that makes model
edits or part types. Scripts are how agents do repetitive or parametric work:
"a receptacle every 12 ft on Level 2", "a plenum in these five sizes",
"three more floors at 13 ft".

A script never edits a model directly. It produces **ordinary edits**
(`batch_edits` of kernel commands) or **ordinary part types**. The model
server re-parses and re-runs them like any other edit, and a person approves
them. Scripts never run inside a model server.

## A first script

```ts
import { defineScript, units } from "@permitzip/bim-script";

export default defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {
    count: { type: "number", label: "Floors to add", integer: true, default: 3, min: 1, max: 50 },
    height: { type: "quantity", kind: "length", unit: "ft", label: "Floor to floor", default: units.ft(13), min: units.ft(8), max: units.ft(30) },
  },
  run(ctx, v) {
    const levels = ctx.model.levels();
    let top = 0;
    for (const l of levels) if (l.kind === "level" && l.elevationMm > top) top = l.elevationMm;
    const step = units.in_(v.height, "mm");
    for (let i = 1; i <= v.count; i++) {
      ctx.edit({ type: "create_level", levelId: ctx.id("lvl"), name: `Level ${levels.length + i}`, elevationMm: top + i * step });
    }
    ctx.label(`${v.count} floors at ${units.in_(v.height, "ft")} ft`);
  },
});
```

What happens:

- `defineScript` checks the manifest (kind, parameters, presets, reads) and
  returns a definition any host can draw a form from.
- `v.height` arrives as a `Measure` with a unit kind, never a bare number.
  `units.ft(13)`, `units.in(18)`, `units.mm(…)`, `units.m(…)` build measures;
  `units.of(kind, value, unit)` builds any kind; `units.in_(m, "mm")` reads one
  back in a unit.
- Each `ctx.edit(command)` is parsed with the kernel's own command schema and
  applied to a working copy at once, so later reads see it. A refused step
  stops the run with the step number and the kernel's reason.
- `ctx.id(prefix)` gives ids that are the same on every run with the same
  script, values and model revision. `ctx.random()` is seeded the same way.
- `ctx.label(text)` is the one-line summary a person sees when approving.
- `ctx.calc(request)` runs an engineering calculation, `ctx.read(id, input)`
  an add-on's computed read (a panel's loads per phase, a rebalance or
  room-template plan, a duct size, a catalogue; `ctx.reads()` lists them), and
  `ctx.propose(id, request)` an add-on's proposer (receptacles by code
  spacing), each on the model as the script has it so far. A read's plan is
  sent with `ctx.editSteps(plan.command)`; proposed devices are placed with
  `ctx.acceptGhosts`.
- The kit's planners do what the editor's commands do, on the same working
  copy: `documents.autoTag`, `autoDimension`, `packSheet`, `oneLine`,
  `scheduleRows`, `checks.clashes`, `building.surfacesAt`. `bim_script_reference`
  has a worked example for each.

## Script kinds

| Kind | Makes | Uses |
| --- | --- | --- |
| `layout` | Edits | `ctx.edit` |
| `route` | Edits (runs) | `ctx.edit`, the `routes` helpers |
| `part` | Part types | `ctx.parts.define(typeId, definition)`, the `parts` builder |

A part script may not edit; an edit script may not define parts.

## Parameters

Parameter types: `quantity` (a unit kind and display unit; stored in SI),
`number` (optional `integer`), `choice`, `boolean`, `text`, and `part_type`
(a part type the model has). Each takes a label, an optional description, a
default, and bounds where they apply.

**Presets** are named sets of values (`{ id: "p24x12", title: "24 x 12 with a
10 in outlet", values: { … } }`). Values are resolved preset over defaults,
given values over both. An unknown name, a missing required value or one out
of range is refused in words.

## Reads: what a script may see

A script declares what it reads. The host sends only that **slice** of the
model, and reading past it is a plain error that names what to add.

| `reads` field | Gives |
| --- | --- |
| `levels: true` | Levels and the model settings (`ctx.model.levels()`). |
| `kinds: [...]` | Every element of these kinds (`ctx.model.ofKind(kind)`). |
| `ids: [...]` or `"selection"` | These elements, or the person's selection (`ctx.model.selection()`). |
| `partTypes: [...]` | Part types matching these patterns, `*` as a wildcard (`ctx.model.partTypes()`). |
| `fields`, `rows`, `calc`, `footprint` | Field values, schedule rows, calculations and level outlines (newer reads; see the kit reference). |

`ctx.model.get(id)` returns an element or errors; `ctx.model.find(id)`
returns it or `undefined`. Elements the script's own edits made are always
readable.

## Helpers

- **`parts`**: a builder for part types. Profiles (`rect`, `circle`,
  `polygon`), bodies (box, extrude, revolve, sweep, loft, imported meshes) with
  join and cut, parameters a body can follow, connectors on faces, and symbols
  per view.
- **`routes`**: run sizes (`rect`, `round`, `oval`, `pipe`), ends
  (`atConnector`, `atRunEnd`), `routes.along(ctx, spec)` for a run through
  points (the kernel places the fittings), and `routes.branch(...)` off a
  trunk.
- **`building`**, **`equipment`**, **`documents`**: walls and openings,
  spaces, placed parts, sheets and plan views.

`searchReference(query)` and `referenceMarkdown()` give the kit reference.
It is generated from the kernel's own command schemas and the add-ons in
force, so it stays correct as the kernel changes. `starterScriptItems()`
returns five worked examples to copy.

## What a script may not do

The kit checks the source before anything runs (`checkScriptSource`,
`lintScript`). A script imports only `@permitzip/bim-script`. It may not:

- load code at run time (`import()`, `require`, `eval`, `Function`);
- use the network (`fetch`, `WebSocket`, …) or the host process (`process`);
- reach the global object;
- read the clock (`Date`, `performance`) or use timers;
- use `Math.random` (use `ctx.random()`).

These rules make a run deterministic: the same script, values and slice give
the same output.

## Output

A run returns one of:

```ts
{ kind: "edits", label, steps, batches }   // batch_edits of at most 500 steps each
{ kind: "part_types", types }              // [{ typeId, definition }]
```

Steps never include a server-only command or a nested batch.
`parseScriptOutput` re-checks an output the way a server does.

## Checks

`checkScriptOutput(model, output, options)` checks an output without
committing anything, the same way on a laptop, in CI or on a server:

- each batch through the kernel's preview, in order: refused or not, what it
  would re-open, which quantities change, and a fingerprint so an approval can
  tell when the model has moved on;
- optional lint on what each batch touched;
- for part types, the kernel's part checks, a connector report and a picture
  of each view.

Before anything runs, the kit also reads a script's source (nothing is
executed) and names the line of each mistake that would only fail in a run:

- `lintScript(source)`: what a script may not do, and its shape (one
  `export default defineScript(...)`, a kind);
- `readsWarnings(source, reads)`: a call that needs model data the reads
  don't send;
- `kitUseWarnings(source)`: a kit function that doesn't exist
  (`building.rooms` when the kit has `building.room`) and a
  `ctx.edit({ type: "..." })` whose command doesn't exist, each with the
  closest real names.

The tool server's `bim_check_output` returns all three. A check costs an
assistant far less than a failed preview.

## The command line

The kit's command line has three commands:

```text
mutinybim-script run   <script.json> --slice <slice.json> [--values '<json>'] [--preset <id>] [--out <output.json>]
mutinybim-script check <output.json> --slice <slice.json>
mutinybim-script pack  <dir> [--out <file.tgz>]
```

- **`run`** runs a library script item against a slice and writes the output.
- **`check`** checks an output against a slice and prints the report. It exits
  0 when the output is clean, 1 when not.
- **`pack`** builds an unsigned library package from a folder with a
  `mutinybim.json` manifest. A person signs it to publish.

`<script.json>` is a library `script` item: key, name, version, language,
kit range, manifest, source, license and authors
(`@permitzip/bim-library`). `<slice.json>` is a model slice
(`format: "mutinybim-slice"`), made with `sliceModel(model, reads, selection,
features)` from a model you hold, for example one received from the dev
server.

The command logic is `runCli(argv, io)` in `@permitzip/bim-script/cli`. The
kit never opens files or the network itself; the Node wrapper supplies file
access and the TypeScript loader.

## Where scripts run: the runner contract

The kit defines the contract; each environment supplies a runner
(`ScriptRunner`: `id`, `limits`, `run(request)`). Every runner must provide:

- a fresh process for each run;
- no network;
- no file access beyond the kit and the run's input;
- no child processes;
- caps no larger than `RUNNER_CONTRACT`: 1024 MB memory, 30 s wall clock,
  2 MB output.

A run that hits a cap says which one (`cap_memory`, `cap_time`,
`cap_output`) and is not retried unchanged. `script_error` means the script
threw; `runner_error` means the runner failed. `runFailureWords` turns any
failure into plain words.

Two mistakes in a script used to look like a runner failure, and now say
what they are (`script_error`, with the script's line when there is one):

- an async call the script didn't `await` that then threw: "… (thrown by an
  async call the script didn't await: put await in front of it)";
- `run()` waiting on something that never finishes: "The script ended
  without a result: run() is waiting on something that never finishes".

A `runner_error` that remains is the machine's (it didn't start, or it was
stopped from outside, most often for memory), and its words say so: run the
same script once more, don't rewrite it. A script error longer than 3,500
characters is cut, and says how much, instead of being refused whole.

`runRunnerConformance(runner, targets)` proves a runner meets the contract:
limits, fresh process, determinism, no network, no files, no child processes,
and each cap. `packages/bim-script-runner` is the runner:
`LocalScriptRunner` runs each script in a fresh Node process with
Node's permission model, an empty environment and the caps, on your own
computer (the tool server uses it; Node cannot deny a process the network,
so it is for your own scripts only), and the same two bundled files run on a
sealed machine with a deny-all network for a host that runs other people's
scripts. The kit's `runScript` still runs a script in the current process,
for tests.

## Provenance

Part types made by a script carry where they came from: the script, its
version and content hash, and the values used (`partTypeItemsFromRun`).
`regenerate` re-runs a saved script and says whether each part type still
matches.

## Scripts in other languages

`scriptJsonSchemas()` returns JSON Schemas for the manifest and the output, so
a builder in another language can produce output that `checkScriptOutput`
accepts.
