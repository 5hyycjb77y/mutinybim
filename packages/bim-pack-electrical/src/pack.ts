/**
 * The Electrical add-on (namespace `electrical`, first-party, round 6): every
 * row the kernel's generic hubs, the calc registry and the agent host read
 * for this trade, contributed through the add-on contract. Ids stay bare
 * (`keepsBareIds`); stored names are frozen.
 *
 * The contract comes from `@permitzip/bim-kernel/packs` (the same objects
 * `@permitzip/bim-pack` re-exports), not `@permitzip/bim-pack` itself:
 * `bim-pack` reads lint, and the lint rules read this package, so a runtime
 * import of `bim-pack` here would load this file half-initialised.
 */
import { ELECTRICAL_COMPONENTS } from "./annotation/electrical-symbols";
import { TAG_STYLE_PRESET_POINT, BLOCK_DEPENDENCY_POINT, BLOCK_HOP_POINT, SERVICE_HOP, type BlockDependencyDef, type BlockHopDef, catalogElementId, linkServing, loadAnchorOf, loadIndexOf, FORM_SCHEDULE_POINT, type BimElement, type ElementId, type PartInstance, SYMBOL_POINT, symbolOfComponent, COMMAND_POINT, type PackCommandDef, refuse, POSITION_POLICY_POINT, NETWORK_ADAPTER_POINT, CATALOG_ENTRY_POINT, CONNECTION_FIELD_POINT, DIAGRAM_LAYOUT_POINT, VIEW_GRAPHICS_POINT, LOAD_SECTION_POINT, type NetworkAdapterItem, DIAGRAM_GRAPH_POINT, type DiagramGraphDef, FIELD_PROVIDER_POINT, type FieldProviderRow, FIELD_RESOLVER_POINT, DEDICATED_SPACE_RULE, DERIVED_ZONE_RULE_POINT, type DerivedZoneRuleDef, BUILTIN_LIBRARY_VERSION, PART_TYPE_POINT, type BuiltinPartTypeRow } from "@permitzip/bim-kernel";
import { distributionOf, electricalConnectorIds } from "./connections/systems";
import { ELECTRICAL_CATALOG_ROWS, ELECTRICAL_CONNECTION_FIELDS, feederTypeScheduleRecords } from "./catalog";
import { ONE_LINE_LAYOUT_ROW } from "./diagrams/one-line-layout";
import { CIRCUIT_GRAPHICS_ROW } from "./annotation/circuit-graphics";
import { ELECTRICAL_LOAD_SECTION } from "./facets";
import { electricalSourcesFor } from "./connections/sources";
import { DESIGN_LIMIT_DEFAULT_POINT } from "@permitzip/bim-kernel/policy";
import { ELECTRICAL_DESIGN_LIMIT_DEFAULTS } from "./design-limits";
import { electricalEngineFor, DEMAND_RULE_SET_POINT } from "./fields/rules-registry";
import { DISTRIBUTION_FORM_ROWS } from "./schedules/distribution-forms";
import { electricalAdapter, freePositionGroups } from "./connections/adapter";
import { existingCircuitRefusal } from "./connections/panel";
import { executeServiceLayoutCommand, isServiceLayoutCommand, serviceLayoutCommandSchemas } from "./connections/service-layout";
import { electricalDiagramGraph, utilityNodeFor } from "./diagrams/electrical-graph";
import { LINK_TYPE_CATALOG_POINT, type LinkTypeCatalogRow } from "./fields/feeder-types";
import { ELECTRICAL_FIELD_RESOLVER } from "./fields/electrical-resolver";
import { ELECTRICAL_FIELD_PROVIDER } from "./fields/providers/electrical";
import { AGENT_TOOL_POINT, PACK_READ_POINT, contribute, definePack, type ErasedContribution, type Pack, ELECTRICAL_MANIFEST } from "@permitzip/bim-kernel/packs";
import { DISCIPLINE_POINT, MEASURE_RULE_POINT, PROPOSER_POINT, SERVICE_POINT } from "@permitzip/bim-kernel";
import { ELECTRICAL_PLANNED_ROW_FACTS } from "./planned-row-facts";
import { ELECTRICAL_SERVICE_ROWS } from "./services/rows";
import { ELECTRICAL_DISCIPLINES } from "./disciplines";
import { RECEPTACLE_PROPOSER } from "./propose/proposer";
import { ELECTRICAL_MEASURE_RULE } from "./measure";
import { CALC_POINT, PREVIEW_CALC_POINT, SOURCE_SUPPLY_POINT, type SourceSupplyRow } from "@permitzip/bim-calc";
import { ELECTRICAL_AGENT_TOOLS, ELECTRICAL_PACK_READS } from "./agent-tools";
import { ELECTRICAL_SCRIPT_READS } from "./script-reads";
import { declaredPoint, type KnownPoint } from "@permitzip/bim-pack/runtime";
import { necRuleSets } from "./calc/aggregation-rules";
import { ELECTRICAL_CALCS, PREVIEW_ELECTRICAL_CALCS } from "./calc/plugins";
import { electricalStarterTypes, supersededElectricalStarterTypes } from "./library/electrical";
import { ELECTRICAL_LINT_RULES } from "./lint";
import { LINT_RULE_POINT } from "@permitzip/bim-lint";
import { electricalConnect } from "./circuiting/connect";
import { ELECTRICAL_SCHEDULE_TEMPLATES } from "./schedules/list-templates";
import { ELECTRICAL_KEYNOTE_TABLES } from "./keynotes";
import { LIBRARY_ROWS_POINT } from "@permitzip/bim-kernel";

const [serviceLayoutSchema] = serviceLayoutCommandSchemas;

const SERVICE_LAYOUT_COMMAND: PackCommandDef = {
  type: "place_service_layout",
  schema: serviceLayoutSchema,
  execute(model, command) {
    if (!isServiceLayoutCommand(command)) refuse("invalid_value", `${command.type} isn't a service layout`);
    return executeServiceLayoutCommand(model, command);
  },
};

/** The NEC 110.26(E) dedicated equipment space above a panel: a placed part's clearances that keep out foreign systems. */
const DEDICATED_SPACE: DerivedZoneRuleDef = { id: DEDICATED_SPACE_RULE, label: "Dedicated equipment space", ifcPredefinedType: "RESERVATION", takes: (z) => z.excludes === "foreign_systems" };

const ADAPTER: NetworkAdapterItem = { id: "electrical", adapter: electricalAdapter, sourcesFor: electricalSourcesFor, connect: electricalConnect };

const ONE_LINE: DiagramGraphDef = {
  kind: "one_line",
  build: (elements, hints) => electricalDiagramGraph(elements, hints),
  roots(elements, graph, hints) {
    if (hints.utility === false) return graph.roots;
    // A root drawn only because its feeders loop is not a service either.
    const looped = new Set(graph.warnings.flatMap((w) => (w.kind === "loop" ? [w.elementId] : [])));
    return graph.roots.map((r) => (r.elementId && looped.has(r.elementId) ? null : utilityNodeFor(elements, r)) ?? r);
  },
};

const RISER: DiagramGraphDef = { kind: "electrical_riser", build: (elements, hints) => electricalDiagramGraph(elements, hints) };

type Elements = Readonly<Record<string, BimElement>>;

function partOf(elements: Elements, id: string | undefined): PartInstance | null {
  const el = id ? elements[id] : undefined;
  return el?.kind === "part" ? el : null;
}

/** The board that feeds a part: a panel's feeder source, a device's circuit panel. */
function feedingBoard(elements: Elements, part: PartInstance): PartInstance | null {
  const info = distributionOf(elements, part);
  if (info) return info.input ? partOf(elements, linkServing(elements, part.id, info.input)?.source.elementId) : null;
  for (const connector of electricalConnectorIds(elements, part)) {
    const link = linkServing(elements, part.id, connector);
    if (link) return partOf(elements, link.source.elementId);
  }
  return null;
}

/** The `service` hop: the top of a subject's supply chain (the service entrance), or the project's main service with no subject. */
const SERVICE_HOP_ROW: BlockHopDef = {
  id: SERVICE_HOP,
  target(model, subjectId, opts) {
    const elements = model.elements;
    if (subjectId === undefined) {
      // Distribution lists sources first, then by name: the first one is a service nothing feeds.
      const first = electricalEngineFor(opts.rules).distribution(model)[0];
      return first ?? null;
    }
    const subject = elements[subjectId];
    // A circuit or feeder reads the service of the board it leaves.
    let at = subject?.kind === "service_link" ? partOf(elements, subject.source.elementId) : partOf(elements, subjectId);
    if (!at) return null;
    const seen = new Set<string>();
    for (;;) {
      seen.add(at.id);
      const up = feedingBoard(elements, at);
      if (!up || seen.has(up.id)) return distributionOf(elements, at) ? at.id : null;
      at = up;
    }
  },
};

/** Everything a distribution node's loads read: itself, its type, every link it feeds, their members, types, catalog rows, groups, and the nodes below. */
function distributionDeps(elements: Elements, rootId: ElementId, out: Set<ElementId>): void {
  const stack: ElementId[] = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as ElementId;
    if (seen.has(id)) continue;
    seen.add(id);
    const part = partOf(elements, id);
    out.add(id);
    if (!part) continue;
    out.add(part.typeId);
    for (const lid of loadIndexOf(elements).servedBy(id)) {
      out.add(lid);
      const lp = elements[lid];
      if (lp?.kind === "load_point") {
        const anchor = loadAnchorOf(lp);
        if (anchor.kind === "space" || anchor.kind === "zone") out.add(anchor.id);
      }
    }
    if (part.groupId) out.add(part.groupId as ElementId);
    for (const linkId of part.feeds ?? []) {
      out.add(linkId);
      const link = elements[linkId];
      if (link?.kind !== "service_link" || link.trade !== "electrical") continue;
      if (link.electrical?.feederType) out.add(catalogElementId("feeder_type", link.electrical.feederType));
      for (const m of link.members) {
        const member = partOf(elements, m.elementId);
        out.add(m.elementId);
        if (!member) continue;
        out.add(member.typeId);
        if (member.groupId) out.add(member.groupId as ElementId);
        const ct = member.values.connection_type;
        if (typeof ct === "string" && ct.trim() !== "") out.add(catalogElementId("connection_type", ct));
        if (link.role === "feeder") stack.push(member.id);
      }
    }
  }
}

const DISTRIBUTION_DEPS: BlockDependencyDef = {
  id: "distribution",
  collect(elements, id, out) {
    const part = partOf(elements, id);
    if (!part || !distributionOf(elements, part)) return false;
    distributionDeps(elements, id, out);
    return true;
  },
};

const FIELDS: FieldProviderRow = { id: "electrical", provider: ELECTRICAL_FIELD_PROVIDER, rank: 10 };

const FEEDER_TYPES: LinkTypeCatalogRow = { id: "feeder_types", read: feederTypeScheduleRecords };

/** A panel, switchboard or transformer as a source: the system it supplies, for the load totals by source. */
const SOURCE_SUPPLY: SourceSupplyRow = {
  id: "distribution",
  read(elements, part) {
    const dist = distributionOf(elements, part);
    return dist ? { name: dist.name, voltageV: dist.system.lineToLine, phases: dist.system.phases } : null;
  },
};

/** The starter part types (switches, 277/480 V distribution, a transformer, a 480 V makeup air unit); earlier versions stay readable. */
const PART_TYPES: readonly BuiltinPartTypeRow[] = [
  ...electricalStarterTypes(BUILTIN_LIBRARY_VERSION).map((entry) => ({ entry })),
  ...supersededElectricalStarterTypes(BUILTIN_LIBRARY_VERSION).map((entry) => ({ entry, superseded: true })),
];

/** This pack's contributions: the wave-1 kernel rows in their order, then the demand rule sets, calcs, part types, lint rules and agent tools. */
export const ELECTRICAL_CONTRIBUTIONS: readonly ErasedContribution[] = [
  contribute(DISCIPLINE_POINT, ELECTRICAL_DISCIPLINES),
  contribute(COMMAND_POINT, [SERVICE_LAYOUT_COMMAND]),
  contribute(NETWORK_ADAPTER_POINT, [ADAPTER]),
  contribute(DERIVED_ZONE_RULE_POINT, [DEDICATED_SPACE]),
  contribute(LINK_TYPE_CATALOG_POINT, [FEEDER_TYPES]),
  contribute(CATALOG_ENTRY_POINT, ELECTRICAL_CATALOG_ROWS),
  contribute(CONNECTION_FIELD_POINT, ELECTRICAL_CONNECTION_FIELDS),
  contribute(DIAGRAM_LAYOUT_POINT, [ONE_LINE_LAYOUT_ROW]),
  contribute(VIEW_GRAPHICS_POINT, [CIRCUIT_GRAPHICS_ROW]),
  contribute(LOAD_SECTION_POINT, [ELECTRICAL_LOAD_SECTION]),
  contribute(SERVICE_POINT, ELECTRICAL_SERVICE_ROWS),
  contribute(DESIGN_LIMIT_DEFAULT_POINT, ELECTRICAL_DESIGN_LIMIT_DEFAULTS),
  contribute(FIELD_PROVIDER_POINT, [FIELDS]),
  contribute(DIAGRAM_GRAPH_POINT, [ONE_LINE, RISER]),
  contribute(SYMBOL_POINT, ELECTRICAL_COMPONENTS.map(symbolOfComponent)),
  contribute(BLOCK_HOP_POINT, [SERVICE_HOP_ROW]),
  contribute(BLOCK_DEPENDENCY_POINT, [DISTRIBUTION_DEPS]),
  contribute(FORM_SCHEDULE_POINT, DISTRIBUTION_FORM_ROWS),
  contribute(FIELD_RESOLVER_POINT, [ELECTRICAL_FIELD_RESOLVER]),
  contribute(TAG_STYLE_PRESET_POINT, [
    { id: "electrical.circuit", rank: 30, preset: { id: "electrical.circuit", trade: "electrical", name: "Circuit", description: "The panel and circuit a device is on (HP1-43,45).", lines: ["{circuit}"], box: "none", leader: true, appliesTo: ["part", "equipment"] } },
  ]),
  contribute(POSITION_POLICY_POINT, [{ id: "electrical", groups: (spaces, occupied, poles, valid) => freePositionGroups(spaces, occupied, poles, valid), lockedRefusal: existingCircuitRefusal }]),
  contribute(DEMAND_RULE_SET_POINT, necRuleSets()),
  contribute(CALC_POINT, ELECTRICAL_CALCS),
  contribute(PREVIEW_CALC_POINT, PREVIEW_ELECTRICAL_CALCS),
  contribute(SOURCE_SUPPLY_POINT, [SOURCE_SUPPLY]),
  contribute(PART_TYPE_POINT, PART_TYPES),
  contribute(LINT_RULE_POINT, ELECTRICAL_LINT_RULES),
  contribute(AGENT_TOOL_POINT, ELECTRICAL_AGENT_TOOLS),
  contribute(PACK_READ_POINT, [...ELECTRICAL_PACK_READS, ELECTRICAL_PLANNED_ROW_FACTS, ...ELECTRICAL_SCRIPT_READS]),
  contribute(MEASURE_RULE_POINT, [ELECTRICAL_MEASURE_RULE]),
  contribute(PROPOSER_POINT, [RECEPTACLE_PROPOSER]),
  contribute(LIBRARY_ROWS_POINT, [...ELECTRICAL_SCHEDULE_TEMPLATES, ...ELECTRICAL_KEYNOTE_TABLES]),
];

export const ELECTRICAL_PACK: Pack = definePack(ELECTRICAL_MANIFEST, ELECTRICAL_CONTRIBUTIONS);

/** The points Electrical declares for other packs (a firm's demand rules, a link-type catalog); pass to `runPackConformance` as `points`. */
export const ELECTRICAL_POINTS: readonly KnownPoint[] = [
  declaredPoint(DEMAND_RULE_SET_POINT, (items) => items.flatMap((r) => (typeof r.demand === "function" ? [] : [`demand rule set ${r.id} has no demand`]))),
  declaredPoint(LINK_TYPE_CATALOG_POINT, (items) => items.flatMap((r) => (typeof r.read === "function" ? [] : [`link-type catalog ${r.id} has no read`]))),
];
