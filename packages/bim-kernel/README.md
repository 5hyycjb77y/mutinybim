# @permitzip/bim-kernel

The MutinyBIM model engine: element types, intent commands, propagation,
validation, derived values and the commit policy. It runs the same in the
browser (prediction), on the authority (commit) and in workers. It must not
import any host app's code; authorization comes from the host through the contract in
`packages/bim-sync/AUTHORIZATION.md`.

## Connected routing (duct, pipe; conduit structure only)

Routing is one core for every discipline. A run is straight `run_segment`s
joined by `run_fitting`s and belongs to one `mep_system`. Each segment end and
fitting port holds a link to what it meets, and the far side holds the link
back (a placed part keeps its links per connector), so an edit reads and
writes only the elements it touches. Nothing is rebuilt model-wide, which is
what keeps routing inside the 1M-element budgets.

What differs by system lives in one table, `SYSTEM_RULES` (`src/routing/rules.ts`):

| System | Carried in | Branch fitting | Flow counted as |
| --- | --- | --- | --- |
| Supply / return / exhaust / outside air | duct | tap (straight for rectangular branches, conical for round) | CFM from terminals |
| Domestic cold / hot water | pipe | tee | water fixture units |
| Sanitary, vent, storm | pipe | combination wye | drainage fixture units |
| Hydronic supply / return | pipe | tee | GPM |
| Gas, condensate, refrigerant | pipe | tee / wye | not summed |
| Power, lighting, data, fire alarm | conduit | tee | VA (conduit routing not available yet) |

Flow on a segment is the sum of the loads beyond it, counted away from the
system's source (a unit or panel connector), or from the run's first element
when there is no source. A trunk with several taps is one segment, so it
shows the flow at its upstream end.

### Commands

| Command | What it does |
| --- | --- |
| `route_run` | Polyline + elevation + size + system, optionally from / to a part connector, an open run end, or the side of a trunk (a new branch). Creates segments, elbows, transitions or reducers, the branch fitting and a cap, links the connectors, and creates the system if it is new. All or nothing. |
| `connect_runs` / `disconnect_run` | Join two open ends that meet face to face (run–run or run–part), or cut one link. |
| `resize_run` | Any run (legacy duct runs keep working). Resizes the segment and the segments and elbows joined to it at the same size. Transitions and branch takeoffs on the edge take the new size on that side. Branches on a trunk that gets wider move out with its face. |
| `slide_branch` | Taps, tees and wyes slide along their trunk; the branch follows. The trunk stays one piece. |
| `move_elements` (parts) | Connected runs follow: runs square to the move translate, runs along it stretch, branches on a stretched trunk stay where they are. A connected part that isn't moving refuses. `rotate_elements` refuses for connected parts. |
| `delete_elements` | `refuse`: nothing is deleted while anything links to it. `disconnect`: links are cut, run ends are left open, part connectors become free. `cascade`: hosted branches go too and every run end left open is capped. Deleting a branch keeps its trunk whole (trunks are continuous). The result's `summary` says which of these happened. |
| `undo` | Restores links on both sides. Refused when anyone has since changed an affected element. |
| `swap_fitting` | Change a fitting's library type (and parameters) in place: same id, ports and links. Refused when the type can't be that fitting or its body would leave the duct beside it shorter than its fittings need. An engineer's coefficient on it is cleared (the summary says so). |
| `offset_run` | Jog a segment sideways, up or down at a distance along it: two 45° elbows, two 90° elbows, or one ogee offset. With `lengthMm` it comes back in line; without, everything beyond moves the way a part move pushes runs. Branches past the jog move with it; one where the jog goes refuses. |
| `change_elevation` | The same jog given as a new height for a stretch of a level segment (`toMm` absent: to the end of the run). |
| `split_run` | Cut a routed segment in two at a point (a plain joint: the library has no coupling fitting). Both pieces keep size, system and connections; branches stay on their side; a cut on a takeoff or one leaving a piece shorter than its fittings need refuses. |
| `resize_stretch` | New size or shape for a set of routed segments (a run, a branch, a box selection) in one atomic edit, or only between `fromMm` and `toMm` on one segment. Elbows between resized pieces follow; a transition from the library is placed where a neighbour keeps its size (or the one given: concentric, eccentric with its flat side, rect-to-round) and taken out where both sides match again. Refuses like `route_run` when a transition doesn't fit, and when a branch would be as wide as its trunk. |
| `drag_run` | Direct manipulation: a straight piece moves square to itself or along itself, or an elbow's corner moves; what it meets follows (square neighbours move, parallel ones stretch, legs at an angle stretch along themselves where the next leg allows, fixed parts refuse; legs too short for their fittings refuse). A 45° or sloped piece pushed square to itself slides so the legs beside it only stretch. `grip` moves one end of a piece (the top of a rise). A leg pulled back past its elbow refuses, or with `reroute` turns the other way (its 90° elbows flip); the view and `bim_drag_run` send `reroute` by default and stop at the limit only on request (Alt / `strict`). `dragLimit` says how far a drag can go and why it stops ("the 90° elbow needs 1.17 ft of the …"). Model settings come through `readModelSettings` (stored settings may be JSON-encoded twice). |
| `set_fitting_coefficient` | An engineer's own C on one fitting path (body, or branch / main of a takeoff), with who and when. `c: null` clears it. |
| `set_system_design` | A system's fitting choice per slot, its design altitude, air temperature, duct material and friction method, and its project coefficient table. |

### Supported cases

| Case | Supported | Unsupported (refused, nothing created) |
| --- | --- | --- |
| Leg direction | Duct: level legs at any plan angle (the Route tool snaps to 15° and 22.5° steps). Pipe: east-west, north-south or at 45°. Both: vertical drops and rises; 45° slopes in a vertical plane | Pipe at another plan angle ("Leg 2 runs at 31°…"); other slopes ("climbs at an angle") |
| Height changes along a route | A point's `elevationMm`, made straight up / down (`riseStyle: "vertical"`) or as a 45° slope towards the next point (`"45"`) | A 45° change with no point after it, or with less run before the next point than the change |
| Turns | Duct: an elbow made to the turn, up to 135° (`route-angles.ts`), with the loss for that angle; pipe: 45° and 90° elbows; ogee offsets (any bend angle 15–60°) | Duct turns over 135°; pipe turns other than 45° / 90°; an elbow type made only for some turns (mitred with vanes: 45° / 90°) at another angle |
| Fitting room | Fittings take real length (an elbow reaches r·tan(θ/2) into each leg, a transition its wall-angle length) | A leg shorter than the fittings at its ends ("Leg 3 is 0.51 ft long, but the elbow and transition there need 1.27 ft…"); `swap_fitting` / `offset_run` / `change_elevation` that make a leg too short |
| Straight length | At least the model's minimum straight piece (150 mm by default) | Shorter legs, named by number |
| Duct sizes | Rectangular, round, flat oval | Oval taller than wide |
| Pipe sizes | Nominal size + material | — |
| Size changes | One per fitting: rect↔rect, rect↔round, round↔round, oval↔any duct; pipe reducers in one material | Pipe material changes (needs an adapter); conduit size changes |
| Connectors | Duct/pipe connectors of the run's system; facing up/down (with a drop of at least the minimum straight piece, on the side it faces) or level at the run's height | Wrong system or discipline, already connected, a run on the wrong side of a vertical connector, a level connector at another height |
| Branches | Leave a level trunk sideways at the trunk's height; duct branch narrower than the trunk, pipe branch no larger; clear of the trunk ends and other branches | Branching off vertical runs, from the top or bottom, at another height |
| Moves | Square to a run (translate) or along it (stretch) | At an angle to a run; dragging a connected part that isn't moving; loops that would move two ways |
| Conduit | Element types and sizes exist | `route_run` with `domain: "conduit"` ("Conduit routing isn't available yet") |
| Obstacles | Not checked | Routing does not avoid walls or structure yet |

## Fittings and static pressure (duct)

**Library** (`src/routing/fittings/library.ts`). Every family is a row in
`FITTING_FAMILIES`: generic construction-standard type name (SMACNA HVAC Duct
Construction Standards type names, no figure numbers), the fitting types and
shapes it fits, its parameters, and two keys, `geometry` and `loss`, which are
the only places behaviour lives. Families: smooth radius elbow (r/W), smooth
round elbow, 3/4/5-gore round elbow, mitred elbow with and without turning
vanes; concentric, eccentric (flat top / bottom / side) and rectangular-to-round
transitions (length from the wall angle); ogee offset; straight, 45° entry,
conical, bellmouth and boot taps, rectangular tee, 45° lateral; end cap; pipe
fittings (placed, not calculated). Routing places the system's choice per slot
(`DUCT_FITTING_DEFAULTS`, overridden by `set_system_design`).

**Geometry** (`fittings/geometry.ts`). A fitting sits at its insertion point;
its body (cross-section rings lofted into tubes, vanes and cap discs as plates)
reaches a `takeoff` into each segment it joins, and the segment's straight
piece is cut back by that much. Swapping a family changes only derived
geometry, never topology. `fittingMesh` triangulates a body; the 3D viewer
draws library fittings with it and segments as their straight piece.

**Coefficients** (`fittings/coefficients.ts`). First match wins: the engineer's
override on the fitting (who and when), the system's project table, tables the
host passes in (firm), licensed databases (`LicensedCoefficientImporter` and
`licensedCoefficientPackageSchema`: interface and schema only, no data ships),
then the built-in formulas. The formulas are general published correlation
forms (Idelchik-form bend factors, Weisbach sharp bend, Crane-form gradual
area change, Idelchik-form diverging takeoff), not copies of the ASHRAE Duct
Fitting Database or Fundamentals tables, and every value they give is labelled
"Formula, verify for permit work".

**Pressure** (`routing/pressure.ts`). Darcy–Weisbach with Colebrook (or
Altshul-Tsal), material roughness, air density and viscosity at the system's
design altitude and temperature; fittings C x VP at the section C is
referenced to; trunks split at each tap so every stretch carries what is still
downstream; totals from the fan outward, the critical path, and the required
external static pressure. `PressureEngine` keeps one report per system and
reuses it until one of that system's elements changes; an edit re-walks only
its own system. A system asked for by id starts from the run it recorded when
it was created (`entryId`).

| Not yet | |
| --- | --- |
| Converging-flow (return, exhaust) takeoff correlations | The diverging form is used and the method says so |
| Plenum takeoffs, flex duct, dampers, terminal pressure drops | Not in the library / not added to the path |
| Custom-angle elbows in routing | The library and formulas take any angle; routing legs are still 45° / 90° |
| A system split into disconnected pieces | The report covers the piece with the fan (or the element asked about) |

## Pipe: fittings, drainage rules and hydraulics (`routing/pipe/`)

Pipe uses the same structures as duct: families in `FITTING_FAMILIES` (with a
`pipe` block: services, materials, joints, form, take-out proportions, typical
L/D, drainage direction rules), system slots, `swap_fitting`,
`set_system_design` (`design.pipe`) and the coefficient sources (override →
project table → firm / licensed → `pipe_k` formula, K = L/D x fT).

| File | What it holds |
| --- | --- |
| `specs.ts` | Pipe products as data: ASTM B88 copper K / L / M, PEX SDR 9, CPVC SDR 11, PP-R SDR 7.4, PVC / ABS DWV (schedule 40 dimensions), CISPI 301 no-hub and ASTM A74 service-weight cast iron, ASME B36.10M schedule 40 steel, CSST (placeholder bores; manufacturer EHD). OD, ID, roughness, Hazen-Williams C, Manning n, pressure class, joints |
| `families.ts` | ~45 families: domestic (elbows, tee, reducer, cap, coupling, union, ball / gate / check valves, PRV placeholder), DWV (1/4 bend, short and long sweep, closet bend, 1/8, 1/16, sanitary tee, wye, combination wye & 1/8 bend, vent tee, reducer, test cap, cleanouts, test tee, P-trap, coupling), gas (threaded elbows, tee, reducer, cap, union, gas cock, drip leg, CSST bends, tee, fitting). Slots and defaults per service and direction change |
| `geometry.ts` | Bodies with hubs by joint; take-outs that cut the straight pipe back (bends R tan(θ/2), tees, reducers, inline laying lengths); an engineer's `takeout_mm` wins |
| `drainage.ts` | Gravity: slope minimum by size, direction-change rules, flow direction through fittings, drains not shrinking downstream, inline accessory placement — as validation, so every command refuses with the reason |
| `commands.ts` | `pitchNodes` (route_run on gravity systems), `set_slope`, `place_run_accessory` |
| `hydraulics.ts` | `PipeHydraulicsEngine`: water (Hazen-Williams / Darcy, K or equivalent length, demand table or Hunter-curve-style fit, static head, critical fixture, velocity), drainage (DFU, Manning partly full, Wyly-Eaton stacks, firm capacity table), gas (Spitzglass / Mueller, longest run) |

No plumbing or gas code sizing table is bundled. Tables (demand, fixture
values, drain capacities) start empty and hold the firm's or project's own
values; built-in values are labelled "verify for permit work".

| Not yet | |
| --- | --- |
| A 45° wye on a branch | Routing branches leave square to the run, so a plain wye is refused; the combination wye & 1/8 bend is the square-branch fitting |
| 1/16 and 1/6 bends in routing | In the library; routing legs are still 45° / 90° (and pitched drains) |
| Vent sizing, trap-arm length limits, water hammer, hot-water return balancing | Not calculated |
| Material changes inside a run (copper to PEX) | Refused; needs a transition adapter |
| A drip leg drawn at the base of a drop | Placed inline on the drop |

### Legacy duct kinds

`duct_segment`, `elbow`, `tap`, `terminal` and `equipment` (the original
feasibility network) keep their own propagation (`solver.ts`) and commands.
`resize_run` and `slide_branch` pick the routed implementation when given a
routed element and the legacy one otherwise.

## Network traversal ("Tab to select more")

`selectionScopes(model, id)` returns the widening scopes around any piece of a
routed run (or a part linked to one, or a legacy equipment-rooted tree):
element, stretch (same-size straight pieces joined end to end, such as the
two halves of a split, up to a fitting, part, size change or open end; routed
runs only), run (straight pieces and in-line fittings up to a takeoff, part or
open end), branch (the nearest upstream takeoff and everything beyond it, to
the terminals) and system (everything connected). Scopes that hold the same
elements collapse into the wider name. `scopeSummary(model, ids)` gives the
counts, straight length, flow entering and systems for a scope. Host
independent; walks only the network the piece belongs to.


## Groups and phases (`organization/`)

Every model element (duct, pipe, part, wall…) is in one **group** and is
**built in** one **phase**, optionally **demolished in** a later one. Views,
sheets, annotations, levels, types and systems have neither.

- **Storage.** Groups, phases, phase filters and the active group / phase are
  elements of kind `organization` in one model-wide partition (`*|organization`),
  so they sync, conflict and undo like everything else and every area loads
  them. With none stored, built-in defaults apply: groups General, Existing to
  remain, New work, Demolition, Coordination; phases Existing, New
  construction; filters Show all, Show new, Show existing + demo, Show
  complete. Editing a default stores it under the same id.
- **Existing models.** `groupId` / `phaseCreated` / `phaseDemolished` are
  optional on every element: absent means General, New construction, not
  demolished. Nothing is rewritten.
- **Commands.** `create_group`, `update_group`, `lock_group`, `delete_group`
  (`moveTo`, or refused while it has elements; General can't be deleted),
  `set_active_group`, `assign_elements_to_group`, `create_phase` (`after`),
  `update_phase` (rename / move in time; refused if something would be
  demolished before it is built), `delete_phase` (refused while used),
  `set_active_phase`, `set_element_phases`, `demolish_elements`,
  `undemolish_elements`, `create_phase_filter`, `update_phase_filter`,
  `delete_phase_filter`. Field-level conflict checks use `org.*` fields.
- **Rules in `finish`.** Every command (routing, parts, fittings, undo, agents)
  passes `organization/rules.ts`: new elements take the active group and
  phase; anything that would create, change, move into or out of, or delete an
  element of a **locked** group is refused with code `locked` and a plain
  reason naming the group. Derived values (a flow total) still update.
- **Display.** A view's `phaseId`, `phaseFilterId` and `groupDisplay`
  (show / halftone / hide per group) resolve through `displayResolver` to
  visible / halftone / dashed per element: hide wins, dashed comes from the
  phase filter, halftone from either. Elements created after the view's phase,
  or demolished before it, never draw. The drawing engine (plans, sections,
  3D), sheets, PDF and the live canvas (`ModelViewer3D.setDisplayContext`) all
  use it. Budget: `view.visibility.resolve` (whole 1M model in under 50 ms p50).
- **Interop (`organization/interop.ts`).** `ifcOrganizationProperties` is what
  an IFC writer emits per element: an IfcGroup (by IfcRelAssignsToGroup) and
  `Pset_MutinyBIM_Organization` with Group, Phase Created and Phase
  Demolished (IFC has no phase entity). `organizationHintsFromRevit` reads a
  Revit element's Workset / Phase Created / Phase Demolished parameters as
  hints and `matchHints` finds same-named groups and phases; they never change
  an element on their own. MutinyBIM has no IFC writer yet, so the export side
  is the mapping only.
