/**
 * The Mechanical add-on (`mechanical`, first-party): air networks, duct
 * insulation, outdoor air and pressurization, through the add-on contract
 * only. Ids stay bare (`keepsBareIds`); the manifest is the kernel's
 * `MECHANICAL_MANIFEST`, so a stored model's owner reads the same.
 */
import {
  AGENT_TOOL_POINT,
  BLOCK_TABLE_POINT,
  CALC_POINT,
  COMMAND_POINT,
  contribute,
  definePack,
  FIELD_PROVIDER_POINT,
  LINT_RULE_POINT,
  NETWORK_ADAPTER_POINT,
  PACK_READ_POINT,
  PRESSURE_TARGET_POINT,
  TAG_FIELD_ALIAS_POINT,
  TAG_STYLE_PRESET_POINT,
  type ErasedContribution,
  type Pack,
} from "@permitzip/bim-pack/runtime";
import { guard, isDuctDesignCommand, ductDesignCommandSchemas, refuse, type BlockTableDef, type FieldProviderRow, type NetworkAdapterItem, type PackCommandDef, type PressureTargetRow, type TagFieldAliasRow, type TagStylePresetRow } from "@permitzip/bim-kernel";
import { MECHANICAL_MANIFEST } from "@permitzip/bim-kernel/packs";
import { CONNECTOR_FACE_POINT, CONNECTOR_END_TYPE_POINT, DISCIPLINE_POINT, ELEMENT_KIND_POINT, FITTING_FAMILY_POINT, LIBRARY_ROWS_POINT, LINKED_PLAN_DISPLAY_POINT, LINKED_REFERENCE_POINT, LOAD_SECTION_POINT, SERVICE_POINT } from "@permitzip/bim-kernel";
import { MECHANICAL_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
import { MECHANICAL_LINKED_REFERENCE } from "./linked-reference";
import { MECHANICAL_SCHEDULE_TEMPLATES } from "./schedules/templates";
import { MECHANICAL_KEYNOTE_TABLES } from "./keynotes";
import { ROUTE_CONSTRAINT_POINT } from "@permitzip/bim-kernel/rated-routes";
import { MECHANICAL_AIR_LOAD_SECTION } from "./facets/air";
import { MECHANICAL_SERVICE_ROWS } from "./services/rows";
import { DUCT_FITTING_FAMILY_ROWS } from "./routing/duct-families";
import { MECHANICAL_END_TYPES } from "./connections/end-types";
import { MECHANICAL_KINDS, TERMINAL_AIRFLOW_COMMAND } from "./kinds";
import { MECHANICAL_LEGACY_COMMANDS } from "./legacy-commands";
import { MECHANICAL_DISCIPLINES } from "./disciplines";
import { DIAGRAM_GRAPH_POINT, DIAGRAM_LAYOUT_POINT, MEASURE_RULE_POINT } from "@permitzip/bim-kernel";
import { AIR_SCHEMATIC_GRAPH_ROW, AIR_SCHEMATIC_LAYOUT_ROW } from "./diagrams/air-schematic";
import { MECHANICAL_CONNECTOR_FACE_ROWS } from "./connections/taps-faces";
import { MECHANICAL_ROUTE_RULES } from "./constraints/rated-crossings";
import { MECHANICAL_DESIGN_LIMIT_DEFAULTS } from "./design-limits";
import { DESIGN_LIMIT_DEFAULT_POINT } from "@permitzip/bim-kernel/policy";
import { MECHANICAL_MEASURE_RULE } from "./measure";
import { spaceUseCatalog, spaceUsePressureTarget } from "@permitzip/bim-library";
import { MECHANICAL_AGENT_TOOLS, MECHANICAL_PACK_READS } from "./agent-tools";
import { PRESSURIZATION_TABLE_TITLE, renderPressurizationTable } from "./blocks/pressurization-table";
import { VENTILATION_TABLE_TITLE, renderVentilationTable } from "./blocks/ventilation-table";
import { MECHANICAL_CALCS } from "./calc/mechanical/plugins";
import { PRESSURIZATION_CALCS } from "./calc/mechanical/pressurization";
import { VentilationEngine, ventilationReaderContribution } from "./calc/ventilation/engine";
import { VENTILATION_CALCS } from "./calc/ventilation/plugin";
import { mechanicalAdapter } from "./connections/adapter";
import { mechanicalConnect, mechanicalSourcesFor } from "./connect/terminals";
import { AIR_TREE } from "./connections/tree";
import { translateAir } from "./connections/translate";
import { MECHANICAL_FIELD_PROVIDER } from "./fields/mechanical";
import { VENTILATION_FIELD_PROVIDER } from "./fields/ventilation";
import { balanceRules } from "./lint/balance";
import { routeCrossingRules } from "./lint/route-crossings";
import { withLintRank } from "@permitzip/bim-lint";

/** Where the balance rules ran when they were built in: after plumbing, before questions. */
const BALANCE_LINT_RANK = 1000;
import { executeDuctDesignCommand } from "./routing/duct-design-commands";

/** `sourcesFor` / `connect` (round 15): the "+" grip on a diffuser, grille or unit offers the nearest ducts of its system and drops as one `connect_into`. */
const ADAPTER: NetworkAdapterItem = { id: "mechanical", adapter: mechanicalAdapter, tree: AIR_TREE, translate: translateAir, sourcesFor: mechanicalSourcesFor, connect: mechanicalConnect };

const FIELDS: readonly FieldProviderRow[] = [
  { id: "mechanical", provider: MECHANICAL_FIELD_PROVIDER, rank: 40 },
  { id: "ventilation", provider: VENTILATION_FIELD_PROVIDER, rank: 80 },
];

const TAG_PRESETS: readonly TagStylePresetRow[] = [
  { id: "mechanical.duct_size", rank: 10, preset: { id: "mechanical.duct_size", trade: "mechanical", name: "Duct size", description: "Size along the duct, insulation when it has any.", lines: ["{size}[ {insulation}]"], box: "none", orientation: "along", appliesTo: ["duct"] } },
  { id: "mechanical.duct_size_cfm", rank: 10, preset: { id: "mechanical.duct_size_cfm", trade: "mechanical", name: "Duct size and CFM", description: "Size, then the airflow it carries.", lines: ["{size}", "{cfm} CFM"], box: "none", orientation: "along", appliesTo: ["duct"] } },
  { id: "mechanical.terminal_mark_cfm", rank: 10, preset: { id: "mechanical.terminal_mark_cfm", trade: "mechanical", name: "Air terminal mark and CFM", description: "Mark in a box with its CFM under it.", lines: ["{mark}", "{cfm} CFM"], box: "box", appliesTo: ["air_terminal"] } },
  { id: "mechanical.equipment_mark", rank: 10, preset: { id: "mechanical.equipment_mark", trade: "mechanical", name: "Equipment mark (hexagon)", description: "The unit's mark in a hexagon, with a leader.", lines: ["{mark}"], box: "hexagon", leader: true, appliesTo: ["equipment"] } },
];

/** A style line's {cfm} on a terminal that keeps its flow as `airflow` reads what the built-in air terminal tag reads. */
const TAG_FIELD_ALIASES: readonly TagFieldAliasRow[] = [{ id: "mechanical.cfm", field: "cfm", reads: ["airflow"] }];

const INSULATION_COMMANDS: readonly PackCommandDef[] = ductDesignCommandSchemas.map(
  (schema): PackCommandDef => ({
    type: schema.shape.type.value,
    schema,
    execute(model, command) {
      if (!isDuctDesignCommand(command)) refuse("invalid_value", `${command.type} isn't an insulation command`);
      return guard(() => executeDuctDesignCommand(model, command));
    },
  }),
);

const TABLES: readonly BlockTableDef[] = [
  {
    kind: "ventilation",
    title: VENTILATION_TABLE_TITLE,
    render(model, table) {
      if (table.kind !== "ventilation") throw new Error(`[bim-pack-mechanical] a ${table.kind} table reached the ventilation renderer`);
      return renderVentilationTable(model, table);
    },
  },
  {
    kind: "pressurization",
    title: PRESSURIZATION_TABLE_TITLE,
    render(model, table) {
      if (table.kind !== "pressurization") throw new Error(`[bim-pack-mechanical] a ${table.kind} table reached the pressurization renderer`);
      return renderPressurizationTable(model, table);
    },
  },
];

const catalog = spaceUseCatalog().catalog;

/** The outdoor-air engine every model with this add-on reads (the built-in space uses, the same catalog the Spaces panel pins from). */
export const OUTDOOR_AIR_ENGINE = new VentilationEngine({ uses: catalog });

const SPACE_USE_TARGETS: PressureTargetRow = {
  id: "space_use_targets",
  target: (space) => (space.use && space.use.libraryId === catalog.libraryId ? spaceUsePressureTarget(catalog, space.use.useId) : null),
};

/** This add-on's contributions, in the order the transitional kernel pack and `bim-first-party` added them; then its calcs (the built-in order), lint rules and agent tools. */
export const MECHANICAL_CONTRIBUTIONS: readonly ErasedContribution[] = [
  contribute(DISCIPLINE_POINT, MECHANICAL_DISCIPLINES),
  contribute(NETWORK_ADAPTER_POINT, [ADAPTER]),
  contribute(FIELD_PROVIDER_POINT, FIELDS),
  contribute(TAG_STYLE_PRESET_POINT, TAG_PRESETS),
  contribute(TAG_FIELD_ALIAS_POINT, TAG_FIELD_ALIASES),
  contribute(ELEMENT_KIND_POINT, MECHANICAL_KINDS),
  contribute(FITTING_FAMILY_POINT, DUCT_FITTING_FAMILY_ROWS),
  contribute(LINKED_PLAN_DISPLAY_POINT, MECHANICAL_LINKED_PLAN_DISPLAY),
  contribute(LINKED_REFERENCE_POINT, MECHANICAL_LINKED_REFERENCE),
  contribute(CONNECTOR_FACE_POINT, MECHANICAL_CONNECTOR_FACE_ROWS),
  contribute(ROUTE_CONSTRAINT_POINT, MECHANICAL_ROUTE_RULES),
  contribute(DESIGN_LIMIT_DEFAULT_POINT, MECHANICAL_DESIGN_LIMIT_DEFAULTS),
  contribute(SERVICE_POINT, MECHANICAL_SERVICE_ROWS),
  contribute(LOAD_SECTION_POINT, [MECHANICAL_AIR_LOAD_SECTION]),
  contribute(CONNECTOR_END_TYPE_POINT, MECHANICAL_END_TYPES),
  contribute(COMMAND_POINT, [...INSULATION_COMMANDS, TERMINAL_AIRFLOW_COMMAND, ...MECHANICAL_LEGACY_COMMANDS]),
  contribute(BLOCK_TABLE_POINT, TABLES),
  ventilationReaderContribution(OUTDOOR_AIR_ENGINE),
  contribute(PRESSURE_TARGET_POINT, [SPACE_USE_TARGETS]),
  contribute(CALC_POINT, [...MECHANICAL_CALCS, ...VENTILATION_CALCS, ...PRESSURIZATION_CALCS]),
  contribute(LINT_RULE_POINT, withLintRank([...balanceRules, ...routeCrossingRules], BALANCE_LINT_RANK)),
  contribute(AGENT_TOOL_POINT, MECHANICAL_AGENT_TOOLS),
  contribute(PACK_READ_POINT, MECHANICAL_PACK_READS),
  contribute(MEASURE_RULE_POINT, [MECHANICAL_MEASURE_RULE]),
  contribute(DIAGRAM_GRAPH_POINT, [AIR_SCHEMATIC_GRAPH_ROW]),
  contribute(DIAGRAM_LAYOUT_POINT, [AIR_SCHEMATIC_LAYOUT_ROW]),
  contribute(LIBRARY_ROWS_POINT, [...MECHANICAL_SCHEDULE_TEMPLATES, ...MECHANICAL_KEYNOTE_TABLES]),
];

export const MECHANICAL_PACK: Pack = definePack(MECHANICAL_MANIFEST, MECHANICAL_CONTRIBUTIONS);
