---
name: mutinybim
description: "MutinyBIM core: read and change a MutinyBIM building model by writing scripts with the open-source kit. The kit's reference (organised by task, each with a worked example), checking a script, a preview run that saves nothing, landing the result after the person approves, saving a part script's parts; and four reads (model summary, element queries, networks, validation issues) to look before writing. Every change pauses for the person's approval and is decided by the model server. Activate it first; it names the opt-in tool family for each job that has no script yet (model, drafting, ducts and pipes, electrical, plumbing, views and sheets, coordination, groups and phases, parts, calculations, schedules). Trigger on: building model, MutinyBIM, BIM model, script, place a part, route a duct, what's in the model, validation issues, make sheets."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server from this package (/mcp under the MutinyBIM base)."
metadata:
  pack: "core"
  mcp-server: "mutinybim"
  family: "core"
  token-cap: "3500"
  tools: "bim_script_reference bim_check_output bim_run_script bim_apply_output bim_save_part_type bim_model_summary bim_query_elements bim_inspect_network bim_validation_issues"
---

# MutinyBIM core

MutinyBIM is an open-source, browser-based building model for every trade:
architecture, structure, mechanical, electrical, plumbing, fire protection,
and the owner and contractor who price what is built. People edit a model
live in the browser; you edit the same model through the same model server,
with the same rules. The server decides every change against the latest
revision. Your job: read carefully, plan from what you read, show the person
the change, and report exactly what the server answered.

## Script first: the script API is the product

Do the job with a script. A script is TypeScript that imports only
`@permitzip/bim-script` and returns either **edits** (ordinary model
commands, one undo step) or **part types**. The core tools are:

| Tool | Use it to |
| --- | --- |
| `bim_script_reference` | First in a thread. Says whether a script machine is ready here (`script_machine.ready`), then the kit by task (`search`: sheets, schedules, rooms, levels, walls, duct and pipe routing, equipment, tags, dimensions, checks, imports, calculations, each with a worked example), one command's exact fields (`command`), and the saved and starter scripts (`library: "list"` / `"read"` with `key`). Reads only |
| `bim_check_output` | Lint and syntax findings for a `script`, each with its line (with `model_id`, also what its reads would send); or the kernel's checks on an `output` change set. Saves nothing |
| `bim_run_script` | Run the script as a **preview** on a sealed machine: what it creates, changes and deletes, or the part types it makes, plus `apply_with`. Saves nothing |
| `bim_apply_output` (approval) | Land a previewed edits result: call it with `apply_with.args` unchanged. The script runs again and lands only if its output is exactly what was previewed, as one undo step. An agent that ran the open kit in its own sandbox sends `output` and `provenance` (`script_hash`, `kit_version`, `client`) instead of `script`; the kernel checks every step again and the person still approves |
| `bim_save_part_type` (approval) | Save previewed part types to the firm library (with `save_as`, also the script version that made them, unapproved). Asks every time |
| `bim_model_summary` | Start here: counts by kind, levels, zones and disciplines, systems with total airflow, open issues, `notPlacedYet` (parts that exist but are not drawn yet), open questions and the **revision** |
| `bim_query_elements` | Elements by kind (any kernel kind, `space`, `zone`, `drawing_underlay` and `question` included), `class` (a registry class id and its subclasses), level, zone, discipline or ids, with sizes, positions, airflow and connector ids. An unknown class is refused with close ids |
| `bim_inspect_network` | One element's connections and its path up to the equipment, with airflow per piece |
| `bim_validation_issues` | Open issues (disconnected connectors, undersized branches…) and the elements involved |

### The workflow: reference → write → check → preview → approve

1. **`bim_script_reference`** with no arguments. If it says
   `ready: false`, **do not write a script**: tell the person why, and do the
   job with a family's tools (below). Then search it for the task:
   `bim_script_reference({ search: "rooftop unit" })` returns the recipe and
   the kit functions with a working example each.
2. **Read the model** with the four reads: `bim_model_summary`, then
   `bim_query_elements` on one level or zone. On large models always pass
   `level` (and `zone`); never load a whole model to answer a question about
   one room.
3. **Write the script.** Start from the example of each function you use.
   Declare exactly the `reads` it needs (levels, kinds, ids or `"selection"`,
   part types). Every length is a measure (`units.ft(10)`), never a bare
   number.
4. **`bim_check_output`** with `script`. Fix every finding.
5. **`bim_run_script`**. A failure names the script's line ("Line 14: Step 3
   (route_run) was refused: …"). Tell the person in plain words what the
   preview does: how many things it creates, changes and deletes, the label,
   any check that failed; for part types, each part and its connectors.
6. **Approve.** Only when the status is `previewed`, call the tool in
   `apply_with.tool` with `apply_with.args` **unchanged** (`bim_apply_output`
   for edits, `bim_save_part_type` for parts). It waits for the person's
   approval. Report the saved revision, or the refusal, word for word.

`has_issues` or `refused`: nothing changed; fix the script or the values and
preview again. `stale_preview`: the model moved; run it again and show the
new preview. One result is one undo step of at most 500 steps; split bigger
jobs.

**Prefer one script for repeated steps.** Connect twelve fixtures to a drain,
place and duct six units, a sheet and a plan view per level, walls with
their doors and windows: one script that reads once and loops gives one
preview, one approval and one undo, for a fraction of the tokens of dozens of
single calls. Use a family's single tools for one or two edits.

### The kit

`import { defineScript, units, routes, parts, building, equipment, documents } from "@permitzip/bim-script"`

- `units.ft / in / mm / m / of`: every length is a measure.
- `parts.part(name, { type, category })` → `box` / `cylinder` / `transition`
  → `connector(face, { id, label, domain, systemKind, shape, size…, endType })`
  → `ctx.parts.define(typeId, builder.build())`, in a **part** script only. A
  layout or route script uses part types by listing their ids in
  `reads.partTypes` and placing them with `equipment.place`; it never calls
  `ctx.parts.define`. Duct connectors need an end
  type (`mechanical.slip`, `mechanical.flanged`, `mechanical.formed_flange`);
  pipe ones too (`plumbing_gas.sweat`, `plumbing_gas.threaded`, …).
- `building.level`, `building.walls`, `building.floor`, `building.door`,
  `building.window`, `building.space`, `building.spaceInWalls`,
  `building.ceiling` (outline and height as `units.*` values).
- **Level arguments are level ids** (from `building.level` or
  `ctx.model.levels()` with `reads.levels: true`). The kit's helpers also take
  the name of exactly one level the script read; raw `ctx.edit` commands take
  only the id.
- **Read what a helper works from.** `building.spaceInWalls` traces walls: put
  `"wall"` in `reads.kinds` unless the script draws them first.
  `bim_check_output` warns when a call needs data the reads don't send.
- **See a value with `ctx.report(label, value)`**, never by throwing an
  error: it comes back as `report` in `bim_run_script`'s answer (50 reports,
  16 KB). A script that only reports still runs.
- `units.*` values are measures, not numbers. Give them to kit helpers; a raw
  `ctx.edit` command takes plain millimetres (`units.in_(length, "mm")`).
- `equipment.place(ctx, { level, type, at })` → `placed.connector("supply")`
  is a route end.
- `routes.along` (with `slope: { rise, per }` for drains), `routes.branch`,
  `routes.drop`, `routes.connectInto`; sizes `routes.rect / round / oval / pipe`.
- `documents.sheet`, `planView`, `ceilingView`, `duplicateView`, `place` (a
  view on a sheet), `editSchedule`. There is no sheet set function: number
  the sheets in print order; the person picks the sheets when printing or
  issuing.
- Anything else: `ctx.edit(command)` with any model command; its fields come
  from `bim_script_reference({ command })`. Circuits and loads are the
  add-ons' commands; search for them.

Scripts never print or issue a set: the person does that, or the `model`
family's print and issue tools after the person says to.

### The sealed machine and its caps

A script runs on its own sealed machine: **no network, at most 1 GB of
memory, 30 s and 2 MB of output**, a fresh process per run. It reads only the
slice of the model it declares and never writes to the model itself; the
kernel checks every output before anyone sees it. A run that passes a cap is
stopped (`status: "stopped"`, `code: "cap_memory"`, `"cap_time"` or
`"cap_output"`) with `nothing_changed: true`: say which cap stopped it.
**Never run the same script with the same values on the same revision
again** (it answers `not_run: true`); read less, make less per run, or split
the job.

### Approve for this session (low risk only)

`approval` on the preview says how the result is asked for:

- `session_allowed`: a low-risk result. The person may approve it for the
  rest of the session; later low-risk results then land without asking.
- `ask_every_time`: deletes, large batches (more than 50 changes), edits
  across systems, anything touching approvals or sign-offs. Say why
  (`approval_reasons`).

Saving to the firm library always asks. Never change `approval` in
`apply_with.args`. A saved script version may be run by other agents only
after a person approves that version; you never approve a script version.

## Rules for every MutinyBIM tool

These hold here and in every family.

- **Plan from what you read.** Reads return the revision they read. Pass it
  as `base_revision` on the change you plan from it; after a saved change,
  the next one's `base_revision` is the saved revision.
- **Preview first.** `bim_run_script` and the families' previews
  (`bim_preview_part_edit`, `bim_preview_route_edit`, …) say what a change would do and save nothing, or
  `would_refuse` with the reason. Fix the plan before asking anyone to
  approve.
- **Say the change in plain words**, then make it. Every change pauses for
  the person's approval. One clear change per call.
- **The server's answer is the result.** Report it verbatim:
  - `saved` → "Saved as Rev N. Changed: …". Only now is the change done.
    `open_issues: N` means the model already had N issues your change didn't
    touch: say so, don't call the model clean.
  - `conflict` → someone changed the same thing after your read. Read again
    at `latestRevision`. If your change no longer collides, redo it on the
    new revision; if it would replace their value, say who changed what and
    ask. Never retry blindly.
  - `refused` → the message is the rule broken (for example "branch is as
    wide as its host"), with `code` and the `element_ids` involved. Explain
    it, suggest a valid alternative; do not try random variations. "doesn't
    take <key>" lists the keys and units it does take: resend with those,
    never drop the value silently.
  - `not_saved_yet` → the server could not confirm. It retries with the same
    key. Do not send a different change to compensate; read again to check.
- Never say a change was made because you called the tool, or because it was
  approved.
- **Look at what you drew.** After anything that changes a drawing, look at
  it (the `model` family's `bim_render_view_image` and
  `bim_render_sheet_image`) before saying it is done.
- **Locked groups.** Nothing in a locked group can be created, changed,
  moved or deleted, by anyone, agents included. Report the refusal word for
  word and ask whether to unlock it; never unlock a group unless the person
  asked for exactly that, and never route around a lock.
- **Never claim "clash-free", "coordinated" or "complete"** unless the
  `model` family's `bim_lint_check` ran on the scope you describe, with the
  linked models included, and returned zero errors.
- A tool whose arguments are a family of commands advertises a short form.
  `bim_describe_commands` (model family) returns the exact fields of one
  command; a call that doesn't fit is answered with the field and what is
  wrong.

## One vocabulary in every tool

- **`element_id`** names the element in every tool that takes one. Older
  keys (`tap_id`, `terminal_id`, `segment_id`, `equipment_id`, `wall_id`…)
  still work; give one, not both.
- **A number with its unit:** values take `{ "value": 22, "unit": "kA" }`
  beside a bare number. The model stores the parameter's own unit and
  refuses a unit of the wrong kind, listing the ones it takes. A bare length
  is feet; answers give heights and distances as `{ value, unit }`.
- **Levels** take the level's id or its name; a loose spelling works when
  only one level matches ("LEVEL 01" finds "Level 1"). An unknown or
  ambiguous level is refused with the candidates.
- **Units:** distances, offsets and elevations in feet; duct sizes and paper
  positions in inches; airflow in CFM; pipe by nominal inches plus material.

## Families: single-purpose tools, opt-in

The single-purpose tools come in families. Turn one on only when the
reference says a job has no script yet, or for a one-off edit: on a
MutinyBIM tool server that is `bim_enable_pack` (or connecting that family's
own endpoint); a host that loads skills turns a family on with the skill of
the same name. **Never turn on every family**: every tool is re-sent on every
step, and long tool lists confuse models. Turn one off when the task moves
on.

| Family (skill) | Turn it on for |
| --- | --- |
| `mutinybim-model` | Schedule rows, levels, views and sheets, linked models, what is under or over a point; previews of part, route and views/sheets edits; placing, moving, copying and deleting parts; pictures, printing and issuing a set; coordination lint |
| `mutinybim-views-sheets` | A drawing set: views, crops, 3D views, sheets, title blocks, viewports and layout, sheet notes |
| `mutinybim-drafting` | Dimensions, tags and tag styles, notes with leaders, detail linework and components |
| `mutinybim-ducts-pipes` | Routing, joining, resizing, sloping and insulating duct and pipe runs; fittings; terminal airflow |
| `mutinybim-electrical` | Panels, circuits, feeders, receptacle layouts, one-line and riser diagrams |
| `mutinybim-plumbing` | Load points and connection types for every trade, pipe types, each pipe system's look and sizing |
| `mutinybim-calcs` | Code calculations with citations, duct size advice, pressure and pipe reports, pipe sizing proposals, service size |
| `mutinybim-coordination` | Linking the architect's model, levels from it, coordinates, accepting findings, tracing rooms |
| `mutinybim-groups-phases` | Groups, locks, phases, demolition, phase filters; a typed element's class, type and values |
| `mutinybim-parts` | Parts from a cut sheet or a description, the firm's part library, clearance zones, hosts, mounting planes |
| `mutinybim-schedules` | Defining schedules, typing into their cells, the library of shared fields and templates |

A whole drawing set is `mutinybim-model` plus `mutinybim-views-sheets`, with
`mutinybim-drafting` when the sheets need dimensions, tags or details.
Circuiting and a one-line need `mutinybim-electrical`, and `mutinybim-calcs`
to size what they show.

## How to start

1. `bim_script_reference` (is a script machine ready?), then
   `bim_model_summary` for the revision and what is there.
2. The read that matches the job: elements on one level
   (`bim_query_elements`), a run's path (`bim_inspect_network`), problems
   (`bim_validation_issues`). Anything that depends on the architect's model
   (levels, roof heights, line-up) starts with the `model` family's
   `bim_list_linked_models`.
3. Search the reference for the task and write the script. If the reference
   has no recipe for it, turn on the one family that does.

**List first, draw second.** A part can exist before it is drawn: it waits in
the Not placed yet list (`notPlacedYet` in `bim_model_summary`) with its
circuits, schedule rows and one-line place. Check that list before saying a
job is drawn, and never invent a location to get a part onto the drawing: ask
where it goes.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this core

| Tool |
| --- |
| `bim_script_reference` |
| `bim_check_output` |
| `bim_run_script` |
| `bim_apply_output` |
| `bim_save_part_type` |
| `bim_model_summary` |
| `bim_query_elements` |
| `bim_inspect_network` |
| `bim_validation_issues` |

<!-- end tools -->
