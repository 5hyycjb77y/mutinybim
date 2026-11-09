---
name: mutinybim-electrical
description: "MutinyBIM pack for electrical design: panels and their schedules, circuits and feeders, rebalancing, connection and feeder types, room circuit templates, receptacle proposals by code spacing, service layout, and live one-line, electrical riser and plumbing riser diagrams. Use with the mutinybim core. Trigger on: panel, circuit, feeder, breaker, load, receptacle, service size, one-line diagram, riser diagram, plumbing riser."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the electrical family turned on (bim_enable_pack, --packs electrical, or /packs/electrical/mcp under the MutinyBIM base)."
metadata:
  pack: "electrical"
  mcp-server: "mutinybim"
  family: "electrical"
  token-cap: "9300"
  tools: "bim_electrical_report bim_read_panel bim_electrical_catalog bim_propose_links_from_text bim_preview_circuit_edit bim_create_circuit bim_edit_circuit bim_add_to_circuit bim_remove_from_circuit bim_feed_panel bim_rebalance_panel bim_save_electrical_type bim_apply_circuit_template bim_preview_one_line bim_layout_one_line bim_propose_receptacles bim_accept_receptacles bim_place_service_layout"
---

# MutinyBIM: electrical distribution and one-line diagrams

A family of the `mutinybim` core. Activate `mutinybim` first: it has the
script tools, the reads and the rules for every change: preview, say the
change, edit with `base_revision`, report the server's answer, look at what
you drew. The pictures you check a diagram with (`bim_render_view_image`,
`bim_render_sheet_image`), the PDFs and part placement are the `model`
family. Many circuits at once (a whole floor's receptacles on named circuits)
are one script; the tools here are for one change or a proposal to review.

Size what the diagram shows with `mutinybim-calcs` (`bim_run_calc`). Fixing a
crowded diagram by hand uses `mutinybim-drafting` (`bim_modify_detail`) and
`mutinybim-views-sheets` (`bim_edit_text_note`, `bim_create_sheet`).

## Circuits, feeders and panel totals

A circuit is not text. "R-1 is on L1-3" is a link in the model from circuit 3
of panel L1 to R-1's power connector, and panel L1 is fed by a link from a
breaker in transformer T1 (or straight from a board's breaker). Loads are read
off the devices, so every panel's totals, its "Supply from" and its capacity
are live. Nothing has to be drawn for a circuit to exist.

| Tool | Use it to |
| --- | --- |
| `bim_electrical_report` (read) | Every panel, switchboard and transformer (or one: `panel` by id or name) with `supply_from`, `connected_va`, `demand_va` (NEC Article 220 calculated load, largest motor +25% included), `sizing_va` / `sizing_a` (continuous loads at 125%: what conductors and the breaker are sized for), `per_phase` VA and amps, `demand_by_class` with the clause for each line, `capacity` (`limit_a`, `limited_by`, `headroom_a`, `reason`), and `findings`. One panel also lists its `circuits` with members. The code edition is `nec_edition`, else the project's Code Study, else `state`; with none, `rules_placeholder: true` and the totals are connected loads only |
| `bim_read_panel` (read) | One panel as the MutinyBIM editor's panel view draws it: each used slot's circuit (`circuit_id`, name, breaker, poles, members; `existing` on a renovation's existing circuits, which keep their panel and slots), the free slots, what feeds it, and `fault_current` (available vs the panel's rating, NEC 110.9, with the point-to-point `trail`). No `panel`: the devices on no circuit yet. Totals are in `bim_electrical_report` (which also gives `fault_current` per panel) |
| `bim_electrical_catalog` (read) | The project's connection types, feeder types (with their schedule line) and room templates. `size_feeder_for: "H1"` (+ `length_ft`, `material`, `conduit`) proposes a feeder type from that panel's NEC load (breaker, conductors with voltage drop, parallel sets, EGC, conduit, the steps) with the exact `bim_save_electrical_type` call. `check: true` adds the Electrical tab's check list (each item with the ids to select) |
| `bim_preview_circuit_edit` (read) | Dry run of any edit below with its arguments: what it changes (a rebalance's moves and phases before and after; a template's circuits per unit), or the plain reason it would be refused. Free |
| `bim_propose_links_from_text` (read) | Turn circuit numbers people typed on devices ("L1-3", "HP1-43,45") and "Fed from" typed on panels into proposals: what would be made, `ready` or `refused` (with the reason), `unmatched`, `ambiguous`, and `to_make_it` (the exact `bim_create_circuit` / `bim_add_to_circuit` call). Changes nothing |
| `bim_create_circuit` (approval) | Serve the listed `members` from `source_id`: devices on a panel's circuit, or a panel / transformer from a breaker (a feeder). `positions` are circuit numbers, one per pole (1,3,5 for three poles); leave them out for the free ones that best balance the panel's phases. Optional `breaker_a` (default: one unit's MOCP, else 20 A; a feeder: the fed panel's main, else its bus), `description`, `load_class`, `conductors` (a voltage-drop upsize is a real value here, never "SEE SLD"), `length_ft`, `feeder_type`, `circuit_id` (from a proposal). **`one_circuit_each: true`**: each member on a circuit of its own in the slots that best balance the phases, breaker the next standard size for its load (the project's NEC edition; none: the panel default, and it says so), planned items included; `members: []` = every Not placed yet item waiting for a circuit (the MutinyBIM editor's Circuit all). Returns `circuits` (item, circuit, poles, VA, breaker) and `not_circuited` (item and reason, e.g. wrong voltage for this panel); one approval, one undo step. With no panel yet it says to plan the MDP first (`bim_place_service_layout` `plan_only: true`) |
| `bim_edit_circuit` (approval) | Move a circuit or feeder to other positions or another panel, or change its breaker, conductors, load class, length, feeder type or description (`null` clears) |
| `bim_add_to_circuit` (approval) | Put more devices on an existing circuit |
| `bim_remove_from_circuit` (approval) | Take devices off a circuit; it stays as a spare (delete it with `bim_delete_elements`) |
| `bim_feed_panel` (approval) | Feed `panel_id` (a panel or transformer) from `source_id`: a board or panel's breaker (`positions`, `breaker_a`, `feeder_type`) or a transformer's secondary. A feeder it already has moves instead of a second one. A transformer has no main to default its breaker from: ask for it. A generator feeds a transfer switch's emergency side: `bim_create_circuit` with `members: [{ element_id: ATS, connector: "emergency" }]` |
| `bim_rebalance_panel` (approval) | Move or swap circuits on one `panel` so A, B, C carry more even load. Same model, same moves; three-pole breakers and `keep_circuits` stay; what is on a circuit never changes |
| `bim_save_electrical_type` (approval) | Save one `entry` (`connection_type`, `feeder_type` or `circuit_template`); `replaces` renames it and what names it follows; `delete: { type, name }` removes one nothing uses. Devices take a connection type by `bim_set_parameters` `values.connection_type` (their load, voltage, poles and class then come from it). Plumbing, gas and air connection types (and one record with both, a dishwasher's hot water and 120 V) are `bim_save_connection_type` in `mutinybim-plumbing` |
| `bim_apply_circuit_template` (approval) | Circuit the devices in each unit's rooms by a room template: `units: [{ panel, rooms }]`, both as the person names them. Devices already on a circuit are left alone; refused circuits are reported, the rest made |
| `bim_place_service_layout` (approval) | Start the one-line from a service size: meter, optional fused main disconnect, main distribution and the panels and transformers the person lists, each `fed_from` another, as one edit. `plan_only: true` draws nothing: every piece is planned and waits in Not placed yet (workflow: starter service layout) |

These are the same edits as the MutinyBIM editor's **Electrical** tab and the
**Circuit** tab (Add to circuit, Edit circuit, Feed panel, Drag to panel,
Panel view, Check, Balance phases, Electrical types, Room templates), so a
person sees the agent's circuits in the panel view at once. Place parts with
`bim_place_part` (model family). `bim_list_part_types` with an electrical
`category` or `search` lists the starter types (panelboards with and without
a main, switchboards and switchboard sections, transformers, generators,
transfer switches, meters, CT cabinets, tap boxes, fused and non-fused
disconnects, receptacles, lights, switches, junction boxes and hardwired
equipment connections) with their voltages. Disconnects, transfer switches,
meters, CT cabinets, tap boxes and generators take no slots: what they feed
has no `positions`.
Mechanical equipment with a nameplate voltage and MCA / MOCP (built-in, cut
sheet or drafted) is circuited directly: 3 poles for three-phase, breaker from
MOCP, load from MCA.
Name panels with `values: { panel_name: "L1" }` so circuits read `L1-3`; give
devices a `mark`.

Rules (these are firm):

- **Members are exactly what the person named**, or what they confirmed from a
  proposal. Never choose which devices go on a circuit by where they are, never
  split or regroup devices into circuits yourself, and never pick a panel for
  them by distance. Ask "which panel, and which devices?" when it isn't said.
  This is a fixed product rule, not a default.
- A refusal is the answer: "MUA-1 needs 480 V 3-phase; L1 is 120/208 V 3-phase
  4-wire, so it can't serve it." Repeat it, and suggest the right kind of
  panel; don't retry with other positions to get around it.
- A device already on a circuit is refused by `bim_create_circuit`: take it
  off with `bim_remove_from_circuit` first, and say that you moved it.
- A 120/208 V panel can't come straight off a 480 V board: a transformer goes
  between. Never place or feed one on your own; ask.
- Findings never block edits. After a change, read the panel again and say
  what the findings say (overloaded, unbalanced phases, a member whose voltage
  no longer matches). Fix only what the person agrees to.
- Demand is computed at each panel from every load below it, so 220.56
  kitchen equipment counted at the MDP differs from the panel that serves it.
  Never add up panels' demands to get the MDP's; read the MDP.
- Quote numbers with their basis: "L1 can carry 208 A, limited by what is left
  in T1", "kitchen 4 units at 80% (NEC 2023 Table 220.56)". If
  `rules_placeholder` is true, say the totals are connected loads, not a code
  calculation, and ask for the NEC edition (or to record it in the Code Study).

### Workflow: circuit a floor

(e.g. "circuit the office receptacles on level 2 to L1, and feed L1 off the
MDP through T1"; one circuit is the same steps with one group)

1. `bim_electrical_report` for the panels, what feeds each and their free
   capacity; `bim_read_panel` with no panel for the devices on no circuit;
   `bim_query_elements` (core, kinds `part`, the level) for ids and marks. Ask
   for what the person didn't say: which panel, which devices go together,
   breaker size if not the default.
2. Distribution first, top down: `bim_feed_panel` each transformer from its
   board's breaker, then each panel from its transformer or board. Say the
   change first ("feed T1 from MDP, 3-pole 125 A breaker on the lowest free
   circuits"); preview with `bim_preview_circuit_edit` when unsure.
3. Each circuit: `bim_create_circuit` with `source_id`, exactly the `members`
   the person grouped (or their room convention named), and a `description`
   ("Office 106 receptacles"). Report the name the server gives back
   ("L1-3") and its phase.
4. Refused? Say the reason as written and stop for that circuit; carry on
   with the others only if the person agrees.
5. `bim_electrical_report` with `panel` for each panel you touched: say the
   connected and NEC demand loads, the phases, `capacity.reason` and any
   finding. An unbalanced phase: preview `bim_rebalance_panel` and offer the
   moves; make them only if the person agrees.

### Workflow: rebalance a panel

`bim_preview_circuit_edit` with `tool: "bim_rebalance_panel"`, `args: { panel }`
→ say the moves ("L1-7 Office receptacles to L1-5, A → C; phases 720 / 180 /
0 VA become 540 / 180 / 180") → `bim_rebalance_panel` → read the panel again.
If the person wants a circuit left alone, pass it in `keep_circuits`.

### Workflow: circuit dwelling units by a room template

(e.g. "circuit units 101–124 like our two-bedroom convention")

1. `bim_electrical_catalog` `kind: "templates"`. No template? Ask for the
   convention ("bedroom → 1, living → 3, kitchen counters → 5 and 7…") and save
   it with `bim_save_electrical_type` (`circuit_template`, rules top to bottom;
   the first that matches a room's name wins).
2. Get each unit's rooms (`bim_query_elements` kind `room`, by number) and ask
   which panel serves each unit. Never pick a panel or rooms yourself, and
   never group devices by distance.
3. Preview `bim_apply_circuit_template` with `bim_preview_circuit_edit`; show
   the circuits per unit, rooms no rule matched, devices left alone and any
   refusal → `bim_apply_circuit_template`.

### Workflow: connection types and feeder types

- A designator (E.05, K-10) with its load, voltage, poles and class:
  `bim_save_electrical_type` `connection_type`, then `bim_set_parameters`
  `values.connection_type: "E.05"` on each device the person names.
- A feeder type for H1: `bim_electrical_catalog` `size_feeder_for: "H1"` (with
  the length) → show the proposal and its steps → `bim_save_electrical_type`
  with it → `bim_edit_circuit` on H1's feeder (`supply_from.feeder_id` in
  `bim_read_panel`) with `feeder_type` and the same `breaker_a`. Never invent
  sizes; a feeder naming a missing mark is a finding.

### Workflow: what needs attention?

`bim_electrical_catalog` with `check: true`: errors first (an overload, a
breaker above a unit's MOCP), then loads on no circuit, unbalance, missing
types. Offer the fix for each; make none unasked.

### Workflow: what's the true capacity of H1?

`bim_electrical_report` with `panel: "H1"`. Answer with `capacity.reason`
(the lowest of its bus, its main, the breaker and conductors feeding it, and
what is left upstream), `headroom_a`, and the sizing load it's compared with.

### Workflow: wire up a model whose circuits are only typed text

1. `bim_propose_links_from_text`. Show the person the `ready` proposals as a
   short list ("L1-3: R-1, R-2 (typed L1-3)"), and the `refused`,
   `unmatched` and `ambiguous` ones with their reasons.
2. Make only the ones they confirm, feeders first, one `to_make_it` call each
   (each pauses for approval). Never run them all because they are ready.
3. `bim_electrical_report` to show the totals now that the panels are fed.

Lint `fed-from-text-mismatch` also fires when a panel's typed Fed from names a
source but nothing feeds it ("says MDP but nothing feeds it"): feed it with
`bim_feed_panel` once the person confirms the source, or clear the text.

## Schedules and live tags

Electrical schedules are schedule views whose every value is read from the
model when the sheet is drawn: circuits, breakers, loads, per-phase kVA,
demand, "Supply from". **Never type a load or a circuit into a schedule or a
note**; change the model (circuits above, `bim_set_parameters` for a load) and
every schedule and tag follows in the same revision.

Making, changing and reading them is the `mutinybim-schedules` pack
(activate it): `bim_schedule_define` with `form: { kind, panel, template_name,
nec_edition }` (kinds `panel`, `switchboard`, `feeder`, `connection_types`,
`equipment_connections`, `gas_equipment`), `bim_library` for the built-in and
firm templates (`read` id `form:panel`: the template, every field path and the
template language), and `bim_schedule_read` (model family) to read one in full.

A new schedule starts from `template_name`, else the firm default for its
kind, else the built-in one. The NEC edition is `nec_edition`, else the
project's Code Study; with neither the schedule prints connected loads only
and says so on the sheet: tell the person and ask for the edition. A schedule
keeps its own copy of its template, so a new firm default never changes
schedules already drawn.

Field paths (`{path}` in a template): on a device `circuit` (`HP1-43,45`),
`circuit.number` (`43,45`), `circuit.breaker`, `circuit.conductors`, `panel`,
`load`, `load_class`, `voltage_phase`; on a panel `supply_from`
(`MDP via 225A/3P via F225`), `feeder.source.name`, `feeder.breaker`,
`feeder.type`, `feeder.type.conductors`, `bus`, `mains_text`, `volts`,
`voltage_system`, `phases_wires`, `kaic`, `connected_kva`, `demand_kva`,
`capacity_a`. The live one-line reads the same paths (`bus_rating`,
`supply.text`), so a schedule, a tag and the diagram never disagree. The full
list is in `bim_library` (`read` id `form:<kind>`). `[ ... ]` prints only when every
field inside has a value: `{feeder.source.name}[ via {feeder.breaker}][ via {feeder.type}]`
never ends in "via" before a feeder type is chosen. `\{` prints a brace.

Tags use the same paths: a tag style made with `bim_save_tag_style`
(`mutinybim-drafting`) with the line `{circuit}` prints `HP1-43,45` on a
device, `{circuit.number}` the number beside it, and `[FED FROM {supply_from}]`
on a panel. They update when the circuit moves.

### Workflow: put L1's panel schedule on E-601

1. Activate `mutinybim-schedules`. `bim_library` `list` (type
   `schedule_template`): say which panel template it will use.
2. `bim_schedule_define` with `form: { kind: "panel", panel: "L1" }`,
   `place_on: { sheet: "E-601" }` (create the sheet first with
   `bim_create_sheet` in `mutinybim-views-sheets`). Report the code and the
   totals from the preview's `prints`, then commit it (approval).
3. **Look:** `bim_render_sheet_image` on E-601 (zoom with `region_in`).
4. Wording or columns the firm wants differently: `bim_schedule_define` with
   `schedule` and `form.template` (a whole template from `bim_library`).

## One-line and riser diagrams: live, from the model

When the model has the distribution (panels, switchboards, transformers fed
by `bim_feed_panel` / `bim_create_circuit`), a one-line is a **live diagram**:
a drafting view that stores only which diagram it is and the person's layout
hints, and is drawn from the model's feeders every time anyone looks at it or
prints it. Change H1's bus from 225 to 400 A and the one-line says 400A BUS
and warns "400A BUS FED BY 225A BREAKER" in the same save, with no edit to the
diagram. Text blocks read live fields (bus, MLO/MCB, voltage system, phases and
wires, NEMA enclosure, kAIC); feeder breakers and feeder type ovals (F225) come
from the feeders. Nothing on it is dummy text, and nothing is stored as line
work, so never edit one with `bim_draw_detail` or `bim_modify_detail`.

| Tool | Use it to |
| --- | --- |
| `bim_preview_one_line` (read) | `from_model: true` (+ `kind`: `one_line` default, `electrical_riser`, `plumbing_riser`) with `new_view_name`, or `view` for an existing drafting view: what it draws (`equipment`), `warnings` (bus vs feeding breaker, unfed panels, feeder loops), size, `would_save` + `preview_token` |
| `bim_layout_one_line` (approval) | Save what was previewed: the live view (or its new hints), and `place_on: { sheet, center_in }`. Same arguments plus `base_revision` and `preview_token` |

`bim_list_views_and_sheets` (model family) reports each live diagram's
`live_diagram`: kind, hints, equipment drawn now, warnings.

Layout is **hints**, merged over the view's own: `orientation` (`vertical`,
`horizontal`), `style` (`box3d` for the 3D-box look), `detail` (`schematic`:
names, buses and systems only, for early design before schedules exist),
`order` (`{ "<source id>": ["<child id>", …] }`, `$roots` for the services),
`pins` (`{ "<id>": { dx, dy } }` mm: move a piece and what it feeds),
`textOffsets` (`{ "<key>": { dx, dy } }` mm: move one block of text only; keys
from the preview's `texts`, e.g. `h1#equipment#0` for H1's name block; it keeps
reading the model, with a leader home when moved well away),
`sections` (`[{ id, label, elementIds }]` dashed boxes), `futureSpaces`
(`{ "<bus id>": n }` dashed SPACE FOR FUTURE), `hidden`, `roots`, `utility`
(utility source above each service, default on), `showWarnings` (default on),
`showLoads` (motors and units on branch circuits), `labels` (text lines per
`bus` / `transformer` / `equipment` as field templates, e.g.
`"{supply.source.name} VIA {supply.breaker}"`), `title`, `notes`,
`systemKinds` (plumbing riser). A separately metered service (fire pump,
house) is drawn in its own dashed box when its equipment's `service` value
says so. To change the layout, call the same tools with `view` and only the
hints that change.

A `bus_above_feeding_breaker` or `breaker_above_bus` warning is also a finding
in `bim_electrical_report`. Say it to the person; never "fix" it by changing a
breaker or bus they didn't ask you to change.

### Static diagrams: only when there is no model

`diagram` (instead of `from_model`) draws a distribution described by hand
into a drafting view as symbols, conductors and notes. Use it only when the
person describes a service that is not in the model (a quick sketch, an
existing building nobody has modeled). Never use it for equipment that is in
the model: that is a live diagram. To turn an old static one-line into a live
one, give its `view` with `from_model: true` and `replace_existing: true`.

The static `diagram`: `title`, `notes` (numbered under it), and `roots` (sources:
`utility` or `generator`). Each node: `id` (letters, digits, `_ . -`), `kind`,
`name`, `ratings` (up to 6 lines, as they print), `children`, `placeholder`
(a dashed future space), and `feeder` — how its parent feeds it: `device`
(`breaker` default from a bus, `drawout_breaker`, `fuse`, `fused_switch`,
`switch`, `none`), `device_label` (e.g. `400AF/400AT 3P`), `sets`,
`conductors`, `conduit`, `length_ft`, `type_mark` (F225 oval). Kinds: `utility`, `meter`,
`ct_cabinet`, `switchboard` / `panelboard` / `mcc` (bus equipment; `main: { device, label }`
for a main, leave it out for MLO and say MLO in the ratings), `transformer`,
`generator`, `ats` (`emergency`: its generator node, drawn beside it),
`disconnect`, `fused_disconnect`, `vfd`, `ups`, `motor`, `equipment` (a load box).
`spd: true` hangs a surge protective device and `ground: true` a ground on bus
equipment, a transformer or a source.

A **meter center** (several tenants, units or lots on one service) is a
`switchboard` node for the meter bus (its main as `main`, `ground: true`) whose
children are `meter` nodes with `feeder: { device: "none" }`, each with one
child: the unit's `panelboard`, fed through its own `feeder` (`device: "breaker"`,
`device_label: "200A 2P"`, conductors, conduit), `ground: true` where each
service has its own electrode. Eight lots draw about 26 in wide.

For a static diagram the preview tells you when the view already has drawn
items (`drawn_over_existing_items`); redraw it with `view` and
`replace_existing: true` instead of deleting items one by one.

Never build a one-line by hand from `bim_draw_detail` circles, rectangles and
sheet notes, and never hand the person an HTML or SVG file when they asked for
the drawing in the model. If `bim_preview_one_line` or `bim_layout_one_line` is
not in your tool list, turn this family on; if they are still missing, tell
the person exactly which tools are missing. Don't substitute.

Conventions (general practice; the firm's standards win when given):

- Ratings on every piece: amps, voltage, phase and wires (`1600A, 480Y/277V, 3Ø, 4W`),
  short-circuit rating (`65 kAIC`), MLO or main size. Transformers: kVA and
  both voltages (`75 kVA`, `480Δ - 208Y/120V`). Generators: kW and voltage.
- Feeder tags: parallel sets, conductors with ground (`4#500 KCMIL CU, 1#3 G`),
  conduit, length. Breaker labels as frame / trip / poles (`400AF/400AT 3P`).
- Ask for the service size, voltage, available fault current and anything you
  would otherwise invent. Never make up ratings or conductor sizes: size them
  with `bim_run_calc` (`mutinybim-calcs`), leave a rating out and tell the
  person, or ask.
- Don't paste code tables into notes.

## Workflow: the one-line on E-601

(e.g. "put the one-line on E-601", "show the fire pump service", "a riser for
the building")

1. `bim_electrical_report`: is the distribution in the model and fed? If
   panels are unfed or missing, say so and circuit them first
   (`bim_feed_panel`, after the person confirms); a live diagram can only show
   what the model says.
2. `bim_list_views_and_sheets`: reuse an existing live one-line
   (`live_diagram.kind`) instead of making a second; `bim_create_sheet`
   (`mutinybim-views-sheets`) for `E-601` if it isn't there.
3. `bim_preview_one_line` with `from_model: true`, `new_view_name` (e.g.
   "E-601 One-line diagram") and `place_on` → say "a live one-line of N pieces
   of equipment on E-601, kept up to date as the model changes" and read out
   its `warnings` → `bim_layout_one_line` with `base_revision` and
   `preview_token`.
4. **Look:** `bim_render_view_image`, then `bim_render_sheet_image`. If it is
   crowded, change hints (`orientation`, `order`, `pins`, `detail`), never the
   drawing; text that runs into other text is listed in the preview's
   `text_overlaps`: move one of the two with `textOffsets`. Look again. If no picture comes back that you can see, say you
   checked by `bim_list_views_and_sheets` only.
5. `bim_print_sheet_pdf` and give the link.

A riser is the same with `kind: "electrical_riser"` (equipment by level).
Plumbing risers and isometrics: `mutinybim-plumbing`.

## Workflow: a static single-line diagram (no model)

1. Gather: service voltage and size, available fault current, each piece of
   equipment with its ratings, what feeds what, feeder sizes and lengths.
   Ask for what's missing; never invent it.
2. Write the `diagram` top down (utility → CT cabinet or meter → switchboard
   with its main → each feeder's breaker, conductors and equipment → panels,
   transformers, the ATS with its `emergency` generator, loads).
3. `bim_preview_one_line` with `new_view_name` and `place_on` → say "draws N
   pieces of equipment, about W x H in, on E-601" → `bim_layout_one_line`.
4. **Look** as above; fix by moving a piece's detail group
   (`bim_modify_detail`) or editing a label (`bim_edit_text_note`). Never tell
   the person it looks right without a picture or a measurement.
5. `bim_print_view_pdf` or `bim_print_sheet_pdf`, and give the link.

## Circuiting on plans, callouts and typicals

Plans draw each circuit from the model every time they print: never draw
circuit lines, home-run arrows or circuit numbers with detail lines or notes.
Moving a device moves its line and home run. Electrical plans (discipline
electrical) draw arcs unless the view says otherwise.

| What | How (all through `bim_preview_views_sheets_edit` → `bim_apply_views_sheets_edit`) |
| --- | --- |
| Line style | `set_view_properties` `props.circuitGraphics.style`: `arcs`, `orthogonal` (square corners), `numbers` (the circuit number beside each device, multifamily), `off` |
| Home runs, switch legs | `circuitGraphics.homeRuns` / `switchLegs` (default on). The home run is on the member nearest the panel, tagged `<panel>-<circuit>` ("L1-1,3"). Switch legs are dashed, switch to the fixtures with its switch letter |
| Typical units | `circuitGraphics.allCopies: true` draws each copy's circuiting; off, the original's home runs read "TYP." |
| A line's bend | `circuitGraphics.hints[<circuit id>].bends["<idA>\|<idB>"] = {x, y}` (mm, ids sorted); `hints[id].priority` decides which line breaks where two cross |
| Callout to an enlarged plan | `add_drawing_item` `shape: "callout"`, points `[corner, opposite corner, head]` (model mm), `callout: { viewId, label? }`. The head reads that view's number and sheet live |

`set_view_properties` replaces the whole `circuitGraphics`: read the view's
current one (`bim_list_views_and_sheets`) and send it back with your change.

**Typicals** (unit 001 repeated 24 times): put one unit's panel and devices in
their own group (`mutinybim-groups-phases`), feed the unit panel from the
house panel, then `bim_update_group` with `typical { count: 24, columns,
spacing_ft }`. `bim_read_panel` on the house panel then shows the feeder's
`typical_count: 24` and 24 times the unit's load in its totals; the unit panel
itself still counts one unit. Copies fed through a feeder spread over a
3-phase house panel's phases (A-B, B-C, C-A…) by default, as 24 real breakers
would; `typical.phase_rotation: "same"` keeps every copy on the original's
phases when the engineer says so.

Who is on a circuit stays the engineer's choice. The drawing only joins the
members the engineer put on it, nearest first from the home run.

## Proposing receptacles and sizing the service

The person picks the rooms and the receptacle type for each kind of location;
the proposal is code spacing only. Accepting places devices and nothing else:
never circuit them as part of it, and never pick a type yourself.

| Tool | Use it to |
| --- | --- |
| `bim_propose_receptacles` (read) | `rooms` (ids or numbers), `wall_type` (and `countertop_type`, `bathroom_type`), `mode` `dwelling` (NEC 210.52: 6 ft along wall space, counters 24 in, islands, bathrooms, laundry, hallways) or `density` with the person's `preset` (`light` ≈ 25 ft, `medium` ≈ 15 ft, `heavy` ≈ 6 ft; a firm preset, not code: it needs no `nec_edition` and its `code` says no code edition was applied; ask for the edition only for dwelling). Wall devices sit with their back flush on the wall face, clear of the corners; a "touches wall" soft clash on the device's own wall is expected. Each room: how it is treated and why, each device's `key`, position, reason and clause, and `coverage` (worst distance against the limit). `room_rules` overrides a room's treatment |
| `bim_accept_receptacles` (approval) | The same arguments plus `keep` (the keys the person kept; default all) and `base_revision`. Re-runs the proposal and places the kept ones as one edit |

The rooms come from `bim_trace_rooms` (`mutinybim-coordination`) and the
early service size from `bim_service_from_equipment_list` (`mutinybim-calcs`):
activate that pack alongside this one when the workflow below needs it.

### Workflow: receptacles for a unit

1. `bim_query_elements` kind `room`. None: trace them (`bim_trace_rooms`)
   from the plan the person points to, after they approve.
2. Ask which rooms, and which receptacle types if they haven't said
   (the Electrical tab defaults: duplex on walls, countertop GFCI, GFCI in
   bathrooms). Commercial open areas: ask light, medium or heavy.
3. `bim_propose_receptacles`. Tell them per room how many, any room that
   isn't covered and why, and the notes (a basin you couldn't find, counters
   split by a sink).
4. They keep all or name the ones to drop; `bim_accept_receptacles` with
   `keep`. Then offer circuiting as a separate step (`bim_create_circuit`,
   or `bim_apply_circuit_template` with the panel they name).

### Workflow: service size before layout

1. Get the kitchen consultant's equipment schedule and the mechanical list
   (paste, CSV, or read the PDF and pass its text) and the service voltage.
2. `bim_service_from_equipment_list`. Show the rows whose class you'd
   question (word guesses) and the ones with a `problem`; ask.
3. Re-run with `classes` (by each row's `line`; the header is a line too).
   Give the size, the minimum ampacity (`required_a`) and the trail's key
   lines (220.56 count and factor, 25% of the largest motor, 125% of the
   continuous load), and say it is an early estimate.

### Workflow: starter service layout (one-line skeleton)

(e.g. "start the one-line from a 400 A 208 V service", "lay out the service
from that size")

`bim_place_service_layout` (approval) places the meter, an optional fused
`main_disconnect`, the main distribution (`distribution.name`, default MDP)
and the `equipment` rows the person lists (`kind` panel with `bus_a`,
`system`, `mains`; or transformer with `kva`, `system` = its secondary),
each with `fed_from` naming another piece, as one edit. Where it goes:
`room` (id, number or name: the lineup runs along that room's south wall,
clear of it) or `origin_ft` (the lineup's left end in plan; wins over
`room`); neither puts it at the level origin. The Electrical tab's Service
layout sends the same command (Where it goes: In a room, At a point with
Pick in plan, or Level origin).

**Plan only** (`plan_only: true`, no `room` or `origin_ft`): the meter,
board, panels and feeders exist (one-line, panel schedules, circuits) but are
not drawn; `level` is where they will go. Use it when the person wants the
one-line or a load study before the electrical room is laid out. Each piece
is placed later from Not placed yet, by the person or with `bim_place_part`
`part_id`. Devices can be circuited to a planned panel, and a planned device
can be circuited too: everything keeps its id when placed.

1. Size: the person's number, or `bim_service_from_equipment_list` above.
2. Ask for every panel and transformer: name, rating, system, main breaker or
   lugs, what feeds it, and each transformer's primary breaker. Never fill
   them in yourself; nothing is sized from loads. Ask which room it goes in
   (the electrical room) and pass `room`; a room that isn't in the model is
   refused with the rooms that are.
3. Call it. A refusal (a 208 V panel on a 480 V board, a missing primary
   breaker, a name already in the model) is the reason to read out; fix and
   call again. The approval card's notes say when the lineup is longer than
   the room or leaves under 3 ft of working space (NEC 110.26(A)(1)); read
   them out.
4. Then the one-line workflow above: `bim_preview_one_line` `from_model: true`
   draws it with the utility over the meter. Circuiting devices stays a
   separate step.

Point-to-point fault current is a preview calc (`elec.fault_current_p2p`
through `bim_run_calc`) only where the deployment turns it on; otherwise use
the `elec-short-circuit` skill.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_electrical_report` |
| `bim_read_panel` |
| `bim_electrical_catalog` |
| `bim_propose_links_from_text` |
| `bim_preview_circuit_edit` |
| `bim_create_circuit` |
| `bim_edit_circuit` |
| `bim_add_to_circuit` |
| `bim_remove_from_circuit` |
| `bim_feed_panel` |
| `bim_rebalance_panel` |
| `bim_save_electrical_type` |
| `bim_apply_circuit_template` |
| `bim_preview_one_line` |
| `bim_layout_one_line` |
| `bim_propose_receptacles` |
| `bim_accept_receptacles` |
| `bim_place_service_layout` |

<!-- end tools -->
