/**
 * The Plumbing and gas first-party add-on: every row the kernel's generic
 * hubs read for water, drainage, vent, storm and fuel gas. Ids stay bare
 * (`keepsBareIds`); stored names are frozen.
 */
import { GAS_TABLE_TITLE, renderGasTable } from "./blocks/gas-table";
import { BLOCK_TABLE_POINT, type BlockTableDef, refuse, COMMAND_POINT, type PackCommandDef, NETWORK_ADAPTER_POINT, type NetworkAdapterItem, DIAGRAM_GRAPH_POINT, type DiagramGraphDef, FIELD_PROVIDER_POINT, type FieldProviderRow, TAG_STYLE_PRESET_POINT, type TagStylePresetRow, FIELD_RESOLVER_POINT, type FieldResolverDef, FORM_SCHEDULE_POINT, BUILTIN_LIBRARY_VERSION, CONNECTION_QUANTITY_CHECK_POINT, DRAWN_SOURCE_POINT, NETWORK_COUPLING_POINT, PART_TYPE_POINT, PIPE_RUN_CHECK_POINT, SERVES_RULE_POINT, STARTER_CONNECTION_TYPE_POINT, SYSTEM_LABEL_POINT } from "@permitzip/bim-kernel";
import { CALC_POINT } from "@permitzip/bim-calc";
import { MEASURE_RULE_POINT, PROPOSER_POINT } from "@permitzip/bim-kernel";
import { PLUMBING_MEASURE_RULE } from "./measure";
import { LINT_RULE_POINT } from "@permitzip/bim-lint";
import { PLUMBING_LINT_RULES } from "./lint";
import { WATER_HEATER_COUPLING } from "./load-points/water-heater";
import { PLUMBING_AGENT_TOOLS, PLUMBING_PACK_READS } from "./agent-tools";
import { PLUMBING_CALCS } from "./calc/plumbing/plugins";
import { PLUMBING_STARTER_CONNECTION_TYPES, plumbingStarterTypes } from "./library/plumbing";
import { DRAINAGE_RUN_CHECK } from "./routing/pipe/drainage";
import { GAS_FUEL_SYSTEM_LABEL } from "./routing/pipe/gas-fuel";
import { GAS_MINIMUM_INLET_CHECK } from "./routing/pipe/gas-connection-checks";
import { executeVerticalRunCommand, isVerticalRunCommand, verticalRunCommandSchemas } from "./plumbing/commands";
import { plumbingAdapter, plumbingDrawnSource } from "./connections/plumbing/adapter";
import { plumbingConnect, plumbingSourcesFor } from "./connect/fixtures";
import { plumbingDiagramGraph } from "./diagrams/plumbing-graph";
import { PLUMBING_DIAGRAM_LAYOUT_ROWS } from "./diagrams/layout-rows";
import { GAS_FIELD_PROVIDER, GAS_SERVES_RULE } from "./fields/providers/gas";
import { PLUMBING_FIELD_PROVIDER } from "./fields/providers/plumbing";
import { GAS_FIELD_PATHS, GAS_SIZE_LENGTH_TAG_PRESET, resolveGasField } from "./fields/gas";
import { PLUMBING_FIELD_PATHS, resolvePlumbingField } from "./fields/plumbing";
import { STACK_FIELD_PATHS, resolveStackField } from "./plumbing/stack-fields";
import { WATER_FIELD_PATHS, resolveWaterField } from "./fields/water";
import { FUEL_FORM_ROWS } from "./schedules/forms/fuel-forms";
import { PLUMBING_SCHEDULE_TEMPLATES } from "./schedules/templates";
import { PLUMBING_KEYNOTE_TABLES } from "./keynotes";
import { AGENT_TOOL_POINT, PACK_READ_POINT, contribute, definePack, type ErasedContribution, type Pack, PLUMBING_GAS_MANIFEST } from "@permitzip/bim-kernel/packs";
import { CONNECTOR_END_TYPE_POINT, DISCIPLINE_POINT, FITTING_FAMILY_POINT, PIPE_PRODUCT_POINT, SERVICE_POINT, LOAD_SECTION_POINT, CATALOG_ENTRY_POINT } from "@permitzip/bim-kernel";
import { PLUMBING_CATALOG_ENTRY_ROWS } from "./catalog/entry-rows";
import { DESIGN_LIMIT_DEFAULT_POINT, DESIGN_LIMIT_MEASURE_POINT } from "@permitzip/bim-kernel/policy";
import { PIPE_VELOCITY_MEASURE } from "./checks/velocity-band";
import { CLEANOUT_PROPOSER } from "./drainage/cleanouts";
import { PLUMBING_DESIGN_LIMIT_DEFAULTS } from "./design-limits";
import { CALC_SHEET_POINT } from "@permitzip/bim-kernel/calc-sheets";
import { PLUMBING_CALC_SHEET_TEMPLATES } from "./calc-sheets";
import { PLUMBING_SERVICE_ROWS } from "./services";
import { PLUMBING_LOAD_SECTION_ROWS } from "./facets";
import { PIPE_END_TYPES } from "./routing/pipe/end-types";
import { PIPE_FITTING_FAMILY_ROWS } from "./routing/pipe/families";
import { PIPE_PRODUCTS } from "./routing/pipe/products";
import { PLUMBING_DISCIPLINES } from "./disciplines";
import { DIAGRAM_LAYOUT_POINT, GRAVITY_OUTFALL_POINT, LIBRARY_ROWS_POINT, LINKED_PLAN_DISPLAY_POINT, VIEW_GRAPHICS_POINT } from "@permitzip/bim-kernel";
import { PLUMBING_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
import { ASSEMBLY_STUBS_VIEW_GRAPHICS } from "@permitzip/bim-kernel/typicals";
import { SEWER_CONNECTION_OUTFALL } from "./drainage/outfall";

/** `sourcesFor` / `connect` (round 15): the "+" grip on a fixture or an open pipe end offers the nearest runs of its system and drops as one `connect_into`. */
const ADAPTER: NetworkAdapterItem = { id: "plumbing", adapter: plumbingAdapter, sourcesFor: plumbingSourcesFor, connect: plumbingConnect };

const FIELDS: readonly FieldProviderRow[] = [
  { id: "plumbing", provider: PLUMBING_FIELD_PROVIDER, rank: 20 },
  { id: "gas", provider: GAS_FIELD_PROVIDER, rank: 30 },
];

const RESOLVERS: readonly FieldResolverDef[] = [
  // Plumbing answers only its own prefixes (pipe.carries.*), before the kernel's pipe paths.
  { id: "plumbing", resolveRank: 10, listRank: 50, paths: PLUMBING_FIELD_PATHS, resolve: (elements, elementId, path) => resolvePlumbingField(elements, elementId, path) },
  { id: "gas", resolveRank: 30, listRank: 30, paths: GAS_FIELD_PATHS, resolve: (elements, elementId, path) => resolveGasField(elements, elementId, path) },
  { id: "stack", resolveRank: 40, listRank: 40, paths: STACK_FIELD_PATHS, resolve: (elements, elementId, path) => resolveStackField(elements, elementId, path) },
  { id: "water", resolveRank: 35, listRank: 35, paths: WATER_FIELD_PATHS, resolve: (elements, elementId, path) => resolveWaterField(elements, elementId, path) },
];

const TAG_PRESETS: readonly TagStylePresetRow[] = [
  { id: "plumbing.pipe_size", rank: 20, preset: { id: "plumbing.pipe_size", trade: "plumbing", name: "Pipe size", description: "Nominal size along the pipe.", lines: ["{pipe.size}"], box: "none", orientation: "along", appliesTo: ["pipe"] } },
  { id: "plumbing.pipe_size_slope", rank: 20, preset: { id: "plumbing.pipe_size_slope", trade: "plumbing", name: "Pipe size and slope", description: "Size, with the slope on drains.", lines: ["{pipe.size}[ @ {pipe.slope}]"], box: "none", orientation: "along", appliesTo: ["pipe"] } },
  { id: "plumbing.drain_slope", rank: 20, preset: { id: "plumbing.drain_slope", trade: "plumbing", name: "Drain slope", description: "The drain's fall along it (1/4\"/FT) with an arrow pointing downhill; blank on level pipe.", lines: ["[{pipe.slope}]"], box: "none", orientation: "along", appliesTo: ["pipe"], arrow: "down_slope" } },
  { id: "plumbing.drain_inverts", rank: 20, preset: { id: "plumbing.drain_inverts", trade: "plumbing", name: "Drain size, slope and inverts", description: "Size and slope, with the invert at each end of the piece (start to end as drawn).", lines: ["{pipe.size}[ @ {pipe.slope}]", "[IE {pipe.invert_start}][ TO {pipe.invert_end}]"], box: "none", orientation: "along", appliesTo: ["pipe"] } },
  { id: "plumbing.fixture_mark", rank: 20, preset: { id: "plumbing.fixture_mark", trade: "plumbing", name: "Fixture mark (circle)", description: "The fixture's mark in a circle.", lines: ["{mark}"], box: "circle", appliesTo: ["fixture"] } },
  { id: GAS_SIZE_LENGTH_TAG_PRESET.id, rank: 40, preset: GAS_SIZE_LENGTH_TAG_PRESET },
];

const STACK_COMMANDS: readonly PackCommandDef[] = verticalRunCommandSchemas.map(
  (schema): PackCommandDef => ({
    type: schema.shape.type.value,
    schema,
    execute(model, command) {
      if (!isVerticalRunCommand(command)) refuse("invalid_value", `${command.type} isn't a stack command`);
      return executeVerticalRunCommand(model, command);
    },
  }),
);

const GAS_TABLE: BlockTableDef = {
  kind: "gas",
  title: GAS_TABLE_TITLE,
  render(model, table) {
    if (table.kind !== "gas") throw new Error(`[first-party/plumbing] a ${table.kind} table reached the gas renderer`);
    return renderGasTable(model, table);
  },
};

const DIAGRAMS: readonly DiagramGraphDef[] = [
  { kind: "plumbing_riser", build: (elements, hints) => plumbingDiagramGraph(elements, hints) },
  { kind: "plumbing_isometric", build: (elements, hints) => plumbingDiagramGraph(elements, hints) },
];

/** The plumbing starter library: fixtures and equipment shipped with starter connection types. */
const PART_TYPES = plumbingStarterTypes(BUILTIN_LIBRARY_VERSION).map((entry) => ({ entry }));

export const PLUMBING_GAS_CONTRIBUTIONS: readonly ErasedContribution[] = [contribute(DISCIPLINE_POINT, PLUMBING_DISCIPLINES), contribute(NETWORK_ADAPTER_POINT, [ADAPTER]), contribute(FIELD_PROVIDER_POINT, FIELDS), contribute(DIAGRAM_GRAPH_POINT, DIAGRAMS), contribute(DIAGRAM_LAYOUT_POINT, PLUMBING_DIAGRAM_LAYOUT_ROWS), contribute(FORM_SCHEDULE_POINT, FUEL_FORM_ROWS), contribute(FIELD_RESOLVER_POINT, RESOLVERS), contribute(TAG_STYLE_PRESET_POINT, TAG_PRESETS), contribute(COMMAND_POINT, STACK_COMMANDS), contribute(BLOCK_TABLE_POINT, [GAS_TABLE]), contribute(SYSTEM_LABEL_POINT, [GAS_FUEL_SYSTEM_LABEL]), contribute(PIPE_RUN_CHECK_POINT, [DRAINAGE_RUN_CHECK]), contribute(SERVES_RULE_POINT, [GAS_SERVES_RULE]), contribute(STARTER_CONNECTION_TYPE_POINT, PLUMBING_STARTER_CONNECTION_TYPES), contribute(CONNECTION_QUANTITY_CHECK_POINT, [GAS_MINIMUM_INLET_CHECK]), contribute(PART_TYPE_POINT, PART_TYPES), contribute(CALC_POINT, PLUMBING_CALCS), contribute(LINT_RULE_POINT, PLUMBING_LINT_RULES), contribute(DRAWN_SOURCE_POINT, [{ id: "plumbing", check: plumbingDrawnSource }]), contribute(NETWORK_COUPLING_POINT, [WATER_HEATER_COUPLING]), contribute(AGENT_TOOL_POINT, PLUMBING_AGENT_TOOLS), contribute(PACK_READ_POINT, PLUMBING_PACK_READS), contribute(MEASURE_RULE_POINT, [PLUMBING_MEASURE_RULE]), contribute(CONNECTOR_END_TYPE_POINT, PIPE_END_TYPES), contribute(PIPE_PRODUCT_POINT, PIPE_PRODUCTS), contribute(FITTING_FAMILY_POINT, PIPE_FITTING_FAMILY_ROWS), contribute(SERVICE_POINT, PLUMBING_SERVICE_ROWS), contribute(LOAD_SECTION_POINT, PLUMBING_LOAD_SECTION_ROWS), contribute(CATALOG_ENTRY_POINT, PLUMBING_CATALOG_ENTRY_ROWS), contribute(DESIGN_LIMIT_DEFAULT_POINT, PLUMBING_DESIGN_LIMIT_DEFAULTS), contribute(DESIGN_LIMIT_MEASURE_POINT, [PIPE_VELOCITY_MEASURE]), contribute(PROPOSER_POINT, [CLEANOUT_PROPOSER]), contribute(CALC_SHEET_POINT, PLUMBING_CALC_SHEET_TEMPLATES), contribute(GRAVITY_OUTFALL_POINT, [SEWER_CONNECTION_OUTFALL]), contribute(VIEW_GRAPHICS_POINT, [ASSEMBLY_STUBS_VIEW_GRAPHICS]), contribute(LIBRARY_ROWS_POINT, [...PLUMBING_SCHEDULE_TEMPLATES, ...PLUMBING_KEYNOTE_TABLES]), contribute(LINKED_PLAN_DISPLAY_POINT, PLUMBING_LINKED_PLAN_DISPLAY)];

export const PLUMBING_GAS_PACK: Pack = definePack(PLUMBING_GAS_MANIFEST, PLUMBING_GAS_CONTRIBUTIONS);
