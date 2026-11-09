# MutinyBIM pack contract, version 1.13.0

**Internal, versioned, enforced. Not a public promise** until MutinyBIM is
open-sourced (product decision, Oct 29 2026). Pack authors import `@permitzip/bim-pack`
and nothing else from MutinyBIM except `@permitzip/bim-units` and the kernel's
published subpaths for types.

## What a pack is

A namespace plus contributions to versioned extension points:

```ts
import { contribute, definePack, SERVICE_POINT, NETWORK_ADAPTER_POINT } from "@permitzip/bim-pack";

export const STRUCTURAL = definePack(
  { id: "struct", name: "Structural", version: "1.0.0", kernel: "^1.0.0" },
  [contribute(SERVICE_POINT, [gravityLoad]), contribute(NETWORK_ADAPTER_POINT, [{ id: "struct.load_path", adapter }])],
);
```

`definePack` throws `PackDefinitionError` listing **every** problem.
`runPackConformance(pack)` returns `{ ok, problems }` and is what a host runs
before loading a pack.

### Manifest

| Field | Rule |
| --- | --- |
| `id` | The namespace: 2–24 lower-case letters, digits or underscores, starting with a letter. Reserved: `firm`, `core`, `kernel`, `builtin`, `project`, `user`, and the first-party ids `electrical`, `plumbing_gas`, `mechanical`. |
| `name` | Display name. |
| `version` | The pack's semver (`1.2.3`). A model pins this exact version. |
| `kernel` | The contract range it was written for (`^1.0.0`). Checked against `PACK_CONTRACT_VERSION`. |
| `requires` | Other packs it builds on, `{ id, range }`. |
| `firstParty` | Shipped by PermitZIP. |

## Ids

One grammar for every stored registry id (`packages/bim-kernel/src/ids.ts`):

- built-in rows are **bare** (`sanitary`, `thermal`, `dedicated`) and reserved;
- firm rows are `firm:<slug>`;
- **pack rows are `<pack>.<name>`** (`struct.gravity_load`), lower snake case,
  at most 96 characters.

Every point with stored ids requires the pack's own namespace. A pack row
equal to a built-in row is refused; two packs contributing one id are refused.
Readers of this release already accept, keep and show any id of this shape,
so a newer server writing a pack id never breaks an older browser.

Agent tool names can't hold dots: they are `<pack>_<verb>` (`struct_size_beam`).

## Extension points (all version 1)

| Point id | Import | Item | Notes |
| --- | --- | --- | --- |
| `kernel.class` | `CLASS_POINT` | `PackClass` (an `ObjectClass` without `source`) | Merged into the registry value; `drawsUnder` puts it under a view category, `ifc` maps it for export. |
| `kernel.service` | `SERVICE_POINT` | `ServiceRow` | What flows. `adapter` names a network adapter id; `regime` and `connector` must be ones this release walks, or the row is listed and not walked. |
| `kernel.network_adapter` | `NETWORK_ADAPTER_POINT` | `{ id, adapter?: TradeAdapter, aggregation?: NetworkAggregation }` | One face or both. `adapter` is the served-from link rules (`source`, `connectors`, `positionsNeeded`, `refusal`, `positionsRefusal`, optional typed `solve(model, ctx)`); its `trade` is the stored link trade its links carry, one of `electrical`, `plumbing`, `mechanical`. `aggregation` is a network the kernel walks and totals for any service: `quantities` (parameter keys that add up), `direction` (`toward_source`, `downstream`, `downward`), `over` (`served_from`, `physical`) and `network(model, { serviceId })` giving roots, children and each node's own quantities; a node id is an element id or `<elementId>@<port>` (a beam's `@start` / `@end`); a child listed under two parents reaches both, and the network's optional `across(child, parent, total)` says what share reaches each (applied after `edgeFactor`; `IncrementalTotals.build` takes several parents per node and honours it). Optional `solve(model, ctx)` gives a looped problem to `solveNetwork` when the item has no link rules. `serviceNetworkTotals(model, serviceId)` totals it (each key summed, `networkTotals`). Adapter ids: the three built-ins, else `<pack>.<name>`; no other bare word is reserved. Built-in adapters are asked first. |
| `kernel.parameter_set` | `PARAMETER_SET_POINT` | `PackParameterSet` (`{ id, label, parameters: PackParameter[] }`) | Every key `<pack>.<name>`; quantities name a bim-units kind and a unit of it. They join the field registry (`fieldProviderRegistry()` in scope) so the Inspector, schedules, agent tools and IFC export (`ifc`) read them; values live in the element's `values[key]` in the parameter's unit, written with `set_element_values`. |
| `kernel.derived_zone_rule` | `DERIVED_ZONE_RULE_POINT` | `DerivedZoneRuleDef` | `takes` (from a part's clearances) or `derive` (from any host), with `dependsOn` for caching. |
| `kernel.pipe_material` | `PIPE_MATERIAL_POINT` | `PipeMaterialRow` (`{ id, label, fallback }`) | A pack's pipe material (`civil.rcp`); its label prints in size labels; `fallback` is the built-in material older readers size it as. |
| `kernel.zone_purpose` | `ZONE_PURPOSE_POINT` | `{ id, label, ifc? }` | Writable by zone commands in a model bound to the pack; `ifc: { entity: "IfcZone" \| "IfcSpatialZone", predefinedType?, objectType? }` is read by the IFC exporter. |
| `kernel.facet` | `FACET_POINT` | `FacetDef` | Its words may not repeat a built-in facet's. |
| `kernel.symbol` | `SYMBOL_POINT` | `SymbolDef` | |
| `kernel.agent_tool` | `AGENT_TOOL_POINT` | `AgentToolDescriptor` | Data only: name, title, description, JSON Schema input, `read` or `write`, and the kernel command or read it maps to. The host may expose it within its tool budget. |
| `lint.rule` | `LINT_RULE_POINT` | `RuleDef` | `pack` must be the pack's id; pack rules run in the default and issue checks. An element rule's `reads` (element kinds) re-runs it on every element it lints when an edit changes one of those kinds. |
| `calc.calc` | `CALC_POINT` | `RegisteredCalc` (build with `defineCalc`) | `domain` is open (use the pack id). A value's `unit` is a calc unit or any bim-units code (`lbf`, `cfs`); a unit neither knows fails the run in words. |
| `calc.code_edition` | `CODE_EDITION_POINT` | `CodeFamilyDef` | A code family (`struct.asce7`) with its editions and its own resolver; the resolver reads the run request (its calc inputs included), so no new request field is ever needed. |
| `library.space_use_rate` | `SPACE_USE_RATE_POINT` | `SpaceUseRateTarget` | A rate key and the parameter key it loads onto. |
| `library.space_use_rate_value` | `SPACE_USE_RATE_VALUE_POINT` | `SpaceUseRateValue` (`{ useId, key, value, unit, cite }`), id `<key>.<useId>` | A pack's rate on a use it doesn't own (a live load on the built-in office row). The row gains it inside the scope; `pinSpaceUse` returns rates onto parameter keys as `parameterRates`, in the target's `unit` per m² or per occupant; a space stores them in its pinned use (`parameterRates`, written only to peers advertising `spaces:parameter_rates`) and `evaluateParameterRates` totals them. |
| `library.space_use` | `SPACE_USE_POINT` | `SpaceUseRow` | Validated by `spaceUseRowSchema` with the pack's rate keys in force. |

Classes: the kernel's built-in rows include `struct.footing` (IfcFooting, components of category `footing`), which a pack may parent. A condition path `system.<property>` reads a run's system (`system.systemKind` equals `civil.storm`), so a pack class recognises pipes on its own system.

An element that names its class (`ElementCore.classId`) is in that class when the registry knows it, whatever the class's recognition rule says; recognition still answers for everything else it is.

Unit kinds are not a point: `@permitzip/bim-units` is the lowest layer and can't
read packs, and its 51 kinds already cover structural (force, moment, stress,
area load) and civil (flow, slope, rainfall intensity) quantities.

## Points our trades plug in at (1.3.0)

Each is declared beside the code that reads it and re-exported from
`@permitzip/bim-pack`. The eight process-wide trade installers
(`installVentilation`, `registerPressureTargets`, `registerNecRules`,
`registerElectricalRules`, `registerVentilationReader`,
`registerFeederTypeCatalog`, `registerTradeAdapter`, `registerDerivedZoneRule`)
are gone: what they installed is a contribution read per model.

| Point id | Constant | Item | Notes |
|---|---|---|---|
| `kernel.command` | `COMMAND_POINT` | `PackCommandDef` (`type`, strict zod `schema` whose `type` is `z.literal(type)`, `execute(model, command, context)`) | Not namespaced (types are stored). A type no kernel command uses. Parses through `commandSchema` (issues are the pack schema's own) and runs through `executeCommand`, alone or as a `batch_edits` step, only while the pack is in the model's set. A pack command travels as a `PackCommand` envelope. |
| `kernel.pack_read` | `PACK_READ_POINT` | `PackReadDef` (`id`, `label`, `run(model, input)`) | What an agent tool's `{ kind: "read" }` target names. Reads never edit. |
| `kernel.command_builder` | `COMMAND_BUILDER_POINT` | `CommandBuilderDef` (`id`, `label`, `build(model, input)` → `{ command }` or `{ refused }`) | What an agent tool's `{ kind: "build_command", build }` target names: a write whose command comes from the model (sizes, slots, plans, one of several commands). Never edits; the host checks the command with `commandSchema` and sends it through the edit spine. |
| `kernel.field_provider` | `FIELD_PROVIDER_POINT` | `FieldProviderRow` (`id`, `provider`, `rank?`) | Lower `rank` first; a pack's default `FIELD_PROVIDER_DEFAULT_RANK` (after every built-in and first-party provider). `fieldProviderRegistry()` is built once per set. |
| `kernel.demand_rule_set` | `DEMAND_RULE_SET_POINT` | `ElectricalRules` | No `idOf` (stored ids like `nec-2023`); the first row with an id wins, in set order. |
| `kernel.outdoor_air_reader` | `OUTDOOR_AIR_READER_POINT` | `VentilationReader` | The last row in set order is in force (a model's pack overrides the first-party engine). |
| `kernel.pressure_target` | `PRESSURE_TARGET_POINT` | `PressureTargetRow` (`id`, `target`) | The last row in set order is in force. |
| `kernel.drawn_source` | `DRAWN_SOURCE_POINT` | `DrawnSourceRow` (`id`, `check(elements, hostId, sourceId)` → true, false or null) | Whether the network drawn to a piped load comes from the source it names (`load-status-mismatch`). The first row that can tell answers; with none, a piped load is never a mismatch for that reason. |
| `kernel.network_coupling` | `NETWORK_COUPLING_POINT` | `NetworkCouplingDef` (`id`, `couples(elements, part)`, `isOutlet(elements, part, connector)`, `carry?(input)`) | A part that is the source of one system and a load on another (a water heater; a heat exchanger, a pump skid). The run walks root a system at a coupler's outlet, walk on through a coupler's other connectors, and add what `carry` puts into a walked tree's own loads; `serves` treats a coupler as a source. No built-ins. |
| `kernel.link_type_catalog` | `LINK_TYPE_CATALOG_POINT` | `LinkTypeCatalogRow` (`id`, `read`) | What a link-type mark means, from model data. The last row in set order is in force. |
| `kernel.diagram_graph` | `DIAGRAM_GRAPH_POINT` | `DiagramGraphDef` (`kind`, `build`, `roots?`) | By stored diagram kind. The layouts (`layout/one-line.ts` and the piping layouts) stay generic kernel code. |
| `kernel.block_hop` | `BLOCK_HOP_POINT` | `BlockHopDef` (`id`, `target`) | A token path's first word (`{service.name}`). |
| `kernel.block_dependency` | `BLOCK_DEPENDENCY_POINT` | `BlockDependencyDef` (`id`, `collect`) | What else a block that read an element depends on. |
| `kernel.form_schedule` | `FORM_SCHEDULE_POINT` | `FormScheduleDef` (`kind`, `evaluate`) | By stored form kind. |
| `kernel.system_label` | `SYSTEM_LABEL_POINT` | `SystemLabelDef` (`id`, `label(system)` → words or null) | What a system is, in words, beyond its kind's word (a gas system's fuel). `systemKindLabel` takes the first row that answers, else the kind's word. |
| `kernel.pipe_run_check` | `PIPE_RUN_CHECK_POINT` | `PipeRunCheckDef` (`id`, `segment?`, `fitting?` → `RunIssue[]`) | A trade's checks on pipe runs (drainage slope and flow direction). Run with the shared pipe checks: segment issues before hosted-item spacing, fitting issues after the accessory check and before joints. |
| `kernel.serves_rule` | `SERVES_RULE_POINT` | `ServesRuleDef` (`id`, `rank`, `served`, `systemKinds?`, `sources?`, `servers?`, `sourceOf?`) | A trade's own `serves` / `source` walk (gas zones). `rank` below 50 lists before the shared piped walk; the piped walk skips the row's `systemKinds`. |
| `kernel.connection_quantity_check` | `CONNECTION_QUANTITY_CHECK_POINT` | `ConnectionQuantityCheckDef` (`id`, `trade`, `systemKinds`, `warning(name, bag)`) | A value almost certainly in the wrong unit (a gas minimum inlet pressure in psi no outlet takes). Run when a connection type of `trade` is saved (`connectionTypeQuantityWarnings`) and when a load point is placed on a pipe of `systemKinds` (`loadPointSystemFit`). |
| `kernel.starter_connection_type` | `STARTER_CONNECTION_TYPE_POINT` | `ConnectionTypeEntry` | By catalog key of the designator (no `idOf`: designators aren't registry ids; the first row wins). Added to a project's catalog the first time a load point names one (`starterConnectionType`). |
| `kernel.part_type` | `PART_TYPE_POINT` | `BuiltinPartTypeRow` (`entry: LibraryEntry`, `superseded?`) | Built-in part types an add-on ships. No `idOf`: stored type ids (`builtin:panelboard-225@1`) aren't registry ids; the first row with an id wins, so a pack never replaces a built-in. `builtinPartTypes()` offers the kernel's rows, then the first-party add-ons' in first-party order, then the model's packs; `superseded` rows stay readable through `builtinPartType(id)` and are never offered. |
| `calc.source_supply` | `SOURCE_SUPPLY_POINT` | `SourceSupplyRow` (`id`, `read(elements, part)` → `{ name, voltageV, phases }` or null) | What a source puts out, for the load totals by source (`sourceLoad`: the current a source's connected load draws). The first row that answers wins. |
| `lint.rule` (`rank`) | `LINT_RULE_POINT` | `RuleDef.rank?` | Where a rule runs among the others, lower first. Built-in groups are 100–1200 in steps of 100; first-party add-ons' groups fill the gaps so they run where they did when built in. A rule without one runs after every ranked rule. |
| `calc.preview_calc` | `PREVIEW_CALC_POINT` | `RegisteredCalc` | A calc still being checked: registered only by `builtinCalcRegistry({ preview: true })`, never listed by default. |

Pack commands are typed by declaration merging (`PackCommandTypes` in
`@permitzip/bim-kernel/commands`): an add-on names its command types there and
`Command` includes them in every compile that includes the add-on; the kernel
names none.

### Agent tools (1.3.0 additions)

- **Targets:** `{ kind: "command", command }` (the input becomes that command),
  `{ kind: "read", read }` (a `PACK_READ_POINT` row) and
  `{ kind: "build_command", build }` (a `COMMAND_BUILDER_POINT` row).
- **Refusals:** a read or a builder that declines returns `{ refused: "<plain
  words>" }` (`PackRefusal`, `isPackRefusal`); the host returns it as the tool's
  error result, never as data.
- **Reserved input keys:** the host fills `project_id`, `model_id` and
  `base_revision` (`HOST_RESERVED_TOOL_INPUT_KEYS`) for every model tool. A
  model tool doesn't declare them; conformance refuses any tool declaring
  `model_id` or `base_revision`. A tool that reads no model (a planner from an
  equipment list) may declare its own `project_id`.
- **Names:** `<pack>_<verb>`. A first-party pack (`keepsBareIds`) may also
  declare its frozen `bim_` names (`FIRST_PARTY_TOOL_PREFIX`); no other pack may.

`kernel.network_adapter`, `kernel.derived_zone_rule` and `kernel.symbol` keep
their v1 shapes; their trade rows moved from built-ins to the first-party packs.

## Elements, parts and systems a pack works with (1.2.0)

- **Parameter sets apply to parts too:** a pack key in a part's `values`, written with
  `set_element_values`, stored only for peers advertising `parts:pack_values`
  (`PARTS_PACK_VALUES_FEATURE`).
- **Part type parameters** may carry any bim-units unit code on a number parameter
  (`parts:unit_codes`, `PARTS_UNIT_CODES_FEATURE`).
- **`SystemKind` is open:** a pack's system kind (`civil.storm`) reads its service row's look,
  routing rules and discipline.
- **A pack's service row stores its class discipline in the partition**
  (`partition:class_disciplines`, `PARTITION_DISCIPLINES_FEATURE`; `KnownDiscipline` is the six
  drawn disciplines, any other reads as stored).
- **Gravity networks from runs:** `gravityNetworkOf(elements, opts)` builds the gravity regime's
  input from run segments; a segment whose values carry `flow.pumped: true`
  (`PUMPED_SEGMENT_KEY`) is pumped (`@permitzip/bim-kernel/connections`).
- **A part may stand on a line-placed element at a station** (a unit on a beam;
  `parts:line_host`, `PARTS_LINE_HOST_FEATURE`).
- **Element types:** `element_type` + `create_element_type` share types for the building kinds
  (`elements:types`, `ELEMENT_TYPES_FEATURE`); `elementTypeValue` reads an element's own value
  over its type's (`@permitzip/bim-kernel/elements`). The built-in class `gen.element_type`
  lists them; a recognition condition `param.<key>` reads the same way (instance over type) for
  every kind.
- **Pipe materials:** a pack pipe material's label prints in size labels.
- **Indexes a pack keeps per element record:** register `registerRevisionCarry(name, carry)`
  (`@permitzip/bim-kernel`); the kernel calls every carry for each new revision with the changed
  ids, and a carry that throws is logged and its index rebuilds on first read. The name is
  global to the process (one index, every model), so the index itself must be keyed by element
  record, never by model.

## Testing a pack

`@permitzip/bim-pack` re-exports a harness that runs a pack's rows through the
real engines inside its set's scope: `runPackLint(model, set, opts)` (the lint
engine with every rule of the set), `runPackCalc(set, request)` (the calc
registry and code families), `runPackNetwork(model, set, serviceId)` (the
kernel's walk) and `packFieldRegistry(set)` (the fields the Inspector reads),
plus `runPackConformance`. It also re-exports the network core
(`networkTotals`, `IncrementalTotals`, `sumMonoid`, `NetworkAdapter`,
`adapterForService`, `networkForService`, `serviceNetworkTotals`,
`solveNetwork`) and every helper on `@permitzip/bim-kernel/placement` and
`@permitzip/bim-kernel/elements`.

## Where packs are in force

A `PackSet` is an immutable value built once when a model opens and bound to
that model (`bindModelPacks`). Kernel readers use `activePackSet()`: the set of
the innermost `withPackSet` / `withModelPacks` scope, else the built-in rows
only, which is exactly the behaviour before packs. The scope is synchronous
and refuses a callback that returns a promise. One process serves many firms'
models; a pack bound to one model never reaches another.

Tables derived from a set (the adapter table, the service registry) are built
once per set (`PackSet.memo`), so a lookup stays one map read.

## Per-model pins

A model stores the packs it uses as `ModelSettings.packs: { id, version }[]`,
written only to peers advertising `packs:pins` (`PACKS_PINS_FEATURE`). On open
the host calls `resolvePackPins(available, pins)`; a pin whose pack or exact
version it lacks is reported and shown ("This model uses Zoning 1.2.0, which
isn't installed"), never silently dropped. A pin for a first-party add-on is
satisfied by the base whatever version it names (1.12.0; the same rule as
`pinnedPacks` in `organization/setup.ts`): first-party add-ons are always
installed. Settings › MutinyBIM library › Add-ons
lists the first-party packs and any other.

## First-party packs

Electrical, Plumbing and gas, and Mechanical are `firstParty` packs (1.3.0).
Their rows are the packs' **contributions**, not points' built-in rows. Their
ids stay bare (stored in models since before packs, never renamed): a
`firstParty` pack whose id is in `FIRST_PARTY_PACK_IDS` may contribute bare ids
to namespaced points (`keepsBareIds`); any other pack, even one that calls
itself first-party, namespaces `<pack>.<name>`.

They are **always installed**: `installFirstPartyPacks(packs)` (or, in a host,
`installFirstPartyAddOns()` from `@permitzip/bim-first-party`) makes them the
base of `activePackSet()` outside any scope and under every model's set.
Their rows join each point after its built-in rows, in first-party order
(electrical, plumbing and gas, mechanical), which is the order the built-in
rows had before. Installing the same packs again changes nothing; a pack that
isn't first-party, or a second, different pack for an installed id, is refused
loudly. A model's pins never list them. Content whose owner isn't loaded is
refused by name: "This model uses Electrical, which isn't loaded here"
(`packNotLoadedMessage`).

The kernel entry installs its own transitional first-party packs
provisionally, so a script or kernel test reads the trades as before; a host's
install replaces them (it adds the rows that live in `@permitzip/bim-calc` and
`@permitzip/bim-library`: NEC demand rule sets, the outdoor-air engine,
pressure targets). Round 6 wave 2 moves each trade into
`@permitzip/bim-pack-{electrical,plumbing,mechanical}`, and the kernel's
trade-term count (`packages/bim-kernel/src/__tests__/trade-terms.test.ts`) goes
down.

## Change kinds (1.6.0)

`kernel.change_significance` v1 (`CHANGE_SIGNIFICANCE_POINT`): what kind of
change a version range or a merged branch was. Built-ins: `unclassified`
(the default), `no_change_order`, `no_cost`, `required_coordination_not_done`
(needs a citation), `owner_requested`, `error_or_omission`, `field_condition`.
A firm or add-on adds its own:

- `id` in the pack's namespace (`acme.value_engineering`), lower-case words
  joined by `_`;
- `label` and `description` in operator words;
- `needsCitation`: classifying needs the requirement or specification section;
- `mayLeadToChangeOrder`: informational only. Nothing creates a change order
  by itself; a change order is a person's deliberate record in the host.

Stored kinds stay open strings: a kind this release doesn't know reads as
"Classified as <id> (an add-on this model doesn't have)", never as
unclassified. Conformance: `changeKindProblems(def)` is empty. No item carries
money.

## Identity providers (1.6.0)

`kernel.identity_provider` v1 (`IDENTITY_PROVIDER_POINT`): who an author is
and how their signatures are checked, for any firm's login system (OIDC,
SAML, a certificate authority, a board's credential wallet). The kernel names
no provider; the built-in `unsigned` provider verifies nothing.

- `id` (lower case, `.` `:` `-` between parts, at most 64), `label`, semver
  `version`, at least one signature `algorithms` entry;
- `resolveAuthor(subject)` and `verify(envelope, payload)`.

Authors are `AuthorRef`s (`provider`, `subject`, `kind`); an agent author
always names the person it acts for, and only people sign: an envelope whose
signer is an agent is invalid whatever a provider says. Conformance: the
pack's providers register in an `IdentityProviderRegistry` (well-formed, no
duplicate id).

## Answer outcomes (1.6.0)

`kernel.question_outcome` v1 (`QUESTION_OUTCOME_POINT`): what an answer to a
question did. Built-ins: `clarification`, `not_in_scope`,
`judgment_recorded`, `design_revision`, `branch_opened`. An add-on or a
workflow adds its own (`<ns>.<name>`, a label, an optional description, the
question status it leads to — `answered` or `not_in_scope` — and the link
kinds it may carry). Conformance: `questionOutcomeProblems(def)` is empty.
Reserved in 1.5.0; listed for conformance in 1.6.0 (round 9 writes answers).

## Element kinds (1.7.0)

`kernel.element_kind` v1 (`ELEMENT_KIND_POINT`): an element kind an add-on
owns, its values and its own checks. The kernel keeps only its generic kinds
(`KERNEL_ELEMENT_KINDS`); Mechanical owns `terminal`, `duct_segment`,
`equipment`, `tap` and `elbow` this way.

- `kind`: the stored kind; never one of the kernel's;
- `label` in operator words;
- `values`: what its records keep, headline first. Each value has a parameter
  `key` (`<pack>.<name>`), the flat field older records `stored` it as
  (frozen: old changesets and intents name it), optional read-only `aliases`,
  `label`, `unit`, `authored` (a person sets it) or kept by the tree, optional
  `min` / `max`, and `appliesTo(el)` when only some records keep it;
- `check(el, settings, issues)`: the kind's own checks on one record;
- `newForOlderPeers`: no older peer stores this kind at all, so creating one
  needs `kinds:addon_owned`.

Readers lift the stored flat field into the parameter form
(`registerKindLiftSteps`, `readKindValue`); a writer upgrades a record only
when every peer reads `kinds:addon_owned`, and an older peer is sent the
stored form. Old models open and total as before. A pack command may declare
`PackCommandDef.runs(model, steps)`: consecutive steps of its type in one
`batch_edits` run as one edit, with the same outcome as running them one by
one. Conformance: `elementKindRowProblems(items, kernelKinds)` is empty (no
collision with a kernel kind, well-formed value keys).

## Connector end types (1.7.0)

`kernel.connector_end_type` v1 (`CONNECTOR_END_TYPE_POINT`): the kind of end
a part, a fitting or a run carries where it meets the next piece, and which
pairs join. The kernel names none; Mechanical declares slip, flanged and
formed flange, Plumbing and gas the pipe joints.

- `id` (`<pack>.<name>`, what a connector's `endType` stores) and `label`;
- `domains`: connector domains it is made for (absent: any);
- `stored`: the fitting parameter and values older records used, read only;
- `joins` (direct, symmetric), `joinsVia` (only with a named fitting
  between), `joinsItself` (default true).

An end type no add-on in force declares is kept as stored and judged by
nothing. A connector's `endType` is written only to peers that read
`parts:connector_end_types`. The integrity checks (touching but not joined,
shape or size mismatch, end types that don't join, supply joined to return)
are ordinary findings and never refuse an edit. Shapes:
`ConnectorIntegrityIssue`, `PartImportReport`, `EndTypeJoin`,
`connectorEndTypeTable`. Conformance: `connectorEndTypeRowProblems(items)` is
empty.

## IFC import rules (1.7.0)

`kernel.ifc_import_rule` v1 (`IFC_IMPORT_RULE_POINT`): how a class's
instances come in from a linked IFC model. The importer never decides what a
product becomes: it finds the class whose IFC home the product matches and
asks that class's rule. A class names its rule in `ifc.import.rule` (with
`options`); without one it takes the rule registered for the kind it
recognises.

- `id` (`kernel.<name>` or `<pack>.<name>`), `label`;
- `forKinds`: element kinds whose classes take this rule unless they name
  another;
- `order`: lower runs first (hosts before what they host; default 10);
- `convert(product, ctx)`: the records the product becomes, or why it stays
  on the linked model. `ctx` (`ImportRuleContext`) gives the class, its
  recognition fields and options, stable ids, levels and partitions,
  already-converted hosts, shared records, mapped property-set values, the
  provenance every record carries (`ifcGlobalId`, `source`) and report notes.

What doesn't convert stays showing from the linked model and is listed in
the report. Imports land on a new branch through the server-only
`import_elements` command; a client never sends it. Conformance:
`importRuleRowProblems(items)` is empty.

## Element kind faces (1.8.0)

`kernel.element_kind` stays v1; a row may now carry optional faces, so one
declaration says everything about a kind, drawn or not:

- `nature`: `physical` (absent means this), `intent`, `record`, `document` or
  `<pack>.<name>`. A record kind with no shape, no ends and no anchor is valid
  (site constraints, program areas, later questions and submittals).
- `shape` (`ElementKindShapeFace`): the stored fields and their form, the
  points it is drawn from, and `accepts(el)`; a writer stores only the
  declared shape (strict), a reader keeps whatever it finds (tolerant).
- `connectorEnds` (`ConnectorEndsFace`): its ends with a role (upstream,
  downstream, hosted) and the end types from `kernel.connector_end_type` each
  takes, `root`, `hostedBy { field }` and `point(el, end)`. The network index,
  topology and connector positions read these; the kernel names no kind.
- `anchor(el)`: where it sits, for kinds `anchorOf` can't place.
- `upgrade` (`KindUpgradeFace`): `newForOlderPeers` and the protocol
  `feature` a new record waits for (`kinds:addon_shapes` for a shaped kind,
  `kinds:addon_owned` otherwise).

Mechanical declares its five kinds this way. Conformance:
`elementKindRowProblems(items, kernelKinds, endTypeIds)` is empty (a known or
namespaced nature, ends only on a physical kind, at most one upstream end, a
root has none, every end type named is registered).

## Pipe products (1.8.0)

`kernel.pipe_product` v1 (`PIPE_PRODUCT_POINT`): a pipe product an add-on
makes. The kernel holds no catalogue; Plumbing and gas ships its fifteen.

- `id` (`<pack>.<name>`), `label`, the `material` (from the add-on's pipe
  materials) and the stored spec name with its short words, `defaultFor` its
  material, `standard`, `services`;
- `sizes`: nominal size with outside and inside diameter and wall, ascending;
  roughness, Hazen-Williams C, Manning n, pressure class;
- `endTypes` it is joined with (ids from `kernel.connector_end_type`), its
  `defaultEndType`, and each joint's `hub` (outside diameter and depth).

`pipeProductTable(set)` reads them; `liftPipeJoints` lifts a stored `joint`
name to its end type on open without rewriting anything. A fitting made with
an add-on product's joint keeps it by `end_type`, written only to peers that
read `pipes:addon_products` and lowered to its stored name for older peers.
A product the set doesn't know is kept as stored and its size check names the
add-on that supplies it. Conformance: `pipeProductRowProblems(items,
endTypeIds)` is empty (namespaced id, one product per material and spec, one
default per material, ascending sizes with inside below outside, the default
joint is one it is made with, every end type and hub declared).

## Agent tool packs (1.8.0)

`kernel.agent_tool_pack` v1 (`AGENT_TOOL_PACK_POINT`): a group of agent tools
served as one MCP connection with a same-named skill.

- `id` (`<pack>.<name>`), `label`, `purpose` in plain words, `skill`, `slug`
  (its endpoint, `/api/bim/packs/<slug>/mcp` on the host), `tokenCap` (tool text
  it may advertise) and `readOnly`.
- `kernel.agent_tool` rows gain `pack`: one of the catalogue's
  (`bimPackCatalogue()` in `@permitzip/bim-plugin`, the one place first-party
  pack membership lives) or one the add-on declares. An add-on's untagged
  tools form the pack `addon.<packId>`.

Conformance: every tool in exactly one pack, unique ids, slugs and skills, a
read-only pack holds only reads, a named pack exists, a cap is a number
(`agentToolPackRowProblems`, `agentToolPackSetProblems`).

## What a sign-off was checked against (1.8.0)

A code pack versions its rules with `ruleVersion` (and `correctedAt`) and may
declare a rule `carriedForward` from an earlier edition (`{ fromEdition,
fromSection? }`); MutinyBIM never infers either. A citation may carry
`jurisdictionId` (`JurisdictionId { country, subdivision?, locality?,
authority? }`, ISO 3166 codes; `parseJurisdiction` reads a stored US state as
`{ country: "US", subdivision: "US-VA" }`), `adoptedAs` and `amendment`.

Sign-offs pin a `CheckingContext` inside their hashed payload: lineage
(`"main"`), jurisdiction, the project's code of record per discipline, the
packs in force, every relied rule (`RuleVersionRef`: id, version, instrument,
edition, section, adoption, amendment) and the determinations' digest. When
a rule's version or the project's code of record changes, a record reads
"checked against an older rule"; a state adoption alone changes nothing.
The signer's override is a `FindingDisposition { findingId, sourceVersion,
action: "override", reason, by, at, scope: { lineageId } }`, a signed event
in the same chain. Old records read "checking context not recorded" and
still verify. Protocol features: `signoffs:checking_context`,
`signoffs:dispositions`.

## Key-history checkpoints (1.8.0)

A host may publish signed checkpoints of each person's key-history head
(`pzkeyckpt/v1`, Ed25519, `KeyLogCheckpoint`) with its public keys and their
validity windows (`CheckpointKey`); anyone checks one with
`verifyKeyLogCheckpoint` and a later history against it with
`historyExtendsCheckpoint`. Rotating the key never invalidates an old
checkpoint.

## Questions forwarded to a person (1.8.0)

A forward may name one person (`AuthorRef`) as the new addressee, written
only to peers that read `questions:forward_person` (forward by name still
works everywhere). `questionForwards` reads the forward history and
`answersMadeStaleByEdit` the answers one edit made stale, from the edit's
changed ids only. The kept validation state (`ValidationState`) is exported
for hosts that store it.

## One record registry (1.9.0)

Every stored kind, kernel or add-on, drawn or not, is one row on `kernel.element_kind`
(`KERNEL_KIND_ROWS`, `kindRowOf`). Rows gain a `read` face (a tolerant reader's verdict,
`KindRecordRead`) and `hostedBy.placement` (`HostedPlacementFace`: where a hosted kind sits on its
host, so it is placed and spacing-checked like any other). `submittal`, `divergence`,
`question_answer`, `question_reply`, `finding_disposition`, `gate` and `stage_plan` are kernel
record rows; an add-on may not register them. A pack command may **claim** a kernel command's case
for kinds it owns (`PackCommandDef.claims: { command, kinds }`, `claimedCommandCase`); without the
add-on the case is refused naming it.

## Copies with a purpose (1.9.0)

`kernel.lineage_role` v1 (`LINEAGE_ROLE_POINT`): role id, label, default return policy (`merge`,
`review_only`, `accept_back`, `never`), read restriction and default capabilities for the parent's
responsible professionals. There is no depth or parent-role limit: any copy can be a parent.
Shapes: `Lineage`, `LineageAct` (merge, review, accept back; to the parent or any ancestor),
`LineageDifference` (`compareLineages`, the overlay read), `LineageCapability`,
`LineageCheckpoint`, `LineageBundle` (format v1, reader only). Conformance: `lineageRoleProblems`.

## The problem list (1.9.0)

`kernel.finding_source` v1 (`FINDING_SOURCE_POINT`): a pack adds its own check to the one list.
Every producer emits `FindingRef` (id = source kind + local id, stable across edits). Decisions are
`finding_disposition` model records (accepted as known, waived, deferred to a stage, override,
retracted), people only, re-opened when the source's version changes; they ride signed sign-off
payloads. `AgentOrientation` is the bounded envelope a tool result may carry. Conformance:
`findingSourceRowProblems`.

## Stages, frozen gates and confidence (1.9.0)

`kernel.lifecycle_stage` v1 (stage rows; ours are defaults), `kernel.stage_set` v1 (a firm's own
list: copy, reorder, replace), `kernel.value_basis` v1 (the confidence ladder; the five older
ladders are read onto it, nothing stored changes) and `graph.anchor_kind` v1 (record kinds that are
requirement anchors: site, parcel, gate, copy). Requirements may carry `appliesAt` (stages,
anchors). A `gate` freezes a stage: state digest, issued sets, sign-offs, dispositions, quantity
totals by basis. **No model command accepts money**: gates hold quantities; money is a reader-side
view over a party's own price book (`GateMoney`, `AgreedAmountRef` are read shapes).

## Outside add-ons, packages and contributor points (1.9.0)

Pins carry `digest` (`sha256:` of the package) and `tier` (`data` | `code`), read tolerantly;
a model opened without a pinned add-on keeps its records and says "This model needs add-on X
1.2.0". Outside add-ons arrive as **packages** (`mutinybim.json` format v1 in
`@permitzip/bim-library`: name, version, licence, authors, `rightsDeclaration`, `requires`,
hashed contents; signed with the 8b envelope over the manifest's canonical bytes;
`verifyPackage` runs offline). A host installs **data** add-ons only after the checks pass and a
person approves that exact version; **code** add-ons are refused by one host setting
(`HostTrustPolicy`). A standalone operator who trusts a code add-on installs it as ordinary
software in the server process; a capability-limited isolate comes after release. New points:
`kernel.clearance_purpose` (the six built-in purposes are rows), part-type `positions`
(open / closed / travel envelopes), `kernel.import_source` and `kernel.export_target` (IFC is the
first reader and writer), `units.unit_kind` (add-on quantity kinds), and a reserved viewer
render-style point.

## Trades out of the core: catalog types, diagrams, plan graphics (1.10.0)

- `kernel.catalog_entry` v1: a catalog record type (`type`, frozen `idPrefix`, label, strict
  `schema`, `nameOf`, `summary`, field `sections`). The kernel keeps the reader and the
  trade-neutral connection type; feeder types, circuit templates, pipe types and plumbing
  settings become their add-ons' rows with ids byte-identical (`etype:<prefix>:<NAME>`).
- `kernel.diagram_layout` v1: a stored diagram kind's `check` and `layout` into the kernel's
  generic diagram items (`OneLineItem`). Stored specs are never rewritten; without the add-on
  the view keeps its bytes and names it.
- `kernel.view_graphics` v1: plan graphics an add-on derives for a view (`draw` into the view's
  primitives), its switches stored opaquely under `ViewProps[hintsKey]`, drawn in `order`.
- Network adapter faces: `sourcesFor(model, end)` (an unserved end, the sources that could
  take it nearest first, each refusal with its reason; `sourcesFor` in the kernel asks each
  adapter) and `translate(ctx, id, delta)` (moving one of the network's elements and what
  follows it; `translateThroughNetworks`). An adapter row may carry only these faces.
- Element kind faces: `symbol`, `tagText`, `pickShape`, read by drawing, tags, selection and
  view mapping instead of kind cases.

## Rated assemblies, route rules and fitting families (1.10.0)

Rating kinds and route rules are on the kernel subpath `@permitzip/bim-kernel/rated-routes`
(and the `@permitzip/bim-pack` root), off the Building Model's first download.

- `kernel.rating_kind` v1: an assembly rating kind (label, unit, `levels`, `parameterKeys`,
  `read`); `ratingOf(elements, el, kind)`. The kernel names no rating kind.
- `kernel.route_constraint` v1: a **crossing** rule (a route crossing an element rated at least
  V of kind K needs `requires` there) or a **clearance** rule (a route's bottom stays
  `clearanceMm` below a ceiling surface). Read over the touched span only.
- `kernel.fitting_family` v1: a fitting family and the slots it fills by default per scope.
  Family ids are stored on fittings and kept byte for byte. A stored id whose first-party add-on
  is off is kept and named in the check ("This model uses Plumbing and gas, which isn't loaded
  here…"), never called a type the library doesn't have.

## Calculation sheets, design limits, mirrored typicals, picture intake (1.10.0)

On kernel subpaths (`@permitzip/bim-kernel/calc-sheets`, `/policy`, `/intake`, `/typicals` for
the typical-to graphics and assembly stubs) and the `@permitzip/bim-pack` root, so they stay off
the Building Model's first download.

The first-party add-ons follow the same rule: `@permitzip/bim-pack-<trade>/host` carries only
what the Building Model needs when it opens (the pack, its UI rows and the helpers its
always-loaded screens call); demo and test models are on `@permitzip/bim-first-party/seed` and
`@permitzip/bim-pack-mechanical/seed`. Everything else stays on each package root.

- `kernel.calc_sheet` v1: a template builds a `CalcSheetSpec` (inputs bound to the model,
  lookups into a firm or project table by slot with the governing cell marked, steps through
  `bim-formula`, checks against design limits, citations in our own words, a result).
  `calcSheetSpecProblems` checks every key is defined before it is read.
- `kernel.design_limit_default` v1: an add-on's best-practice starting limits per discipline and
  per system, each with its source. The firm's library and the project edit them by id;
  `designLimitsFor(selector, stage, { project, firm })` returns the binding limits most specific
  first, each from the highest layer holding its id. A limit naming a field the selector doesn't
  know doesn't apply. `designLimitSchema` is the strict writer.
- Typical copies may carry `mirror: { axis }` (absent: not mirrored; written only when every
  peer advertises `typicals:mirror`). `AssemblyStub`: one stub per service a group needs, with its
  rolled-up need and instance count.
- `kernel.intake_column` v1: a column an add-on reads from a picture or cut sheet (headings,
  field, unit, `parse`). `TableReadResult`, the host `TableReader`, and `IntakeProposal` (cells to
  planned rows, unknown columns kept as text, unsure cells unticked).

## The building, rooms from walls, faces and outfalls (1.11.0)

Round 13 wave 0. Every point is trade-neutral: the kernel names no building kind or discipline.

- `kernel.datum` v1: a stored kind that tools snap to (level, grid axis, reference plane, site
  line): `labelOf`, `snapLines(el, elements, levelId)`, optional `elevationMm`.
  `datumSnapLines(model, levelId)` is what placement and route tools ask.
- `kernel.line_join` v1: how a line-placed kind's ends meet (`styles` butt / miter, `priority`,
  `cleanupLayer`, `joinsWith`). Derived, never stored; `DISALLOW_JOIN_KEYS` per end.
  `endCleanupsOf` (lane A13a). Optional `withLine(el, { start, end }, elements)` (round 16,
  additive, no version bump: a row without it behaves as before): the record with its line moved,
  every stored copy of the line agreeing. With it, the row's ends joined to a moved element follow
  the move (`move_elements` / `move_wall`; `disjoin: true` leaves them): a corner goes where the
  moved end went, an end on a moved line's face stays on that face along its own line.
- `kernel.host_void` v1: a hosted kind's void in its host (`hostKinds`, `voidOf` → profile in host
  coordinates, depth, `fill` / `open`). `voidsOf(model, hostId)` (lane A13a).
- `kernel.bounding_element` v1: a kind's boundary segments on a level and whether it bounds rooms
  (`boundsByDefault`, `typeParameterKey`, instance `room_bounding`). `boundsRooms(el, elements)`;
  `boundarySegmentsOnLevel` (lane A13b).
- `kernel.ifc_relation` v1: relationships beyond containment a row writes for its kinds
  (`IfcRelVoidsElement`, `IfcRelFillsElement`, `IfcRelSpaceBoundary`, …) with the synthetic
  objects they need. `ifcRelationRowsFor(kind)`.
- `kernel.connector_face` v1: the faces of any connector-bearing shape (`id`, centre, normal,
  along / across extents); `TapPlacement { hostId, face, s, t }`; `pointOnFace`; old side taps
  read as `side_left` / `side_right`. Protocol feature `routing:tap_faces` (declared; advertised
  when lane M13's reader lands).
- `kernel.connection_field` v1: an add-on's fields on the trade-neutral connection type, with a
  default equal to the stored bytes before the move. `connectionFieldValue(record, key)`.
- `kernel.gravity_outfall` v1: a node a gravity walk ends at (invert, rim, backwater).
  `outfallOf`, `walkToOutfall` (lane P13).
- Element kind rows' `planGraphics` face: model-space lines, polylines, arcs, texts and tag places
  (`PlanGraphic`), or null to fall back to today's drawing.
- Spaces: `bounds.kind = "bounded"` (seed, derived outline and boundary, stored so bare readers
  show the area; `spaces:bounded`); `space_separator` records (`spaces:separators`); `parentId` on
  spaces and zones, read through `parentOf`, `childrenOf`, `ancestorsOf`, `nestingRefusal` and
  `nestedRows(display)` with display `nested` / `children_only` / `parents_only` (`spaces:nested`).
  One shared room record: the space is the room. `spaceBoundaryFacts` and the
  `qto.boundary.*` quantity keys (lane A13b).
- `diagrams/selection`: `modelIdsOf`, `diagramEntriesOf` (lane M13).
- Library item types `lookup_table` (`lookupTableSchema`, `lookupTable(slot, stage, sources)` on
  `/policy`) and `element_type`.
- Protocol features declared for later lanes: `elements:create` (A13a), `pipes:open_specs` (P13).
- Route clearance rules may name a design limit (`ClearanceRule.limit { id, selector }`): the
  binding limit (project over firm over the add-on's default, most specific first; per-system
  variants `<id>.<system>`) sets the distance, and hits carry `basis` (limit id, layer, source).
  `checkRouteSpan(model, span, { stage, limits })`.
- Each first-party add-on has a `/ui` entry: its plain-data screen list (`ADDON_UI`) with no code,
  so a host can register screens without loading the add-on.
- The kernel's schedule engine is on `@permitzip/bim-kernel/schedules` (off the root).

## Add-on library rows, rated segments, tap offsets, parts on runs (1.12.0)

Round 14 wave 0. Every point is trade-neutral.

- `kernel.library_rows` v1: an add-on contributes built-in library items as JSON rows
  (`{ section, item }`, `section` one of `LIBRARY_ROW_SECTIONS`: classes, fields, formulas,
  relationships, scheduleTemplates, tagTypes, lookupTables, elementTypes, designLimits). Item ids
  keep their stored library shape (`aec:field:…`), so moving a row out of the built-in bundle
  changes no id. `libraryRowsOf()` returns the rows keyed by the add-on (installed first-party
  first, then the set's packs); the library loads them after its own built-in rows and drops them
  when the add-on is off (lane K14). `PackSet.rowsByPack(point)` is the generic reader.
- **Library joining rule.** `builtinLibraryBundle()` (`@permitzip/bim-library`) joins every
  add-on's rows after the kernel's own built-in rows, add-on by add-on in `libraryRowsOf()` order. A
  row that doesn't parse as its section's item is left out and logged, never thrown, so one bad
  row can't take the library down. An add-on's row may not redefine a field path another provider
  already owns (the library refuses a duplicate field in words).
- `layoutRowFor(kind)`: the diagram layout row for a kind, or a refusal naming the add-on that
  draws it when that add-on is off ("This model uses …, which isn't loaded here"), or "No add-on in
  this model lays out <kind> diagrams". `DiagramLayoutRow` gains two optional fields (additive):
  `layoutGraph?(input: DiagramGraphLayoutInput): DiagramGraphLayoutResult | PackRefusal`, which
  lays a live diagram view's graph out (`{ elements, graph, roots, hints }` →
  `DiagramLayoutResult & { pieces?: Record<nodeId, DiagramPieceRef> }`; `evaluateDiagram` asks it
  before its own layouts), and `serviceSections?: boolean` (the row draws one section per service).
- `ratedSegmentsNear(model, levelId, box, ratingKind)`: built. The boundary index keeps one lens
  per rating kind beside the room-bounding lens: every element of a bounding kind with a rating of
  that kind, room-bounding or not, on the same 5 m grid, carried by changed ids. Refuses only a
  rating kind no add-on in force gives ("No add-on in force gives the rating kind <kind>").
- Route checks on `@permitzip/bim-kernel/rated-routes` (off the root). `CrossingRule.place?(model,
  hit, span)` answers `CrossingPlacement { typeId, values? }` or a refusal, so an add-on says how
  its crossing is met (a damper at a rated wall, a firestop sleeve) and the kernel builds the
  `place_part`. `RouteConstraintHit.levelId?` names the span's level. Route-leg helpers:
  `routeLegOf(model, segmentId)` (`RouteLeg`: the piece's span; a vertical piece has none),
  `checkRouteLegs(model, segmentIds, options)` (`RouteLegCheck[]`, one leg at a time, the indexes
  near it, never a model scan), `routeCheckLines(legs)` (`{ key, message, at, segmentId }`: a line
  for the Route panel and where its tick goes), `routeFinishPlan(model, segmentIds, idPrefix,
  options)` (`RouteFinishPlan { commands: CrossingPlaceCommand[], placed, left }`; a retried
  Finish places the same ids), `routeFinishWords(model, plan)`. Options carry `{ stage, limits }`
  (the firm's and the project's design limits).
- Parts cut into the run on Finish (`/rated-routes`, additive): `RouteFinishOptions.inline?(model,
  command)` answers the model after a command or a refusal (the host's own decide; a host passes it
  only when the server advertises `routing:insert_part`). With it, `routeFinishPlan` cuts each
  crossing's part into the run with `insertPartOnRun`, a leg's crossings far end first, each worked
  out on the model after the cuts before it; a type with no pair of connectors a run passes straight
  through (or a piece too short there, a branch at the cut) stays on the run's centre line as a
  `place_part`, with the reason. Without it the plan is unchanged (`place_part` per crossing).
  `RouteFinishPlan` gains `cut` and `onCentreLine` (`{ hit, why }`); its `commands` are
  `CrossingFinishCommand[]` (`place_part` | `batch_edits`). `routeFinishBatch(route, plan, label?)`
  makes the route and every crossing's steps one `batch_edits` (one revision, one undo step), or null
  when there is nothing to add or the batch would pass the edit batch limit.
- `SpaceLocator.partsIn?(spaceId)`: the parts in a space (indexed; `modelSpaceParts` /
  `withModelSpaceParts` build it once and carry it by changed ids). A reader that needs the parts of
  one space uses it when present and walks parts only for a locator without it.
- `insertPartOnRun(model, { runId, atMm, partDefinitionId, partType?, idPrefix?, flip?, mark? })`:
  built (lane P14): one `batch_edits` (one undo step) made only of existing commands —
  `split_run` where the part's far connector goes, `disconnect_run`, `place_part` (turned to the
  run in plan; a vertical pair on a vertical run), `drag_run` pulling the near piece to the near
  connector, `connect_runs` twice — so it stores no new shape. Optional fields: `partType` (the
  definition to pin when the model lacks the type), `idPrefix` (retry-safe ids `<prefix>-part`,
  `<prefix>-cut-s1`), `flip`, `mark`. Refuses in words: no such run or not a straight piece, no
  such part type, a part with no pair of connectors a run passes straight through, a size it
  doesn't take, a spot off the run or too short ("Move it at least N ft from each end"), a branch
  where the part goes, a level part on a vertical run (and back), a run sloped past about 2°.
- Taps off a face's centre line: `HostedOn.t?` (mm across the face from its centre line; absent =
  on the centre line, the bytes every tap had before). `hostedPoints(host, s, side, dir?, face?,
  t = 0)` places it (+t is left of travel on the top face, right on the bottom; a side tap's t
  moves it down its side). `route_run`'s `run_branch` endpoint takes `t` (−2000…2000 mm, with
  `face`), stores it only when non-zero, refuses |t| over half the run's width and refuses a
  non-zero t on a server that doesn't advertise `routing:tap_offset`. `elbow_to_tee` takes `face`
  (`top` / `bottom`): a level leg and a leg that rises or drops from it become a top or bottom tap,
  refused on a server without `routing:tap_faces`.
- `FittingFamilyRow.faceWords?(face)` (additive): the words a family adds to a fitting's name on a
  face ("rise from the top"); the kernel reads it through `branchLabelOnFace(familyId, label,
  face)` only when it names a new branch fitting or a refit renames one (a stored label is never
  re-suffixed).
- `firstPartyServiceRegistry()`: the kernel's own service row with every installed first-party
  add-on's rows — the services every model has before its own add-ons (`activeServiceRegistry()`
  outside a model's scope). The service stand-in is gone: `BUILTIN_SERVICES` /
  `BUILTIN_SERVICE_REGISTRY` hold only the kernel's **Other** row (stored id `other`, discipline
  `general`); Electrical's, Plumbing's, Mechanical's and Fire protection's rows are their
  contributions on `kernel.service`, in round 13's order (`ViewOrder.rows`). A screen listing
  services reads `firstPartyServiceRegistry()` or the registry in force, never the built-in one.
  Removed with the stand-in (round 13 tables no reader outside the kernel used): `SYSTEM_RULES`,
  `SYSTEM_KIND_LOOK` (read `systemRules(kind)` / `systemKindLook(kind)`),
  `FALLBACK_LOAD_SECTION_ROWS`, `LOAD_SECTIONS`, `LOAD_SECTION_LABELS`, `SECTION_QUANTITIES`,
  `SECTION_TRADE` (read the load section rows on `kernel.load_section`).
- Stored diagram kinds are open (`kernel.diagram_layout`): a view's `diagram.kind` is a kind id
  (`DIAGRAM_KIND_ID`: a bare first-party name, or `<pack>.<name>` for an outside add-on), not the four
  round 5 kinds. `StoredDiagramKind` is that string; `DIAGRAM_KINDS` / `DiagramKind` stay the four
  every peer reads (`isRound5DiagramKind`). Strict writer: a round 5 kind is always stored; any other
  kind only when a `DIAGRAM_LAYOUT_POINT` row in force draws it and the server advertises
  `diagrams:open_kinds` (`diagramKindStoreRefusal(kind)` gives the words). Tolerant reader: a stored
  kind no add-on in force draws is kept and shown by name (`diagramKindLabel(kind)`: the row's label,
  else the built-in label, else the kind).
- Element kind rows (`kernel.element_kind`, additive): `ElementKindItem.scheduleFamily?` (what a
  schedule's Family column says for its listed records; absent: its `label`), `scheduleCategory?`
  (the element schedule category that lists its records; needs `scheduleListing`), `classId?` (the
  built-in class its records are, joined to that class's recognition for installed first-party
  add-ons; an outside add-on's `classId` is not joined yet). Conformance names an empty
  `scheduleFamily`, `scheduleCategory` or `classId`. `KindShapeField.authored?` (a person sets it, so
  an edit's intent on it is checked and competing writes conflict) and
  `DependencySignature.sources?` (edits to the records that start a tree invalidate the value).
- Run insulation (rename, stored bytes unchanged): the kernel's insulation and sizing-criteria
  shapes are `RunInsulation`, `RunInsulationKind`, `RUN_INSULATION_KINDS`, `runInsulationSchema`,
  `RunSizingCriteria`, `runSizingCriteriaSchema`, `runAirway`, `runOuterSize`,
  `runInsulationCommandSchemas`, `RunInsulationCommand`, `isRunInsulationCommand`. The old `Duct…`
  names (`DuctInsulation`, `ductInsulationSchema`, `DuctSizingCriteria`, `ductSizingCriteriaSchema`,
  `ductAirway`, `ductOuterSize`, `ductDesignCommandSchemas`, `DuctDesignCommand`,
  `isDuctDesignCommand`) stay as deprecated aliases until no importer is left. Stored command types
  do not change.
- Protocol features: `library:addon_rows`, `routing:tap_offset`, `routing:insert_part` and
  `diagrams:open_kinds` are advertised by clients and servers (the library reads add-on rows; the
  kernel stores and reads `HostedOn.t`; `insertPartOnRun` runs existing commands as one batch; a view
  may store an add-on's diagram kind). A host offers a proposal's
  Approve that inserts parts only when the server advertises `routing:insert_part`
  (`WorkflowServices.serverFeatures` in the host app).

## Connect into, the solid program, sheet sets and schedule steps (1.13.0)

Round 15 wave 0. Shapes first; the lanes named build them, and until then each refuses in its
own words. Every name is trade-neutral.

- `kernel.class_solids` (lane A15): an add-on gives elements of its classes a 3D body (the
  `KindSolidShape` forms, plus a see-through `glazing` look), beside `kernel.class_plan_graphics`.
- `connect_into` (kernel command; lane K15 builds it, `routing/connect-into.ts`): `{ from:
  { elementId, port }[] (1–200; a part's connector id, or a run's start / end, as `connect_runs`
  names one), into: <run id> | "nearest", idPrefix }`. `planConnectInto(model, request)` answers
  `ConnectIntoPlan { sources: (ConnectIntoSourcePlan | ConnectIntoSourceRefusal)[], commands }`:
  per source the run it joins, its fittings (`{ partDefinitionId, label }`), the slope its system's
  rule asks for (`{ ratio }` or null), any flex length (`{ lengthMm }` or null) and its commands;
  or a refusal in words for that source. Joinable sources land as one `batch_edits`. Which fitting
  joins which is the system's fitting preferences, never the kernel's. Until built: "Connect into
  isn't built yet" (`CONNECT_INTO_NOT_BUILT`).
- Part model schema 2, the solid program (`part-model/schema-2.ts`; lane G15 builds the engine):
  `partModelSchema2` (`schema: 2`) adds `profiles` (`PartProfile`: a sketch's edges as one outer
  loop and any holes; arcs and circles included), body features `extrude`, `revolve`, `sweep`
  (along a sketch path), `loft` (two or more profiles), `imported` (`ImportedBodyRef { fileId,
  format, contentHash, mmPerUnit, upAxis? }`; formats `gltf`, `glb`, `obj` now, kept open), each
  `join` / `cut` / `intersect`; repeat features `pattern` (linear or circular) and `mirror` (about
  a reference plane); `symbols` per detail level and per view direction (`PART_SYMBOL_VIEWS`:
  plan, below, front, back, left, right). Schema 1 reads byte for byte as before
  (`anyPartModelSchema`, `partModelSchemaVersion`); nothing upgrades a stored part. Parts still
  store schema 1 until G15's engine reads schema 2.
- Sheet sets (`commands/sheet-sets.ts`; lane D15): `create_sheet_set { setId, name, sheetIds,
  purpose? }`, `update_sheet_set { setId, name?, sheetIds?, purpose? }`, `delete_sheet_set
  { setId }`. A set lists sheets in print order, each once; removing a sheet from a set never
  deletes it. Until built: "Sheet sets aren't built yet".
- `edit_schedule { viewId, steps }` (`commands/document-steps.ts`; lane D15): steps `add_column
  { column, at? }`, `move_column { columnId, to }`, `remove_column { columnId }`, `filter
  { filters }`, `sort { sort }`, `group { groups }`, `totals { columnId?, show }` (no column: the
  grand totals). Columns, filters, sorts and groups are the stored `scheduleV2` shapes. One
  command is one undo step. Until built: "Editing a schedule step by step isn't built yet".
- `insert_library_view { viewId, idPrefix, name?, item: { itemId, revision, contentHash, body } }`
  (lane D15): a firm library drafting view or detail copied into the model as a detail view; the
  host pins the item, the kernel never asks a library. Until built: "Inserting a view from the
  library isn't built yet".
- Script manifest `reads` (`@permitzip/bim-library`, additive; lane D15): `fields` (field paths for
  `ctx.model.field(id, path)`), `rows` (schedule view ids for `ctx.model.rows(viewId)`), `calc`
  (calc ids for `ctx.calc(id, inputs)`), `footprint` (`ctx.model.footprint(levelId)`). A manifest
  without them parses as before.
- Library row sections `titleBlocks` and `keynoteTables` (`LIBRARY_ROW_SECTIONS`; library item
  types `title_block` and `keynote_table`; lane SH15 fills them). A title block names the paper
  sizes it fits and carries the sheet engine's layout; a keynote table lists keys and their words.
- Trade tab section words are fixed: Create · Connect · Analyze · Design · Documents, after Select
  (`TRADE_TAB_ORDER`).
- Protocol features, declared and not advertised until each writer and its readers land:
  `geometry:solid_program_2`, `routing:connect_into`, `documents:sheet_sets`,
  `schedules:edit_steps`, `walls:top_constraint`, `parts:class_solids`.

## Versioning rules

- Within a major version of the contract or of a point, changes are
  **additive only**: a new optional field, a new point. An item written for
  `v1` keeps compiling and keeps meaning the same thing.
- A breaking change to a point's item shape bumps **that point's** major. A set
  mixing packs written for two majors of one point is refused, naming both.
- A breaking change to the manifest, the id grammar or the set rules bumps the
  contract major; packs whose `kernel` range excludes it are refused.
- Every breaking change is listed here with the release it ships in.

## Changes

- 1.0.0 (batch 5c): first version.
- 1.1.0 (batch 5c, round 2), additive: `NetworkAdapterItem.adapter` optional and
  `aggregation` added (physical networks, `serviceNetworkTotals`); typed
  `TradeAdapter.solve`; `kernel.parameter_set`; `library.space_use_rate_value`
  and `SpaceUseRateTarget.unit`; calc value units open to bim-units codes;
  explicit `classId` honoured by the class index; pack zone purposes writable
  and `ZonePurposeDef.ifc`; the pack harness. A pack using any of these should
  say `kernel: "^1.1.0"`.
- 1.2.0 (batch 5c, round 3), additive: `NetworkAdapter.across` and
  `<elementId>@<port>` node ids; `IncrementalTotals` with several parents per
  node; `NetworkAggregation.solve`; built-in `struct.footing`; recognition
  through `system.<property>`; `RuleDef.reads`; pinned `parameterRates` on
  spaces (`spaces:parameter_rates`); the reserved bare adapter words
  `fire_protection`, `structural`, `civil` removed (nothing ever registered
  them; stored strings still read). A pack using any of these says
  `kernel: "^1.2.0"`.
  Also in 1.2.0: parameter sets on parts (`parts:pack_values`), any unit code on
  part type parameters (`parts:unit_codes`), open `SystemKind`, class
  disciplines in the partition (`partition:class_disciplines`),
  `gravityNetworkOf` and `flow.pumped`, parts on a line host
  (`parts:line_host`), `element_type` / `create_element_type` /
  `elementTypeValue` and `gen.element_type` (`elements:types`), `param.<key>`
  recognition on every kind, pack pipe material labels, and
  `registerRevisionCarry`.
- 1.3.0 (round 6), additive: the points above; first-party packs keep bare ids
  and are installed as the base of every set (`installFirstPartyPacks`,
  `installedFirstPartyPacks`, `packNotLoadedMessage`, `keepsBareIds`,
  `FIRST_PARTY_PACK_IDS`); `contributionProblems` takes the bare-id flag;
  `PackSet.pack(id)` and `has(id)` see the first-party base (`pins()` does not).
  A pack using any of these says `kernel: "^1.3.0"`.
- 1.4.0 (round 7), additive: the requirements graph
  (internal design note): `kernel.requirements_source` v1
  (a source's descriptor, `RuleRecord`, `Applicability`, `RequirementTemplate`,
  write-back; host snapshots through `bindRequirementsSnapshot`), record kinds
  `determination`, `rule`, `requirement_state` and `observation` (reserved,
  never written), `why` and `dependsOn` with ranked, causal answers (five, then
  "and N more"); typed surfaces: element kind `ceiling` and
  `kernel.surface_role`; quantities and the cost slots: `kernel.measure_rule`
  (`qto.*` derived parameters), `kernel.classification` (codes on types and
  instances; no licensed tables are bundled), `construction_stage` records,
  `kernel.cost_source` v1 (prices stay in the reader's process; the model never
  holds money). Protocol features: `graph:determinations`, `graph:rules`,
  `graph:requirement_states`, `graph:observations` (reserved, never advertised),
  `elements:ceilings`, `qto:classification`, `construction:stages`.
  A pack using any of these says `kernel: "^1.4.0"`.
- 1.5.0 (round 8), additive: disciplines as a registry (`kernel.discipline`,
  child disciplines, firm disciplines), add-on switches and pinned firm
  disciplines in the model's organization records, reserved question, answer,
  submittal and responsibility formats (tolerant readers; nothing writes them).
- 1.6.0 (round 8b), additive: `kernel.change_significance` and
  `kernel.identity_provider`; `kernel.question_outcome` listed for conformance;
  shapes `BranchRef`, `SavedVersion`, `MergeProposal`, `MergePart`,
  `MergeConflict`, `MergeApprovalRecord`, `SignoffRecord`, `ChangeSignificance`,
  `ChangeOrder`, `AuthorRef`, `SignatureEnvelope`, `LicenceClaim`; functions
  `forkState`, `stateAt`, `changedBetween`, `threeWayMerge`, `partDeltaDigest`,
  `planLanding`, `approvalEvaluator`, `verifySignoffChain`,
  `quantityDeltaFromReads`, `priceQuantityDeltas`, `sensitivityRanking`;
  `priceTakeoff(..., { sources })` and `PricedTakeoff.noRate`; the
  server-only command `merge_branch_part` (a client never sends it). Protocol
  features served only by a server that serves them: `branches:sessions`,
  `branches:merge`, `history:revision_reads`, `history:quantity_delta`. A pack
  using any of these says `kernel: "^1.6.0"`.
- 1.7.0 (round 9), additive: `kernel.element_kind` (add-on-owned element
  kinds, their values, readers lifting the stored fields, the kind's own
  checks) and `PackCommandDef.runs`; `kernel.connector_end_type` (end types
  and which pairs join) with the connector integrity checks and
  `PartImportReport`; `kernel.ifc_import_rule` and the server-only command
  `import_elements`; question threads (`QuestionReplyElement`, `QuestionThread`,
  owner, forward, keep closed), submittals and divergence records with
  `productChainOf`, records' reliance (`validity`: "may no longer hold");
  the WebAuthn verifier (`verifyWebAuthnEs256`, `WebAuthnAssertion`,
  `verifySignoffChainWithSignatures`) and the per-person key log; sheet
  scopes (`sheetMembership`) and `suggestedScopeFor`. An add-on declares
  nothing about what its checks read: the kernel records it. Protocol
  features: `kinds:addon_owned`, `parts:connector_end_types`,
  `parts:direct_joins`, `actors:provider`, `questions:answers`,
  `questions:threads`, `questions:custody`, `submittals:records`,
  `submittals:divergence`, `validity:reliance`; served only by a server that
  serves them: `branches:state_broadcast`, `history:coverage_read`,
  `branches:import`. A pack using any of these says `kernel: "^1.7.0"`.
- 1.8.0 (round 10), additive: `kernel.pipe_product` (pipe products, their
  sizes, joints and hubs, from add-ons) with `liftPipeJoints`; element kind
  faces (`nature`, `shape`, `connectorEnds`, `anchor`, `upgrade`) and records
  that are never drawn; `kernel.agent_tool_pack` and `pack` on agent tools,
  the catalogue in `@permitzip/bim-plugin`; rule versions and "carried
  forward", the open jurisdiction id, the checking context in sign-offs and
  the finding disposition (override); key-history checkpoints; a forward to
  a named person and answers made stale by an edit; `ValidationState`.
  Protocol features: `pipes:addon_products`, `kinds:addon_shapes`,
  `signoffs:checking_context`, `signoffs:dispositions`,
  `questions:forward_person`. A pack using any of these says
  `kernel: "^1.8.0"`.
- 1.9.0 (round 11), additive: one record registry (row `read` and
  `hostedBy.placement` faces, kernel record rows, `PackCommandDef.claims`);
  `kernel.lineage_role` and copies of any depth with the overlay compare,
  review and accept back; `kernel.finding_source`, `FindingRef` and
  `finding_disposition` records; `kernel.lifecycle_stage`, `kernel.stage_set`,
  `kernel.value_basis`, `graph.anchor_kind`, gates and `appliesAt`;
  `Changeset.cites`; `AgreedAmountRef` (read shape); pins with digest and
  tier, the package format and `verifyPackage`, clearance purposes, part
  positions, import-source / export-target and unit-kind points. Protocol features,
  reserved until their writers land: `lineages:roles`, `lineages:review`,
  `lineages:accept_back`, `findings:ledger`, `gates:records`,
  `values:basis`. A pack using any of these says `kernel: "^1.9.0"`.
- 1.10.0 (round 12), additive: `kernel.catalog_entry`, `kernel.diagram_layout`,
  `kernel.view_graphics`, `kernel.rating_kind`, `kernel.route_constraint`,
  `kernel.fitting_family`, `kernel.calc_sheet`, `kernel.design_limit_default`,
  `kernel.intake_column`; network adapter faces `sourcesFor` and `translate`; element kind
  faces `symbol`, `tagText`, `pickShape`; `TypicalCopy.mirror` and `AssemblyStub`; kernel
  subpaths `/calc-sheets`, `/policy`, `/intake`. Added by the lanes inside 1.10.0 (additive):
  `kernel.load_section` (load sections as rows each add-on contributes), `kernel.design_limit_measure`
  (values an add-on measures against design limits), catalog rows' optional `trade` and
  `references`, `DiagramLayoutResult.entries`, `drawViewGraphics`, fitting family rows' `mismatch`
  and `label` faces with `<domain>` / `<service>` / `<service>/<material>` default scopes,
  `CalcSheetLookup.column.by`, `CalcSheetContext.sheets`, the field-block `calc` field, and
  `translate` built by Mechanical, and the network adapter's `connect` face (`connectToSource`: what connecting an unserved end to an offered source writes; the "+" grip's drop), built by Electrical. Protocol features: `typicals:mirror`, `blocks:calc`,
  `views:hash_marks`, `diagrams:fault_current` (each written only when every peer advertises it).
  A pack using any of these says `kernel: "^1.10.0"`.
- 1.11.0 (round 13), additive: `kernel.datum`, `kernel.line_join`, `kernel.host_void`,
  `kernel.bounding_element`, `kernel.ifc_relation`, `kernel.connector_face`,
  `kernel.connection_field`, `kernel.gravity_outfall`; the element kind face `planGraphics`;
  bounded, separated and nested spaces; boundary facts; diagram selection; library item types
  `lookup_table` and `element_type`; the first-party `architecture` add-on. Protocol features
  `spaces:bounded`, `spaces:separators`, `spaces:nested` (advertised), `routing:tap_faces`,
  `elements:create`, `pipes:open_specs` (declared). A pack using any of these says
  `kernel: "^1.11.0"`.
- 1.12.0 (round 14), additive: `kernel.library_rows` and the library joining rule;
  `layoutRowFor`, `DiagramLayoutRow.layoutGraph?` / `serviceSections?`; `ratedSegmentsNear` (rated
  index); `CrossingRule.place?`, `RouteConstraintHit.levelId?` and the route-leg helpers on
  `/rated-routes`, with `RouteFinishOptions.inline?`, `RouteFinishPlan.cut` / `onCentreLine`,
  `CrossingFinishCommand` and `routeFinishBatch`; open stored diagram kinds (`StoredDiagramKind`,
  `DIAGRAM_KIND_ID`, `isRound5DiagramKind`, `diagramKindLabel`, `diagramKindStoreRefusal`);
  `ElementKindItem.scheduleFamily?` / `scheduleCategory?` / `classId?`, `KindShapeField.authored?`,
  `DependencySignature.sources?`; the run insulation names (old `Duct…` names deprecated);
  `SpaceLocator.partsIn?`; `insertPartOnRun` (built, with `partType?`,
  `idPrefix?`, `flip?`, `mark?`); `HostedOn.t?`, `run_branch.t`, `elbow_to_tee.face`;
  `FittingFamilyRow.faceWords?` and `branchLabelOnFace`; `firstPartyServiceRegistry`,
  `ViewOrder.rows`; a first-party pin is satisfied by the base; `PackSet.rowsByPack`. Protocol
  features `library:addon_rows`, `routing:tap_offset`, `routing:insert_part`,
  `diagrams:open_kinds` (all advertised).
  Removed with the service stand-in: `SYSTEM_RULES`, `SYSTEM_KIND_LOOK` and the round 11 load
  section tables (see the 1.12.0 section). A pack using any of these says `kernel: "^1.12.0"`.
- 1.13.0 (round 15), additive: `kernel.class_solids` and the `glazing` look; the `connect_into`
  command, `planConnectInto` and its plan shapes; part model schema 2 (`partModelSchema2`,
  `anyPartModelSchema`); `create_sheet_set` / `update_sheet_set` / `delete_sheet_set`;
  `edit_schedule` steps; `insert_library_view`; script `reads` `fields` / `rows` / `calc` /
  `footprint`; library sections `titleBlocks` / `keynoteTables`. Protocol features
  `geometry:solid_program_2`, `routing:connect_into`, `documents:sheet_sets`,
  `schedules:edit_steps`, `walls:top_constraint`, `parts:class_solids` (declared). A pack using any
  of these says `kernel: "^1.13.0"`.
- 1.13.0 (batch 16-A, Nov 2026), additive: `kernel.linked_plan_display` v1. A pack names the IFC
  entities its trade owns and how a linked model draws them in plan: by body or by the exporter's
  plan symbol; where cut, below the cut and above it (up to the view's top); in ceiling plans; whether
  it hides what is beneath it; left out at Coarse. The kernel's `linkedPlanPlacement` is the one
  view-range rule; a category no row names is not drawn. Also `set_level_linked_storey` (a level keeps,
  per linked model, the storey a person said it is) and `matchLinkedStorey`.
- 1.13.0 (batch 16-D, Nov 2026), additive: `kernel.linked_reference` v1. A pack names the IFC
  entities its trade owns that are reference geometry: snapped and dimensioned to (faces, centre
  line, ends and corners), bounding rooms found from walls, and envelope facts (`wall`, `window`,
  `door`, `roof`). With no row, an entity the plan display draws by body where cut can be snapped
  to and bounds nothing. The kernel builds one plan-grid index per loaded set of linked models
  (`buildLinkedReferenceIndex`); dimensions store a linked element's key (`linked:<model>:<GlobalId>`)
  as an ordinary anchor and follow it while its model is loaded.
- 1.13.0 (Nov 8 2026), additive: `kernel.surface_face` v1. A kind offers its horizontal faces
  (`role`: `structure`, `ceiling` or `roof`; `footprint`; `faceAt` its top and underside at a plan
  point, a plane carried on past its edge). The kernel ships slab and ceiling rows; an add-on adds its
  roof, deck or canopy. A wall's top or base bound to a surface (`LinePlacement.topSurface` /
  `baseSurface`: the structure above, a ceiling, a roof, the floor under it, or one element's face)
  reads these rows through `surfacesAt`, and is re-derived in the same change when a face it reaches
  moves. Prism blocks (`KindSolidShape` `prisms`) may carry `tilt0` / `tilt1` for a sloped bottom or
  top. Peers advertise `walls:surface_binding`; an older peer is sent the height it works out to.

## Version plan

- 1.6.0: round 8b.
- 1.7.0: round 9.
- 1.8.0: round 10.
- 1.9.0: round 11.
- 1.10.0: round 12.
- 1.11.0: round 13.
- 1.12.0: round 14.
- 1.13.0: round 15 (this file).
