---
name: mutinybim-calcs
description: "MutinyBIM pack for calculations: list and run code calculations against the model, duct size advice from airflow, a duct system's pressure report, a pipe system's hydraulics report, fitting coefficient overrides, a pipe system's code sizing proposal, and service size from an equipment list. Use with the mutinybim core. Trigger on: calculation, calc, duct size, pressure drop, static pressure, external static, hydraulics, fixture pressure, size pipes, gas sizing, coefficient, service size."
license: Apache-2.0
compatibility: "Needs the mutinybim MCP server with the calcs family turned on (bim_enable_pack, --packs calcs, or /packs/calcs/mcp under the MutinyBIM base)."
metadata:
  pack: "calcs"
  mcp-server: "mutinybim"
  family: "calcs"
  token-cap: "3700"
  tools: "bim_list_calcs bim_run_calc bim_suggest_duct_size bim_pressure_report bim_pipe_report bim_set_fitting_coefficient_override bim_size_pipes bim_service_from_equipment_list"
---

# MutinyBIM: engineering calcs with code citations

A family of the `mutinybim` core. Activate `mutinybim` first for the model
reads; `bim_preview_route_edit` is the `model` family. Calcs are read-only: nothing is saved and nothing needs approval. Two
edits live here, each behind the person's approval:
`bim_set_fitting_coefficient_override` (preview it with `bim_preview_route_edit`)
and `bim_size_pipes`, which applies a gas, domestic water, sanitary, vent or
storm system's sizing proposal.

Wire, breaker, ground and conduit sizes, voltage drop, NEC demand loads, duct
friction and fan static pressure, and pipe friction and hydraulics, all run
through one calc interface. Every value comes back with the clause or method
it rests on (`NEC 2023 Table 310.16, copper 90°C column`, `NEC 2020 250.122(B)`,
`Chapter 9, Table 9`). Nothing is saved.

| Tool | Use it to |
| --- | --- |
| `bim_list_calcs` (read) | See every calc: id, what it does, whether it reads a model, a worked example input and the input schema. Filter with `domain` (`electrical`, `mechanical`, `plumbing`) |
| `bim_set_fitting_coefficient_override` (approval) | Record an engineer's own loss coefficient on one fitting (with their name and time); it wins over tables and formulas. `c = null` clears it |
| `bim_run_calc` (read) | Run one calc with `project_id`, `calc`, `inputs`; `model_id` for calcs that read a model. The code edition is `nec_edition` / `plumbing_edition` / `fuel_gas_edition` (the same fields `bim_size_pipes` takes), else the project's Code Study, else `state`. Returns values with units and citations, the steps in plain language, issues, and `run_key` (the same request always gives the same answer) |
| `bim_size_pipes` (edit, approval) | Apply the sizes the system's calc proposes for one system (`system_id`): gas by `plumbing.gas_system`, domestic water, sanitary, vent and storm by `plumbing.size_system`, recomputed at the approved revision: undersized pipe goes up (`allow_smaller` also reduces oversized), reducers where sizes change, one undo. `fuel_gas_edition` / `plumbing_edition` / `state` only when Code Study names no code |
| `bim_service_from_equipment_list` (read) | `text` (pasted schedule, CSV, or text out of a PDF), `voltage_v`, `phases`: every row with its VA, how it was read and a suggested load class, then the service size with the Article 220 trail. Rows are numbered by line in the pasted text: non-blank lines from 1, the header counted, so the first data row of a CSV is line 2 (`header_line`, `lines_note`). Send the person's corrections as `classes [{ line, class }]` by those numbers; a line with no equipment row is refused with the valid lines listed, and a class they set reads `class_why: "set by you"`. `required_a` is the minimum ampacity: noncontinuous plus 125% of continuous (215.2(A)(1)(a) / 230.42(A)(1)); lighting and fixed electric space heating (424.4(B)) count as continuous, the heating demand taken at 100% (220.51) before the 125%. `service` / `service_a` is the next standard rating at or above it, an early selection, not the whole-building calculation: report both. Structured rows: `bim_run_calc` `nec.service_size` |
| `bim_pressure_report` | Read a system's pressure: velocity, friction and fitting losses by section, the critical path, and the fan's required external static pressure. Coefficients carry their source; formula values say "verify for permit work" |
| `bim_suggest_duct_size` (read) | The smallest standard duct for `airflow_cfm` (or what `element_id` carries) at the system's friction rate and velocity limit, with its velocity and friction; rectangular also gives the narrowest width at `height_in` (or the segment's depth) and the least-sheet-metal size. `check_width_in` / `check_height_in` / `check_diameter_in` reports a size you have in mind. Changes nothing |
| `bim_pipe_report` | Water: gpm, velocity, friction, fitting K, pressure at every fixture and the critical one. Drainage: fixture units per pipe and stack, capacity at slope. Gas: cfh, drop, longest run. Built-in values say "verify for permit work" |

Calcs: `nec.size_circuit` (branch circuit or feeder: device, conductor, voltage
drop upsizing, EGC grown in proportion, conduit), `nec.demand_load` (Article 220
calculated load at a panel or service), `nec.conductor_ampacity`,
`nec.voltage_drop`, `nec.egc`, `nec.conduit_fill`, `mech.duct_friction`,
`mech.duct_system_pressure`, `plumbing.water_friction`, `plumbing.pipe_system`.
The duct and pipe system calcs give the same numbers as `bim_pressure_report`
and `bim_pipe_report` (below).

- **NEC edition.** The project's adopted electrical code from its Code Study
  is used; else pass `state` (VA, MD, DC are on file) or `nec_edition`
  (`2020`, `2023`). With none of these the tool asks; never pick an edition
  yourself. Say which edition the answer is under.
- **Size a feeder:** `nec.size_circuit` with `{circuit: "feeder", system: "3ph_4w",
  voltage_v: 480, continuous_load_a: 100, length_ft: 250}` → 125 A, `#1` Cu
  (130 A at 75°C), 1.52% drop, `#6` EGC, 1-1/2 in EMT.
- **Long branch circuits** (site lighting at 277 V or 480 V): keep the breaker
  with `ocpd_a: 20`; the tool upsizes the conductor for the 3% target and grows
  the EGC with it (20 A, 300 ft, 16 A at 277 V → `#8`, `#8` EGC). Write the
  real size in the panel schedule, never "SEE SLD".
- **Demand at a panel or service:** give `nec.demand_load` the raw list of
  every load below that panel (not the child panels' demand). Kitchen
  equipment (220.56) is factored by the count at that panel, so the MDP and the
  panel serving the kitchen get different factors for the same freezer.
- Voltage-drop targets (3% branch, 3% feeder, 5% combined) are design
  criteria, not code; the result says so. Override with `max_voltage_drop_pct`.
- Quote the values and citations as returned. If an `error` issue comes back
  (device smaller than the load, beyond the tables, parallel sets needed),
  tell the person; don't work around it by hand.

## Ventilation and pressurization (per space, zone and building)

- **Outdoor air (`mech.ventilation_outdoor_air`, `model_id`).** `inputs: {
  scope: "model" | "level" | "zone", level_id?, zone_id?, governing?, state?,
  project_mechanical_code? }`. Returns Σ Voz under IMC and ASHRAE 62.1, the
  exhaust required, which standard governs (the adopted code), the arithmetic
  per space (7.5 × 70 people + 0.18 × 1,000 ft² = 705 cfm) and an issue per
  space that can't be calculated. Outdoor air comes from each space's use,
  people and area: a space with no use, no occupants or no outline has no
  number; say which and fix the input, never type a value. Both standards are
  shown; the adopted one governs. Multi-zone system efficiency (Ev) isn't
  calculated yet: say so when asked about a VAV system.
- **Pressurization (`mech.pressurization`, `model_id`, `{ scope, level_id?,
  zone_id? }`).** Exhaust out against makeup air and unit outdoor air in, per
  zone and for the building. Kitchens stay negative to dining; the building
  slightly positive. The numbers come from the parts' `exhaust_cfm`,
  `makeup_air_cfm`, `outdoor_cfm` (`bim_set_parameters`; a roof fan names its
  zone in `serves_zone`); when one is missing, say which and ask, never total
  the rest. **Untempered makeup air (`mech.makeup_air_heat`, `{ cfm, from_f,
  to_f }`)** adds 1.08 × cfm × ΔT to the unit serving the zone (2,400 × 1.08 ×
  (92 − 80) = 31,104 Btu/h).
- The same numbers print live on a sheet: the ventilation or pressurization
  table block (`add_field_block` with `block.table`, model family).

## Plumbing and fuel gas

- **Building sewer and sewage pumps (`plumbing.building_sewer`,
  `plumbing.sewage_pump`).** A floor below what drains to the sewer by gravity
  needs a sewage pump (IPC 712.1); a fixture whose flood rim is below the next
  upstream manhole cover needs a backwater valve (IPC 715.1). Report capacity
  as "394 DFU on a 4" drain at 1/8"/ft; that size carries 180 at that slope".
  Never convert DFU to gpm for a pump: say it can't be calculated from fixture
  units and ask the engineer for the inflow in gpm. An assumed invert gets a
  question to the contractor (model family: questions), or
  `elevation_confidence: verified` once measured. The same checks show in
  `bim_lint_check` (rules `sewer-floor-needs-pump`, `sewer-floor-needs-backwater`,
  `building-drain-over-capacity`, `sewer-elevation-unverified`,
  `sewage-pump-inflow-unknown`, `sewage-pump-undersized`).

Tables come from the model server's code library (Virginia Plumbing Code 2021 = 2021
IPC as amended; Virginia Fuel Gas Code 2021 = 2021 IFGC), cited like
`VPC 2021 Table 710.1(1)` and `VFGC 2021 Table 402.4(28)`. In Virginia
deliverables say **VFGC / VPC**, never IFGC / IPC.

- **Edition.** Pass `state` (VA → VPC / VFGC 2021; MD, DC plumbing → their
  2021 IPC with "check local amendments"). MD and DC list no fuel gas code,
  and other states aren't on file: the tool asks; ask the engineer which
  edition applies. Never pick one yourself.
- **Demand (`plumbing.hunter_demand`).** Pick the curve by building type:
  restaurant → `ashrae_a`, hospital / nursing home / dormitory / hotel /
  motel → `ashrae_b`, apartments → `ashrae_c`, offices / schools → `ashrae_d`
  (or pass `building_type`). IPC Appendix E is not in the library: use
  `ipc_e_tank` / `ipc_e_valve` only with the firm's points. Restaurant
  check: 43.25 WSFU on Curve A → 48 gpm (the old built-in fit said 23.4;
  the result shows both). `chart` returns all four curves and the operating
  point for the sheet's graph.
- **Pressure loss report (`plumbing.pressure_report`).** Design minimum (or
  flow test), meter, tap, backflow (RPZ), PRV, static head (height × 0.433,
  or the firm's 0.43), highest fixture pressure by its Table 604.3 name →
  psi left for friction (for example: 50 − 4.5 − 25 − 0.28 − 3.01 − 9.8 = 7.41).
  Add `developed_length_ft` for the allowable psi per 100 ft, then
  `plumbing.size_water` with that pressure.
- **Drains (`plumbing.size_drain`).** `role` building_drain (by slope,
  3 in. minimum with a water closet), horizontal_branch or stack; give DFU
  or fixtures by Table 709.1 name. Floor sinks need a rating (709.4): ask.
- **Gas (`plumbing.size_gas`).** Give the drawn tree as segments (`parent`
  null at the point of delivery, `length_ft`, appliance `load_mbh` at the
  end, fittings as `equivalent_length_ft`), gas, material (`sch40`, `copper`,
  `csst`, `pe_pipe`, `pe_tubing`), inlet and allowable drop. `method`
  longest_length (402.4.1, default) or branch_length (402.4.2). For a 2 psi
  system with line regulators (402.4.3 hybrid) run each pressure zone
  separately. Sizes come from the matching 402.4(n) table, with the
  equation beside it; when no table is loaded the tool says so and sizes by
  the equation.
- **A drawn gas system (`plumbing.gas_system`, `model_id`, `system_id`).**
  Use this, not hand-typed segments, when the gas pipe is in the model.
  Regulators split it into pressure zones: place one with
  `bim_place_pipe_accessory` family `pipe.gas.regulator`, params `role`
  (line, service, appliance), `outlet_in_wc` (2 psi = 55.4), `zone_drop_in_wc`,
  `vent`; change one with `bim_swap_fitting` (same family, new params). A
  regulator starts its zone where it sits: every branch, load point or
  appliance past it along that pipe is on its zone, including a load at the
  far end of a pipe whose regulator sits partway along. To keep a load on the
  inlet zone, put the regulator on the branch that feeds only what it
  regulates; a branch or load at the regulator's own point stays on the inlet
  zone. The system's own inlet and drop are its design (`gasType` propane / natural,
  `inletPressureInWc`, `allowableDropInWc`, `gasSizing` branch_length) via
  `bim_set_system_design`. `gasType` is also the word every label, tag,
  schedule and riser prints: set it on a propane system, never rename pipe
  to say so. Polyethylene below grade is material `pe` (spec `sdr11`,
  fusion fittings) and reads the PE tables (propane 402.4(35)/(36),
  natural gas 402.4(20)-(22)). A load point on an open gas pipe end
  (`load.mbh`) is an outlet like an appliance. The calc returns each zone
  (pressure, drop, input, longest run, the 402.4(n) table read), every
  pipe's needed size against the drawn one, the gas equipment rows,
  `connections` (each outlet's input, zone, regulator, feed size,
  `developedLengthFt` from the source along the routed pipe, `basisText`,
  `requiredSize`) and the total input, and
  findings: `regulator_missing` (an appliance on a zone above its 14 in. w.c.
  maximum), `undersized_gas_pipe`, `zone_below_appliance_minimum`,
  `regulator_over_capacity`, `regulator_raises_pressure`. Show the person the
  changes, then `bim_size_pipes` (one approval). Example: a restaurant cook
  line on propane, 11 in. w.c. / 0.5 in. at 100 ft: 1-1/4" manifold, 1" range, 3/4"
  fryers and grill; 1,024,407 Btu/h total. The gas equipment schedule is
  `bim_schedule_define` `form.kind` `gas_equipment`; the per-outlet schedule
  with developed lengths is kind `gas_connections` (`mutinybim-schedules`).
  Gas pipe tags (template `gas_pipe`, or auto on gas pipe) print size and
  piece length (`1" 3 LF`); tag fields `gas.size`, `gas.length`,
  `gas.from_source`, `gas.zone`, `gas.fuel`.
- **A drawn water or sanitary system (`plumbing.size_system`, `model_id`,
  `system_id`).** Use this, not hand-typed segments, when the pipe is in the
  model. Water: fixture units to gpm on the system's curve (its own, else the
  project's, else the building type's; with none it refuses: ask, never use
  the old fit), a branch capped at what its fixtures draw at once; friction
  within (supply − fixed losses − static head − critical fixture) over the
  longest developed length + 30% fittings, set on the system with
  `bim_set_system_design` `pipe_design` `supplyPressurePsi`, `fixedLossesPsi`,
  `minFixturePressurePsi` (no supply: velocity only, with a finding);
  velocity ≤ 8 ft/s cold, 5 hot; fixture supplies ≥ Table 604.5. Example, a
  restaurant's cold water: 43.25 WSFU → 48 gpm at the 2" service, water closet branches 3/4".
  Sanitary: building drain (trunk from the outfall, anything below a stack) by
  Table 710.1(1) at its drawn fall, branches and stacks by 710.1(2), 3" with a
  water closet, never smaller downstream. A `system_slope_rule` finding means
  the system's own minimum slopes are steeper than Table 704.1: set
  `pipe_design.slopes` from the code if the engineer agrees. Returns each
  pipe's needed size against the drawn one (`carries`, `governs`) and
  findings. Show the changes, then `bim_size_pipes`.
- **A drawn vent system (`plumbing.size_system` on the vent system).** Each
  vent pipe vents the fixtures beyond it from the open air (their vent load
  points share the fixture's mark with its waste point, or the fixture part's
  vent connector): `carries` gives the DFU vented, the developed length and
  the drain it serves (where those fixtures' drains meet). A vertical vent
  serving a stack (vent stack, stack vent): Table 906.1 on the stack's size,
  the DFU and the developed length to the open air, never under half the
  stack or 1-1/4". Every other vent: half the drain Table 710.1(2) needs for
  its DFU, 1-1/4" least, one size up over 40 ft measured to the vent stack it
  joins (906.2, 906.3). `no_vent_terminal`: a piece with no open end to the
  air; say so.
- **A drawn storm system (`plumbing.size_system` on the storm system).** Roof
  area per drain from the load point's custom quantity "Roof area" (sq ft),
  else its flow turned back into area at the rate. The rate is the system's
  `pipe_design.rainfallInPerHr` (`bim_set_system_design`); the code library
  holds Figure 1106.1 only as map images, so with no rate the calc refuses
  (`no_rainfall_rate`): ask the engineer for the 100-year, 1-hour rate from
  approved local weather data, never guess one. Leaders by Table 1106.2(1),
  horizontal drains by Table 1106.3 at their fall (1/8 in/ft least), read in
  the next whole in/h column, never smaller downstream. Over 12 in/h
  (leaders) or 6 in/h (horizontal) it refuses by name.
- **Water heater / grease interceptor / meter.** These report the required
  gal/h, gpm, lb or psi and pass/fail against a rating the engineer gives.
  Never suggest a make or model.
- **Auto-sizing is off by default** (check and suggest; the system's
  `sizingMode` is `check`). Turn it on (`bim_plumbing_design`, project or one
  system) only when the engineer asks. When a system is on auto, every saved
  edit that touches it is followed by its resize, each its own revision and
  undo, and the edit's result says "Auto-sized N pipes on …"; don't call
  `bim_size_pipes` again for it. On check, call `bim_size_pipes` only when the
  engineer asks.
- **Hunter curve chart.** `plumbing.hunter_demand` `chart` gives the curves and
  one operating point; the Plumbing tab's Sizing › Hunter curve shows every
  water system's design point live. To put it on a sheet, `bim_draw_detail`
  a `figure` item with `chart: "plumbing.hunter_curve"` (`mutinybim-drafting`);
  it redraws live from the model and prints.

One-line diagrams that show these sizes are `mutinybim-electrical`.

<!-- tools: rendered from the catalogue by `npm run build:files`; edit the catalogue, not this list -->

## Tools in this family

| Tool |
| --- |
| `bim_list_calcs` |
| `bim_run_calc` |
| `bim_suggest_duct_size` |
| `bim_pressure_report` |
| `bim_pipe_report` |
| `bim_set_fitting_coefficient_override` |
| `bim_size_pipes` |
| `bim_service_from_equipment_list` |

<!-- end tools -->
