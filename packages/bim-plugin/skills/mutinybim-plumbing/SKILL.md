---
name: mutinybim-plumbing
description: "MutinyBIM pack for plumbing loads and design: fixture load points on open pipe ends and taps, connection types, the plumbing catalogue (pipe types), each pipe system's look and sizing, the project's sizing and demand curve. Use with the mutinybim core; riser diagrams are in the electrical pack. Trigger on: fixture units, load point, DFU, WFU, pipe type, pipe system sizing, demand curve."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the plumbing family turned on (bim_enable_pack, --packs plumbing, or /packs/plumbing/mcp under the MutinyBIM base)."
metadata:
  pack: "plumbing"
  mcp-server: "mutinybim"
  family: "plumbing"
  token-cap: "6300"
  tools: "bim_place_load_points bim_edit_load_point bim_save_connection_type bim_plumbing_catalog bim_plumbing_design"
---

# MutinyBIM: plumbing load points and connection types

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (say the change, edit with `base_revision`, report the server's answer).
Part placement and the pictures are the `model` family. Draw the pipes with
`mutinybim-ducts-pipes` (or a script); read what they carry
(`bim_pipe_report`) with `mutinybim-calcs`.

## The idea

A load point is what is connected at an open pipe end (or a tap) before, or
instead of, a modelled fixture: "the end of this 2" waste is a P01 water
closet, 5 DFU". It names a **connection type** (the catalog record: P01,
K07, FD3) and may override its values. Every pipe then carries the loads
beyond it, live, the same numbers the pipe report uses.

- **One point per pipe end, per system.** A hand sink has a cold, a hot and
  a waste point. Give them the same `mark` ("K01-2"): the pipe that carries
  both sides (the service, above the water heater) then counts the
  fixture's **total** WSFU (2), not cold + hot (3).
- **A fixture attached later** takes the point's connection type and its
  loads come from the point: one record, two views. Edit either; totals do
  not double. Detaching keeps the point.
- **A lump** ("whole kitchen, 30 DFU", `schematic: true`) breaks out onto new
  points later; what the new points take comes off the lump, so every total
  stays the same.
- **Ducts too**: a 150 CFM point on a tap's open branch adds 150 CFM to the
  trunk, before any air device is placed.
- A point belongs to the pipe end the person named. Attach a fixture only to
  the point the person names; never attach by nearness, and never pick a
  fixture, heater or interceptor model for them.

## Tools

Reads in other families:

- `bim_query_elements` kind `service_catalog` (core, read): The project's connection types, every trade, with their loads
- `bim_query_elements` kind `load_point` (core, read): Every load point: what it is on, its connection type, its loads, its fixture, and `host` lost / continued when its pipe was deleted or now runs on past it
- `bim_pipe_report` (`mutinybim-calcs`, read): What every pipe carries (`pipes[].fixture_units`), the system total, design flow, and warnings (a point with no value for its system)

| Tool | Use it to |
| --- | --- |
| `bim_save_connection_type` (approval) | Add or change a connection type: `designator`, `trade`, `description`, `quantities` { `wsfu_cold`, `wsfu_hot`, `wsfu_total` (the code's combined value), `dfu`, `gph_demand`, `gpm_fixed`, `mbh`, `min_inlet_pressure`, `cfm`, `sizes` { cw, hw, w, v, g }, `custom` [{ name, unit, value }] }. A bare number is in the quantity's unit (`min_inlet_pressure` is **psi**); write text with a unit to be sure: `"7 in. w.c."`, `"2 psi"`. A gas minimum above 14 in. w.c. saves with a warning (it is nearly always in. w.c. written as psi). `replaces` renames it (points and fixtures follow); `delete` removes one nothing uses |
| `bim_place_load_points` (approval) | One batch of points (up to 500): each `pipe_id` + `end` ("start" / "end" of a segment, "branch" of a tap), `connection_type`, optional `values`, `mark`, `schematic`, `note`. The end must be open. A starter type (WC-FT, WC-FV, UR, LAV, HS, SK1–SK3, MS, FD, FS, TD, HB, DF, IM, DW, G-RANGE, G-FRYER, G-GRILL…) the project lacks is added with the points, labelled "verify for permit work". A point whose type has no connection for the pipe's system (a gas range on a sanitary pipe) refuses the batch, naming the point; the result lists each point with its pipe, mark, type, system and loads, so check them against the plan |
| `bim_edit_load_point` (approval) | `action`: `edit` (`connection_type`, `values` merged on, `reset` to drop own values; `part_id` instead of `load_point_id` edits every point of that fixture), `attach` (`load_point_id` + `part_id`), `detach`, `split` (`into`: new points with the values each takes), `delete` (`load_point_ids`); `served_by` / `clear_served_by` on `edit` names or drops the load's source (WH-1, the gas meter, panel P1) before anything is drawn; `create` (`loads`: each with an `anchor` — `{kind:"space",id}` or `zone` for an estimate, `part`, `run_end`, `point`, or none for a row — `values`, `connection_type`, `service`, `mark`); `move` (`load_point_id` + `to`: same id, estimate → point → device); `policy` (`max`, the default: an estimate counts until the devices inside it add up to more). `load_point_id` takes any load id, not only `lp:` ones |
| `bim_plumbing_catalog` (read) | Pipe types (firm and this project's: material, spec, sizes, joint, systems, the fitting in each slot), every pipe system's colour, line pattern, weight and own sizing, the project's auto-sizing, building type, demand curve and pipe insulation schedule, and the **stacks**: each named one by number, then drawn vertical runs tall enough to be one ("not named yet"), with `tag` (`4"//S/K/L//19`), `pipe_id`, size and DFU at the base, rooms served, and per floor size, DFU and offsets; `stacks_lost` says when a named stack's pipe was redrawn |
| `bim_plumbing_design` (approval) | One change by `action`: `system_look` (`system`, `colour` #rrggbb, `pattern`, `weight`; null = standard), `system_sizing` (`system`, `sizing_mode`, `demand_curve`; null = the project's), `project` (`sizing_mode`, `building_type`, `demand_curve`, `insulation_schedule` [{ system_kinds, below_in, thickness_in, material }] with `insulation_source`: the energy code's table isn't in the code library, so use the firm's spec or the starter the Plumbing tab offers, and say where it came from), `save_pipe_type` (`pipe_type` { name, material, spec, system_kinds, min_in, max_in, joint, fittings, note }, `replaces`), `delete_pipe_type` (`name`) |

**Stacks.** Name, number or rename them through the model family's
`bim_preview_views_sheets_edit` → `bim_apply_views_sheets_edit`:
`name_stacks { stacks: [{ stackId, pipeId, number?, name? }] }` (any vertical
pipe of the run; no `number`: the next free one), `edit_stack` (`systemCode` /
`serves` override the tag's letters; `null` goes back to derived),
`delete_stacks` (names only; the pipe stays). The base-of-stack check
(`set_stack_checks { baseClearanceDiameters: 3 }`, the firm's 3-pipe-diameter
rule) is off by default: turn it on only when the person asks.

**Grease routing.** The sewer authority decides which kitchen fixtures go
through a grease interceptor. It lives on the sewer connection part (the
existing manhole or tie-in) as `sewer_authority`: read the project's
`code_study_plumbing_locality` and set it with `bim_set_parameters`; never
guess one. Findings `grease-fixture-bypasses-interceptor`,
`grease-fixture-not-routed`, `grease-authority-unknown` come back in
`bim_lint_check`; fix a route by naming the interceptor as the fixture's
source (`bim_edit_load_point` `served_by`).

A point's id is `lp:<pipe id>:<end>`. A run segment's `start` / `end` facts
in `bim_query_elements` say "open, load point …" when one sits there.

## The order an agent calls them

1. Read the fixture list the person gave (a schedule, a PDF table, a paste).
   `bim_query_elements` kind `service_catalog`: which connection types exist.
2. `bim_save_connection_type` for each type missing, with the values from
   the person's schedule (not from memory; starter values are placeholders).
3. Find the open pipe ends (`bim_query_elements` kind `run_segment`, ends
   with no link) the person means for each fixture; ask when it is unclear.
4. `bim_place_load_points` once, with every point.
5. `bim_pipe_report` for the sanitary, cold and hot systems: check the
   totals against the person's schedule (the service WSFU total, the DFU at
   the outfall) and say both numbers.
6. Later, a fixture placed (`bim_place_part`): `bim_edit_load_point`
   `attach` to the points the person names; the report reads the same.

## Systems, sizing and pipe types (the Plumbing tab)

- **Look.** Each system kind has a standard look (cold water blue dash-dot,
  hot red, vent green dashed, gas yellow long dash, sanitary brown solid);
  3D, plans and print all use it. Change one system's (a grease waste line
  heavy) with `system_look`; null puts the standard back.
- **Auto-sizing is off** ("check": every pipe audited, sizes suggested,
  nothing changes) until the person asks. `project` `sizing_mode: "auto"`
  turns it on; a system can keep its own (`system_sizing`). On auto, turning
  it on and every later edit that touches the system resize its pipes (water,
  sanitary, gas), each system's resize its own undo, and the tool result says
  "Auto-sized N pipes on …". Auto needs the project's plumbing or fuel gas
  code: without it the edit still saves, sizes don't change, and the result
  carries `sizing: { applied: false, reason, systems, fix }`. "Saved" is not
  "sized"; read that field, and record the code in the Code Study (ask the
  person which edition) before relying on auto.
- **Demand curve.** `building_type` picks it (restaurant: ASHRAE Curve A);
  `demand_curve` overrides, per project or per system.
- **Pipe types.** A type's fittings follow its material unless `fittings`
  picks one (ids from `bim_list_fitting_types`). Saving a firm type's name
  makes a project copy; deleting it brings the firm's back.

Order: `bim_plumbing_catalog` → say the change → `bim_plumbing_design` →
`bim_plumbing_catalog` again and report what changed.

## Risers and isometrics (live, from the piping)

A riser is a drafting view that stores only its kind and hints; it is drawn
again from the routed pipe every time, so a new fixture, a resize or a moved
branch shows on it in the same revision. Never draw risers with drafting
lines.

With the electrical family turned on:

- `bim_preview_one_line` (`mutinybim-electrical`, read): `from_model: true`, `kind` `plumbing_riser` (mains, a branch per fixture, stacks by floor, devices on the line) or `plumbing_isometric` (every pipe projected at 30° from the model), `new_view_name` or `view`, `hints`, `place_on`. Returns `equipment` (fixtures, devices, sources), `pipes` (each model pipe: the id a click on it selects, and how many drawn `pieces` light up for it), size, `preview_token`
- `bim_layout_one_line` (`mutinybim-electrical`, approval): Save exactly what was previewed

Hints: `systemKinds` (a typical set: `["sanitary","vent"]`, `["domestic_cold_water","domestic_hot_water"]`, `["natural_gas"]`), `pipeLabels` (`size`, `load`, `slope`, `invert`, `length`; default: drains size + DFU + slope, water size + WFU, gas size + MBH + LF), `hidden` (a fixture's or system's id), `pins`, `textOffsets` (move one label: keys from the preview's `texts`).

What it shows: the sources the pipe report counts from (meter, water heater,
gas entry; `TO SEWER` at a drain's outfall; `THRU ROOF` on a vent), running
loads where they change (the sanitary main's 20 → 26 → 59 → 88 DFU), each
fixture's own load, sizes, slopes, gas lengths, cleanouts and shut-offs. Hot
water leaving the heater on the cold line is one riser. Vents print dashed.
`NO SOURCE CONNECTED` / `NO OUTFALL CONNECTED` means that piece of pipe isn't
joined to a source yet: say so, don't hide it.

1. `bim_pipe_report` for each system: the riser prints these numbers.
2. `bim_preview_one_line` with `kind` and `systemKinds`; check `pipes` and
   `equipment` against what the person expects.
3. `bim_layout_one_line` with the preview's `base_revision` + `preview_token`.
4. `bim_render_view_image`; if crowded, change hints, never the drawing.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_place_load_points` |
| `bim_edit_load_point` |
| `bim_save_connection_type` |
| `bim_plumbing_catalog` |
| `bim_plumbing_design` |

<!-- end tools -->
