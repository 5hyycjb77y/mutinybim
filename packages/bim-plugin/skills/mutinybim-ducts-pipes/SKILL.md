---
name: mutinybim-ducts-pipes
description: "MutinyBIM pack for duct and pipe runs: route and connect runs, flex, resize runs and stretches, slide branches, terminal airflow, move equipment, risers, fittings and offsets, elevation changes, splitting and dragging runs, system design, duct insulation, drain slope and inline pipe accessories. Duct size advice and the pressure and pipe reports are in the calculations pack. Use with the mutinybim core. Trigger on: route duct, route pipe, connect, resize, fitting, offset, elevation, slope, insulation, system design."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the ducts-pipes family turned on (bim_enable_pack, --packs ducts-pipes, or /packs/ducts-pipes/mcp under the MutinyBIM base)."
metadata:
  pack: "ducts_pipes"
  mcp-server: "mutinybim"
  family: "ducts-pipes"
  token-cap: "10800"
  tools: "bim_route_run bim_connect_runs bim_disconnect_run bim_route_flex bim_resize_run bim_slide_branch bim_set_terminal_airflow bim_move_equipment bim_resize_riser bim_list_fitting_types bim_swap_fitting bim_offset_run bim_change_elevation bim_split_run bim_resize_stretch bim_drag_run bim_set_system_design bim_set_duct_insulation bim_set_slope bim_place_pipe_accessory"
---

# MutinyBIM: duct and pipe

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the four starting reads and the rules for every change (preview, say the change, edit with `base_revision`, report the server's
answer). `bim_preview_route_edit`, which previews every edit here, is the
`model` family. Many runs at once (a branch to every diffuser, every fixture
to a drain) are one script with `routes.*`; the tools here are for one
change.

Sizes come from engineering: duct size advice (`bim_suggest_duct_size`), the
pressure and pipe reports and every calc with citations are `mutinybim-calcs`.

## Duct and pipe (each needs approval)

| Tool | Use it to |
| --- | --- |
| `bim_route_run` | Route duct or pipe through plan points at a height above the level, from / to a part connector, an open run end, or `branch_from` a trunk (tap / tee / wye by the system's rules). Leave `elevation_ft` out to take the height of what the route starts (else finishes) on: a `branch_from` tap lands on the trunk's centreline, a continued open end or side-facing connector carries on at its height. A typed `elevation_ft` that isn't the trunk's is refused with the trunk's height; don't guess one. Starting on a run continues its system (no `system_id` needed). Fittings are created with it, all or nothing. Duct legs run level at **any plan angle** (or vertical, or a 45° slope), and each elbow is made to its turn (30°, 22.5°, 60°… up to 135°) with the loss for that angle; a turn sharper than 135° is refused (make it two elbows). Elbow types made only for some turns (mitred with turning vanes: 45° / 90°) refuse other angles with the reason. Pipe legs stay E-W, N-S or 45° and turn 45° or 90°. The person's Route tool snaps duct to 15° and 22.5° steps from the working angle (Alt / Option, or Ribbon › Any angle, draws free); give the angle the person asked for. Rise or drop mid-run: `elevation_ft` on a point on a straight stretch (not at a turn; rectangular duct can't twist), made as `rise_style` says (`vertical` 90° elbows, or `45`). Duct: `elbow_family` / `takeoff_family` (from `bim_list_fitting_types`) pick this route's elbows and branch takeoff without changing the system's default. Duct: `insulation` (else the system's default) and `airflow_cfm` (with `duct_shape`, `height_in`) to size from airflow instead of giving a size; see Duct insulation and sizing. `use_my_defaults: true` fills whatever you leave out (size and shape, insulation, elbow and takeoff types, rise style) from the **person's own saved Route defaults** (Route panel › My defaults: this project's, else every project's); what you give always wins. Use it when the person says "route it the way I usually do" |
| `bim_connect_runs` | Connect existing runs, one edit, by `mode`: `face_to_face` (default with `b_end`) joins ends that already meet; `auto_route` joins two open ends that don't line up with a square route worked out between them (out of each end, square turns, one rise or drop) or refuses with the reason; `tap_into_side` (default without `b_end`) continues `a`'s open end straight into `b`'s side with a tap at `b`'s height (rises or drops on the way); `tee_at_elbow` turns a level or pitched elbow (`a_id`; a drain at up to 1/2" per ft counts) into a tee: the `a_end` leg runs on through the corner at its own fall and ends open there, then `bim_route_run` from that end routes the branch on. On a drain the other leg must drain into it, so pass the **downstream** leg as `a_end`; the branch fitting is the one the direction rules allow (a combination wye & 1/8 bend horizontal to horizontal), and the other way round is refused. Pressure pipe gets the system's tee. Sizes and systems must match |
| `bim_disconnect_run` | Cut one connection; both sides stay open, nothing is deleted |
| `bim_route_flex` | Flex from an open duct end (a tap's short branch) into an air device's neck (`to_connector` default `neck`): one round piece sized to the neck, curving from the end into it, linked both ends so airflow and pressure include it (rougher than sheet metal). The end must already be the neck's size (else route a transition first); the result warns past 6 ft, the usual limit; say it |
| `bim_resize_run` | Resize a **whole run** (rectangular, round, flat oval, or pipe size + material); every connected same-size piece follows. Fittings not made in the new shape take the system's choice for it (a smooth radius elbow becomes the round elbow on round duct) and the result says which; report it. To resize only some pieces, or part of one piece (for example one side of a split), use `bim_resize_stretch` |
| `bim_slide_branch` | Move a branch takeoff along its trunk |
| `bim_set_terminal_airflow` | Set a diffuser or grille's design CFM; system totals recompute |
| `bim_move_equipment` | Move a unit; connected ducts follow where they can |
| `bim_resize_riser` | Resize a riser through every level it crosses, as one change |

What `bim_route_run` does to rectangular and flat oval duct by itself:

- **Every turn must be one an elbow can make.** A route that would twist the
  duct (a riser turning the other way from the leg it meets, a rise from a leg
  running across it) is refused with the reason. Rise from a leg running the
  same way, or join with square or round duct; do not try random point orders.
- **A riser that turns flat lays the duct on its side**, so the route adds a
  short straight and a transition back to the size you asked for. If that leg
  is too short for the transition, it is refused: make the leg longer.
- **A branch wider than its trunk allows** is tapped at the widest size the
  trunk takes, with a transition up to the size drawn. Refused only when even
  the narrowed tap doesn't fit: make the branch smaller.

Report the added transitions when you describe the change.

## Fittings and pressure

| Tool | Use it to |
| --- | --- |
| `bim_list_fitting_types` | Read the fitting library (elbows, transitions, offsets, takeoffs, caps), what each fits, and its parameters. Use the id with the tools below |
| `bim_swap_fitting` (approval) | Change one fitting's type, e.g. mitred elbow to radius elbow; connections stay. Refused when the new fitting doesn't fit. On the **same** type, only the `params` you give change: an eccentric transition (`duct.transition.eccentric`) moves its flat side with `params: { flat: "top" \| "bottom" \| "left" \| "right" }` and keeps its wall angle. **Mirror** = the opposite side. Flat on top keeps the top of duct level under structure; left / right are as seen looking from the end that kept its size into the resized duct |
| `bim_offset_run` (approval) | Jog a run left, right, up or down at a point with 45°/90° elbows or an ogee |
| `bim_change_elevation` (approval) | Raise or drop a stretch of a run to a new height with 45° or 90° rises; what is connected follows |
| `bim_split_run` (approval) | Cut a routed duct or pipe segment in two at `at_ft` (feet from its start) with a plain joint. Both pieces keep size, system and connections; branches stay on the piece they sit on. Refused on a takeoff or when a piece would be too short for its fittings |
| `bim_resize_stretch` (approval) | Resize or reshape **only the segments you name** in one change (rectangular, round, flat oval, or pipe), or only `from_ft`–`to_ft` on one segment. Elbows between resized pieces follow; a `transition` (system default, concentric, eccentric flat top / bottom / left / right, rect-to-round) goes where a neighbour keeps its size, with the insulation of the duct it joins. Elbows, transitions and taps not made in the new shape take the system's choice for it (resizing a rectangular run with smooth radius elbows to round gives round elbows), and the result says which. Refused when the transition doesn't fit or a branch would be as wide as its trunk. This is what the MutinyBIM editor does when a person resizes a selected piece or a Tab-selected stretch; `bim_resize_run` is the whole run |
| `bim_drag_run` (approval) | Move one straight routed segment or in-line elbow / transition by `east_ft`, `north_ft`, `up_ft` (negative lowers), exactly as dragging it in the view does. What it meets follows: legs along the move stretch, legs square to it move with it, fixed parts refuse. A 45° or sloped piece slides so its neighbours only stretch. `end: "start" \| "end"` moves only that end (raise the top of a rise to make it taller). By default it behaves like the view's drag: a leg pulled back past its elbow turns the other way (its 90° elbows flip), and a move that can't go all the way (a leg shorter than its elbows need, an elbow that can't flip) stops at the limit; say how far it actually moved. `strict: true` never flips and stops at the elbow limit (the view's Alt drag). `reroute` is gone; `stop_at_limit` is still accepted and changes nothing. Refused only when it can't move that way at all. To move a whole run rigidly, use `bim_move_elements` on its pieces (the view's Tab, then drag). Not for takeoffs (`bim_slide_branch`) or whole units (`bim_move_equipment`) |
| `bim_set_system_design` (approval) | `name` renames a system (unique in the model, e.g. `DCW-1`; a new one is named by `bim_route_run` `system_name`). Choose the fittings routing places on a system (per slot) and its design altitude, air temperature and duct material; for duct also `default_insulation` (what new runs get) and `sizing` (friction rate, velocity limit, aspect ratio a size suggestion aims for; `null` = typical values). Pipe: `pipe_design` (below) |

Mounting planes (`bim_set_mounting_plane`) are in `mutinybim-parts`; an engineer's own loss coefficient on a fitting (`bim_set_fitting_coefficient_override`) is in `mutinybim-calcs`.

Routing refuses a leg too short for its fittings and says how much room they need: move the point or pick a shorter fitting with `bim_swap_fitting` / `bim_set_system_design`. Never present formula coefficients as final for permit work.

## Duct insulation and sizing from airflow

A run's size is always the **sheet-metal** size. Insulation goes on one side of it:
a **wrap** is outside (the outside size grows by the thickness on every side; that
is what has to clear structure and other trades), a **liner** is inside (the
airway shrinks by the thickness on every side, so velocity and friction rise;
the pressure report already uses the inside size). A liner's `surface` is
`faced` (the default: smooth facing, 1.5 mm roughness) or `spray_coated`
(4.5 mm, noticeably more friction); the air sees the liner, not the duct
material. A system's default insulation carries its liner surface too. Fittings carry
the insulation of the duct they join. Plans draw it as thin dashed lines beside
(wrap) or inside (liner) the duct, sections as a thin dashed outline at the cut,
the 3D view as a see-through skin over wrapped duct. A schedule of category
`duct` has `insulation`, `liner_surface`, `inside_size`, `outside_size`, `cfm`,
`velocity_fpm` and `friction_in_per_100ft`; tag template `duct_size_insulation` reads `24"x12" (1" liner)`.
Pipe insulation is a wrap outside the pipe: drawn the same way, a `pipe` schedule
category has `system`, `size`, `material`, `insulation`, `insulation_thickness`,
`outside_size`, `length`, and tag template `pipe_size_insulation` reads `2" (1" ins.)`.

| Tool | Use it to |
| --- | --- |
| `bim_set_duct_insulation` (approval) | Put a wrap or liner on routed duct, or a wrap on pipe, or take it off (`insulation: { kind: "none" \| "wrap" \| "liner", thickness_in, surface?: "faced" \| "spray_coated" (liner only, default faced), material?, r_value? }`), for `scope` `piece` (the segment and its end fittings), `run` (default: same-size pieces through elbows, stopping at transitions, branches and parts) or `system`. A liner leaving less than 2" clear inside, or any liner on pipe, is refused with the reason. Pipe: `from_schedule: true` (no `insulation`) gives every pipe of the element's system the project's pipe insulation schedule thickness for its size, one edit |

- **Defaults.** Each duct system has a default insulation (`bim_set_system_design`
  `default_insulation`). `bim_route_run` without `insulation` uses it; with
  `insulation` it uses that (`kind: "none"` for bare duct). A **new** system takes
  its first route's choice as its default, or else starts like an existing system
  of the same kind. When the person says "draw supply with 1" liner by default",
  set the system default; don't add `insulation` to every route.
- **Sizing.** Ask `bim_suggest_duct_size` and show the person the size, velocity
  and friction before resizing. Typical criteria (0.08" per 100 ft; 2,000 fpm
  supply, 1,500 fpm return / exhaust / outside air; 4:1) are general values: say
  "typical, verify for the project" unless the system has its own. Apply with
  `bim_resize_run` / `bim_resize_stretch`, or route with `airflow_cfm` (and
  `height_in` for the depth) instead of a size. Never resize without the
  person's approval of the size. A liner eats depth: 1,200 CFM with a 1" faced
  liner is 19" round or 22x14, but 36x10 when held to 10" deep (8" inside);
  say so when the person's depth forces a very wide duct.

## Pipe: fittings, slope and hydraulics

Loads on open pipe ends without fixtures (load points, connection types,
fixture units) are in `mutinybim-plumbing`; `bim_pipe_report` reads them.

Pipe sizes take `nominal_in`, `material` and optionally `spec` (`type_k` /
`type_l` / `type_m` copper, `sch40`, `no_hub` or `service_weight` cast iron…).
Fittings come from the library by service (domestic water, drainage and vent,
fuel gas) with the pipe's usual joint (sweat, press, threaded, no-hub, solvent
weld, PEX crimp / expansion, fusion, CSST).

| Tool | Use it to |
| --- | --- |
| `bim_set_slope` (approval) | Pitch one drain segment to inches per foot (default: the system's minimum, 1/4" per ft up to 3", 1/8" larger); what is connected follows |
| `bim_place_pipe_accessory` (approval) | Put a valve, union, cleanout, test tee, P-trap, gas cock or drip leg inline on a pipe |

`bim_list_fitting_types` with `domain: "pipe"` and `service` (`water`,
`drainage`, `vent`, `gas`) lists families, joints, materials, take-out, and for
drainage the direction changes each may make. `bim_set_system_design`
`pipe_design` sets water supply pressure, friction method, demand table,
velocity limit; drain slopes, capacity table, direction-rule overrides; gas
equation, specific gravity, allowable drop.

Drainage rules the model server enforces (from general practice; the project
can override any of them in `pipe_design.directionRules`):

- `bim_route_run` slopes level drain legs by itself (`slope_in_per_ft` to
  choose steeper) and picks the fitting for each change of direction:
  a sanitary tee only where a horizontal branch enters a stack; a combination
  wye & 1/8 bend where a branch joins a horizontal drain; a long sweep where a
  stack turns horizontal. A branch into a stack finds its own height from the slope.
- A disallowed fitting, a drain flatter than the minimum, a branch sloped away
  from the run it joins, or a drain that gets smaller downstream is **refused
  with the reason and the fitting to use**. Explain it; do not try random types.
- No plumbing or gas code sizing table is bundled. If the user wants a code
  check, ask for the firm's values and enter them as `capacityTable`,
  `demandTable` or `fixtureTable`; never type in values from a code book.

## Workflows

**Route a branch duct to a diffuser:** `bim_query_elements` on the level (the
trunk run id, the diffuser's connector id) → `bim_preview_route_edit` with
`tool: "bim_route_run"`, `branch_from` the trunk, `to` the diffuser connector,
no `elevation_ft` (the tap takes the trunk's height and system) → fix any
`would_refuse` → describe → `bim_route_run`.

**Rooftop unit to ceiling diffusers on the floor below** (a downflow RTU):
1. `bim_list_levels` (the roof and the floor below; their elevations) and
   `bim_list_part_types` `search: "rooftop"`: place the current RTU
   (`builtin:rtu-5-ton@2`, with its outdoor-air hood) on the **roof** level at
   its curb height.
2. Diffusers on the floor below: on the ceiling (`height_above_level_ft`),
   or where there is no ceiling, `bim_set_mounting_plane` (`mutinybim-parts`) and
   `bim_place_part` with `on_plane_id`. A ceiling diffuser is drawn face down,
   neck up: leave `mount` out. A floor register is `mount: "turned_over"`, a
   sidewall register `mount: "on_side"` with `rotation_deg` facing the room.
3. The trunk: `bim_route_run` with `level_id` = **the roof**, `from` the
   RTU's down-facing supply, and `elevation_ft` **from the roof's floor**, so
   a plenum 2.5 ft below the roof deck is `-2.5`. The run drops through the
   roof; the piece above the roof is drawn on the roof plan and the rest on
   the floor below. `to` may also be a connector on the floor below directly.
4. Branches off that trunk: `bim_route_run` with the **trunk's level** (the
   roof) and `branch_from`; heights are still from the roof's floor. Stop the
   branch a few feet short of the diffuser and `bim_route_flex` into its neck.
5. `bim_pressure_report` and `bim_query_elements` (terminals): report CFM per
   diffuser and the static the RTU needs.

**Hood, louver or screen on an outdoor-air or exhaust opening:**
`bim_set_parameters` `scope: "instance"`, `intakes: { outdoor_air: "louver" }`
(`hood`, `louver`, `screen`; `none` takes the type's off, `null` puts it back).
It is drawn in 3D, on prints and in plan. The built-in RTU and makeup air unit
ship with a weather hood.

**Move or raise a piece of duct:** `bim_inspect_network` on the piece (its id
and neighbours) → `bim_preview_route_edit` with `tool: "bim_drag_run"` and the
move (`east_ft`, `north_ft` or `up_ft` alone, or `up_ft` with one of the others,
one step; east and north together on a level piece is at an angle and refused,
so move one way at a time; `up_ft` alone just raises or lowers it) → read where the preview leaves it (flipped elbows, or stopped at the
limit) and say that, or pass `strict: true` if the elbows must keep their
direction → `bim_drag_run`. Whole unit: `bim_move_equipment`; a takeoff: `bim_slide_branch`.

**Connect to existing duct:** a branch off a trunk is `bim_route_run` with
`branch_from` (no `elevation_ft`); an open end that should run into a trunk's
side is `bim_connect_runs` `tap_into_side`; two open ends that don't line up
are `bim_connect_runs` `auto_route`; a branch from an elbow's corner is
`bim_connect_runs` `tee_at_elbow`, then `bim_route_run` from the open end it
leaves. Preview each with `bim_preview_route_edit` first.

**Resize part of a run:** `bim_split_run` where the size changes (if it changes
mid-segment) → `bim_resize_stretch` on the pieces that change. Use
`bim_resize_run` only when the person means the whole run.

**Make a reducer flat on one side, or mirror it:** `bim_inspect_network` on the run (the transition's id) → `bim_preview_route_edit` with `tool: "bim_swap_fitting"`, `family: "duct.transition.eccentric"`, `params: { flat: "top" }` (Mirror: the opposite side) → `bim_swap_fitting`. Or choose it while resizing: `bim_resize_stretch` `transition: "eccentric_flat_top"`.

**Rebalance airflow:** `bim_query_elements` (terminals, CFM) → one
`bim_set_terminal_airflow` per terminal, each on the latest saved revision →
read them again and report the new totals.

**Add a wye at a drain bend (the person's "+"):** `bim_inspect_network` on the
bend (its id, which port links which leg, which leg falls away from it) →
`bim_preview_route_edit` with `tool: "bim_connect_runs"`, `mode: "tee_at_elbow"`,
`a_id` the bend, `a_end` the port of the leg that drains **away** → describe
(the trunk runs on upstream at the same fall; the other leg joins through a
combination wye & 1/8 bend) → `bim_connect_runs` → `bim_validation_issues`.

**Create similar (the person's C S):** read the selected element
(`bim_inspect_network` for a run, `bim_query_elements` for a part), then make
another with the same values; nothing is guessed. A pipe or duct:
`bim_route_run` with its `kind`, size (`nominal_in` + `material` + `spec`, or
the duct size), `system_id`, and `elevation_ft` (its height), from where the
person says, or `from` / `to` its open end (`run_id` + `end`) to continue it.
A part: `bim_place_part` with its `type_id`, `level_id` and
`height_above_level_ft`, at the new point. Say what was copied.

**Lay out a drain and check it:** `bim_query_elements` (the stack or main id,
fixture connector ids) → `bim_preview_route_edit` with `tool: "bim_route_run"`,
`kind: "pipe"`, the fixture `from` and `branch_from` the stack or main → fix any
`would_refuse` → `bim_route_run` → `bim_pipe_report` and report fixture units,
capacity and anything flagged.

If a tool here is missing after turning this family on, say exactly which
tool is missing; don't substitute another.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_route_run` |
| `bim_connect_runs` |
| `bim_disconnect_run` |
| `bim_route_flex` |
| `bim_resize_run` |
| `bim_slide_branch` |
| `bim_set_terminal_airflow` |
| `bim_move_equipment` |
| `bim_resize_riser` |
| `bim_list_fitting_types` |
| `bim_swap_fitting` |
| `bim_offset_run` |
| `bim_change_elevation` |
| `bim_split_run` |
| `bim_resize_stretch` |
| `bim_drag_run` |
| `bim_set_system_design` |
| `bim_set_duct_insulation` |
| `bim_set_slope` |
| `bim_place_pipe_accessory` |

<!-- end tools -->
