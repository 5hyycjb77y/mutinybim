/**
 * Every extension point this release reads, from every layer, with what the
 * conformance suite checks on a pack's items there and which first-party
 * pack each built-in row belongs to (for Settings › MutinyBIM library).
 */
import {
  BUILTIN_FACET_REGISTRY,
  BUILTIN_SERVICE_REGISTRY,
  BUILTIN_SYMBOL_REGISTRY,
  CLASS_POINT,
  DERIVED_ZONE_RULE_POINT,
  FACET_POINT,
  KNOWN_AGGREGATION_DIRECTIONS,
  KNOWN_NETWORK_LINKS,
  NETWORK_ADAPTER_POINT,
  PARAMETER_SET_POINT,
  PIPE_MATERIAL_POINT,
  SERVICE_POINT,
  SERVICE_TRADES,
  SYMBOL_POINT,
  SURFACE_ROLE_POINT,
  ZONE_PURPOSE_POINT,
  builtinRegistry,
  derivedZoneRuleOwner,
  fieldProviderRegistry,
  networkAdapterOwner,
  packClassRegistry,
  serviceRowOwner,
  symbolOwner,
  withFacetRows,
  withPackParameters,
  withPackServices,
  withSymbolRows,
} from "@permitzip/bim-kernel";
import { CONNECTION_QUANTITY_CHECK_POINT, PIPE_RUN_CHECK_POINT, SERVES_RULE_POINT, STARTER_CONNECTION_TYPE_POINT, SYSTEM_LABEL_POINT } from "@permitzip/bim-kernel";
import { CLASSIFICATION_POINT, COST_SOURCE_POINT, MEASURE_RULE_POINT, KNOWN_COST_PARTIES } from "@permitzip/bim-kernel";
import { REQUIREMENTS_SOURCE_CONTRACT, REQUIREMENTS_SOURCE_POINT, PROPOSER_POINT, DISCIPLINE_POINT, disciplineAncestors, disciplineDef } from "@permitzip/bim-kernel";
import { z } from "zod";
import { BLOCK_DEPENDENCY_POINT, BLOCK_HOP_POINT, BLOCK_TABLE_POINT, FIELD_RESOLVER_POINT, POSITION_POLICY_POINT, TAG_FIELD_ALIAS_POINT, TAG_STYLE_PRESET_POINT, tagStylePresets, COMMAND_POINT, DIAGRAM_GRAPH_POINT, FIELD_PROVIDER_POINT, FORM_SCHEDULE_POINT, OUTDOOR_AIR_READER_POINT, PRESSURE_TARGET_POINT, DRAWN_SOURCE_POINT, NETWORK_COUPLING_POINT } from "@permitzip/bim-kernel";
import { PART_TYPE_POINT } from "@permitzip/bim-kernel";
import { ELEMENT_KIND_POINT, KERNEL_ELEMENT_KINDS, elementKindRowProblems } from "@permitzip/bim-kernel";
import { CONNECTOR_END_TYPE_POINT, connectorEndTypeRowProblems } from "@permitzip/bim-kernel";
import { PIPE_PRODUCT_POINT, connectorEndTypeTable, pipeProductRowProblems } from "@permitzip/bim-kernel";
import { IFC_IMPORT_RULE_POINT, importRuleRowProblems } from "@permitzip/bim-kernel";
import { CHANGE_SIGNIFICANCE_POINT, IDENTITY_PROVIDER_POINT, IdentityProviderRegistry, QUESTION_OUTCOME_POINT, changeKindProblems, questionOutcomeProblems } from "@permitzip/bim-kernel";
import { GRAPH_ANCHOR_POINT, GRAPH_OWN_ANCHOR_KINDS } from "@permitzip/bim-kernel";
import { BASIS_POINT, basisRowProblems } from "@permitzip/bim-kernel/basis";
import { FINDING_SOURCE_POINT, findingSourceRowProblems } from "@permitzip/bim-kernel/findings";
import { LIFECYCLE_STAGE_POINT, STAGE_SET_POINT, stageProblems } from "@permitzip/bim-kernel/lifecycle";
import { LINEAGE_ROLE_POINT, lineageRoleProblems } from "@permitzip/bim-kernel/lineages";
import { CLEARANCE_PURPOSE_POINT, clearancePurposeRowProblems } from "@permitzip/bim-kernel";
import { EXPORT_TARGET_POINT, IMPORT_SOURCE_POINT, exportTargetRowProblems, importSourceRowProblems } from "@permitzip/bim-kernel/formats";
import { UNIT_KIND_POINT, unitKindRowProblems } from "@permitzip/bim-units/kinds";
import { LOAD_SECTION_POINT, loadSectionRowProblems } from "@permitzip/bim-kernel";
import { CATALOG_ENTRY_POINT, DIAGRAM_LAYOUT_POINT, FITTING_FAMILY_POINT, VIEW_GRAPHICS_POINT, catalogEntryRowProblems, diagramLayoutRowProblems, fittingFamilyRowProblems, viewGraphicsRowProblems } from "@permitzip/bim-kernel";
import { RATING_KIND_POINT, ROUTE_CONSTRAINT_POINT, ratingKindRowProblems, routeConstraintRowProblems } from "@permitzip/bim-kernel/rated-routes";
import { CALC_SHEET_POINT, calcSheetRowProblems } from "@permitzip/bim-kernel/calc-sheets";
import { CLASS_PLAN_GRAPHICS_POINT, classPlanGraphicsRowProblems } from "@permitzip/bim-kernel";
import { LIBRARY_ROWS_POINT, libraryRowProblems } from "@permitzip/bim-kernel";
import { CLASS_SOLIDS_POINT, classSolidsRowProblems } from "@permitzip/bim-kernel";
import { STARTER_ELEMENT_TYPE_POINT, starterElementTypeRowProblems } from "@permitzip/bim-kernel";
import { LINKED_PLAN_DISPLAY_POINT, linkedPlanDisplayRowProblems } from "@permitzip/bim-kernel";
import { LINKED_REFERENCE_POINT, linkedReferenceRowProblems } from "@permitzip/bim-kernel";
import { SURFACE_FACE_POINT, surfaceFaceRowProblems } from "@permitzip/bim-kernel";
import { BOUNDING_ELEMENT_POINT, CONNECTION_FIELD_POINT, CONNECTOR_FACE_POINT, DATUM_POINT, GRAVITY_OUTFALL_POINT, HOST_VOID_POINT, IFC_RELATION_POINT, LINE_JOIN_POINT, boundingElementRowProblems, connectionFieldRowProblems, connectorFaceRowProblems, datumRowProblems, gravityOutfallRowProblems, hostVoidRowProblems, ifcRelationRowProblems, lineJoinRowProblems } from "@permitzip/bim-kernel";
import { DESIGN_LIMIT_DEFAULT_POINT, DESIGN_LIMIT_MEASURE_POINT, designLimitMeasureProblems, designLimitProblems } from "@permitzip/bim-kernel/policy";
import { INTAKE_COLUMN_POINT, intakeColumnRowProblems } from "@permitzip/bim-kernel/intake";
import { bimPackCatalogue } from "@permitzip/bim-plugin";
import {
  ADDON_TOOL_PACK_PREFIX,
  AGENT_TOOL_PACK_POINT,
  AGENT_TOOL_POINT,
  COMMAND_BUILDER_POINT,
  PACK_READ_POINT,
  agentToolNameProblem,
  agentToolPackRowProblems,
  keepsBareIds,
  reservedToolInputProblem,
  withPackSet,
} from "@permitzip/bim-kernel/packs";
import { CALC_POINT, CODE_EDITION_POINT, PREVIEW_CALC_POINT, SOURCE_SUPPLY_POINT, calcOwner, codeFamilyOwner } from "@permitzip/bim-calc";
import { SPACE_USE_POINT, SPACE_USE_RATE_POINT, SPACE_USE_RATE_VALUE_POINT, spaceUseRateTarget, spaceUseRowSchema } from "@permitzip/bim-library";
import { isCurrencyCode, unitAllowed, unitCandidates } from "@permitzip/bim-units";
import { isKnownRulePack, LINT_RULE_POINT } from "@permitzip/bim-lint";
import { caught, known, type KnownPoint } from "./known-point";

export { declaredPoint, type KnownPoint } from "./known-point";

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

const ADAPTER_FUNCTIONS = ["source", "connectors", "positionsNeeded", "refusal", "positionsRefusal"] as const;

export const KNOWN_POINTS: readonly KnownPoint[] = [
  known(ELEMENT_KIND_POINT, (items, set) => elementKindRowProblems(items, new Set<string>(KERNEL_ELEMENT_KINDS), new Set(set.items(CONNECTOR_END_TYPE_POINT).map((r) => r.id))), null),
  known(CONNECTOR_END_TYPE_POINT, (items) => connectorEndTypeRowProblems(items), null),
  known(PIPE_PRODUCT_POINT, (items, set) => pipeProductRowProblems(items, new Set(connectorEndTypeTable(set).ids)), null),
  known(IFC_IMPORT_RULE_POINT, (items) => importRuleRowProblems(items), null),
  known(
    CLASS_POINT,
    (_items, set) => caught("Element classes", () => packClassRegistry(builtinRegistry(), set)),
    null,
  ),
  known(SERVICE_POINT, (_items, set) => caught("Services", () => withPackServices(BUILTIN_SERVICE_REGISTRY, set)), (row) => serviceRowOwner(row)),
  known(
    NETWORK_ADAPTER_POINT,
    (items) =>
      items.flatMap((item) => {
        const out: string[] = [];
        if (!item.adapter && !item.aggregation && !item.tree && !item.sourcesFor && !item.translate) out.push(`network adapter ${item.id} has neither link rules (adapter), a network to total (aggregation), a connected-element tree (tree), source candidates (sourcesFor) nor a move rule (translate)`);
        if (item.sourcesFor !== undefined && !isFunction(item.sourcesFor)) out.push(`network adapter ${item.id}: sourcesFor must be a function`);
        if (item.translate !== undefined && !isFunction(item.translate)) out.push(`network adapter ${item.id}: translate must be a function`);
        if (item.connect !== undefined && !isFunction(item.connect)) out.push(`network adapter ${item.id}: connect must be a function`);
        if (item.adapter) {
          const missing = ADAPTER_FUNCTIONS.filter((name) => !isFunction(item.adapter?.[name]));
          if (missing.length > 0) out.push(`network adapter ${item.id} is missing ${missing.join(", ")}`);
          if (!(SERVICE_TRADES as readonly string[]).includes(item.adapter.trade)) out.push(`network adapter ${item.id}: its link trade "${item.adapter.trade}" isn't one links can store (${SERVICE_TRADES.join(", ")}); a physical network uses aggregation instead`);
        }
        const agg = item.aggregation;
        if (agg) {
          if (!isFunction(agg.network)) out.push(`network adapter ${item.id}: aggregation has no network`);
          if (agg.solve !== undefined && !isFunction(agg.solve)) out.push(`network adapter ${item.id}: aggregation solve must be a function`);
          if (agg.quantities.length === 0) out.push(`network adapter ${item.id}: aggregation totals no quantity`);
          if (!(KNOWN_AGGREGATION_DIRECTIONS as readonly string[]).includes(agg.direction)) out.push(`network adapter ${item.id}: direction "${agg.direction}" isn't one of ${KNOWN_AGGREGATION_DIRECTIONS.join(", ")}`);
          const odd = agg.over.filter((o) => !(KNOWN_NETWORK_LINKS as readonly string[]).includes(o));
          if (agg.over.length === 0 || odd.length > 0) out.push(`network adapter ${item.id}: over must name ${KNOWN_NETWORK_LINKS.join(" and/or ")}`);
        }
        return out;
      }),
    (item) => networkAdapterOwner(item),
  ),
  known(
    PARAMETER_SET_POINT,
    (items, set, packId) => [
      ...items.flatMap((s) => s.parameters.flatMap((p) => (p.key.startsWith(`${packId}.`) ? [] : [`parameter ${p.key} (in ${s.id}) must start with "${packId}."`]))),
      ...caught("Parameter sets", () => withPackParameters(fieldProviderRegistry(), set)),
    ],
    null,
  ),
  known(
    DERIVED_ZONE_RULE_POINT,
    (items) =>
      items.flatMap((rule) => {
        const out: string[] = [];
        if (!rule.label.trim()) out.push(`derived-zone rule ${rule.id} has no label`);
        if (!isFunction(rule.takes) && !isFunction(rule.derive)) out.push(`derived-zone rule ${rule.id} needs takes or derive`);
        if (rule.dependsOn !== undefined && !isFunction(rule.dependsOn)) out.push(`derived-zone rule ${rule.id}: dependsOn must be a function`);
        return out;
      }),
    (rule) => derivedZoneRuleOwner(rule),
  ),
  known(ZONE_PURPOSE_POINT, (items) => items.flatMap((p) => (p.label.trim() ? [] : [`zone purpose ${p.id} has no label`])), null),
  known(PROPOSER_POINT, (items) => items.flatMap((p) => [...(p.label.trim() ? [] : [`proposer ${p.id} has no label`]), ...(p.hosts.trim() ? [] : [`proposer ${p.id}: say what it hosts on (hosts)`]), ...(isFunction(p.propose) ? [] : [`proposer ${p.id} has no propose`])]), null),
  known(SURFACE_ROLE_POINT, (items) => items.flatMap((r) => [...(r.label.trim() ? [] : [`surface role ${r.id} has no label`]), ...(typeof r.hostsDevices === "boolean" ? [] : [`surface role ${r.id}: say whether devices may be hosted on it (hostsDevices)`])]), null),
  known(
    DISCIPLINE_POINT,
    (items, set) =>
      items.flatMap((d) => [
        ...(d.label.trim() ? [] : [`discipline ${d.id} has no label`]),
        ...(/^#[0-9a-f]{6}$/.test(d.display.colour) ? [] : [`discipline ${d.id}: its colour "${d.display.colour}" isn't #rrggbb`]),
        ...(d.parent === undefined || disciplineDef(d.parent, set) ? [] : [`discipline ${d.id}: its parent "${d.parent}" isn't a registered discipline`]),
        ...(d.parent !== undefined && disciplineAncestors(d.id, set).includes(d.id) ? [`discipline ${d.id} is its own ancestor`] : []),
      ]),
    null,
  ),
  known(
    REQUIREMENTS_SOURCE_POINT,
    (items) =>
      items.flatMap((row) => {
        const d = row.descriptor;
        const out: string[] = [];
        if (!d.label.trim()) out.push(`requirements source ${d.id} has no label`);
        if (!d.version.trim()) out.push(`requirements source ${d.id} has no version`);
        if (d.capabilities.rules !== true) out.push(`requirements source ${d.id} must supply rules (capabilities.rules)`);
        if (d.contract.replace(/^[\^~]/, "").split(".")[0] !== REQUIREMENTS_SOURCE_CONTRACT.split(".")[0]) out.push(`requirements source ${d.id} targets contract ${d.contract}; this kernel reads ${REQUIREMENTS_SOURCE_CONTRACT}`);
        if (!isFunction(row.rules)) out.push(`requirements source ${d.id} has no rules reader`);
        return out;
      }),
    null,
  ),
  known(PIPE_MATERIAL_POINT, (items) => items.flatMap((r) => (r.label.trim() ? [] : [`pipe material ${r.id} has no label`])), null),
  known(
    MEASURE_RULE_POINT,
    (items) =>
      items.flatMap((rule) => {
        const out: string[] = [];
        if (!isFunction(rule.measure)) out.push(`measure rule ${rule.id} has no measure`);
        if ((rule.kinds?.length ?? 0) === 0 && (rule.classes?.length ?? 0) === 0) out.push(`measure rule ${rule.id} names no kind or class to measure`);
        if (rule.measures.length === 0) out.push(`measure rule ${rule.id} lists no measures`);
        for (const m of rule.measures) {
          if (!m.key.startsWith("qto.")) out.push(`measure rule ${rule.id}: measure ${m.key} must be a qto.* key`);
          if (!m.from.trim()) out.push(`measure rule ${rule.id}: say what ${m.key} is measured from`);
          if (!unitCandidates(m.unit).some((u) => u === m.unit)) out.push(`measure rule ${rule.id}: "${m.unit}" isn't a unit code`);
        }
        return out;
      }),
    null,
  ),
  known(
    CLASSIFICATION_POINT,
    (items) =>
      items.flatMap((sys) => {
        const out: string[] = [];
        if (!sys.label.trim()) out.push(`code list ${sys.id} has no label`);
        if (!sys.version.trim()) out.push(`code list ${sys.id} has no version`);
        if (!sys.licenceNote.trim()) out.push(`code list ${sys.id}: say who may use it and under what licence (licenceNote)`);
        const codes = sys.codes ?? [];
        if (new Set(codes.map((c) => c.code)).size !== codes.length) out.push(`code list ${sys.id} lists a code twice`);
        return out;
      }),
    null,
  ),
  known(
    COST_SOURCE_POINT,
    (items) =>
      items.flatMap((src) => {
        const out: string[] = [];
        if (!isFunction(src.rates)) out.push(`price list ${src.id} has no rates`);
        if (!src.party.id.trim()) out.push(`price list ${src.id}: name the company that owns it (party.id)`);
        if (!(KNOWN_COST_PARTIES as readonly string[]).includes(src.party.kind) && !src.party.kind.includes(".")) out.push(`price list ${src.id}: party kind "${src.party.kind}" is neither a known one nor a pack's own (pack.kind)`);
        if (!isCurrencyCode(src.currency)) out.push(`price list ${src.id}: "${src.currency}" isn't a currency code (USD)`);
        if (src.visibility.kind !== "party_only" && src.visibility.kind !== "shared_with") out.push(`price list ${src.id}: visibility must be party_only or shared_with`);
        return out;
      }),
    null,
  ),
  known(FACET_POINT, (items) => caught("Parameter facets", () => withFacetRows(BUILTIN_FACET_REGISTRY, items)), null),
  known(SYMBOL_POINT, (items) => caught("Symbols", () => withSymbolRows(BUILTIN_SYMBOL_REGISTRY, items)), (row) => symbolOwner(row)),
  known(
    COMMAND_POINT,
    (items) =>
      items.flatMap((def) => {
        const literal = def.schema.shape.type;
        const out: string[] = [];
        if (!(literal instanceof z.ZodLiteral) || literal.value !== def.type) out.push(`command ${def.type}: its schema's type must be z.literal("${def.type}")`);
        if (!isFunction(def.execute)) out.push(`command ${def.type} has no execute`);
        return out;
      }),
    null,
  ),
  known(PACK_READ_POINT, (items) => items.flatMap((r) => (isFunction(r.run) ? [] : [`pack read ${r.id} has no run`])), null),
  known(OUTDOOR_AIR_READER_POINT, (items) => items.flatMap((r) => (isFunction(r.space) && isFunction(r.zone) ? [] : [`outdoor-air reader ${r.id} needs space and zone`])), null),
  known(PRESSURE_TARGET_POINT, (items) => items.flatMap((r) => (isFunction(r.target) ? [] : [`pressure targets ${r.id} has no target`])), null),
  known(DRAWN_SOURCE_POINT, (items) => items.flatMap((r) => (isFunction(r.check) ? [] : [`drawn-source check ${r.id} has no check`])), null),
  known(NETWORK_COUPLING_POINT, (items) => items.flatMap((r) => (isFunction(r.couples) && isFunction(r.isOutlet) && (r.carry === undefined || isFunction(r.carry)) ? [] : [`network coupling ${r.id} needs couples and isOutlet`])), null),
  known(FIELD_PROVIDER_POINT, (_items, set) => caught("Field providers", () => withPackSet(set, () => fieldProviderRegistry())), null),
  known(DIAGRAM_GRAPH_POINT, (items) => items.flatMap((d) => (isFunction(d.build) ? [] : [`diagram graph ${d.kind} has no build`])), null),
  known(BLOCK_HOP_POINT, (items) => items.flatMap((h) => (isFunction(h.target) ? [] : [`block hop ${h.id} has no target`])), null),
  known(BLOCK_DEPENDENCY_POINT, (items) => items.flatMap((d) => (isFunction(d.collect) ? [] : [`block dependency ${d.id} has no collect`])), null),
  known(FIELD_RESOLVER_POINT, (items) => items.flatMap((r) => (isFunction(r.resolve) && Number.isFinite(r.resolveRank) && Number.isFinite(r.listRank) ? [] : [`field resolver ${r.id} needs resolve, resolveRank and listRank`])), null),
  known(TAG_STYLE_PRESET_POINT, (_items, set) => caught("Tag style presets", () => withPackSet(set, () => tagStylePresets())), null),
  known(TAG_FIELD_ALIAS_POINT, (items) => items.flatMap((r) => (r.field.trim() && r.reads.length > 0 && r.reads.every((n) => n.trim()) ? [] : [`tag field alias ${r.id} needs a field and the parameters it reads`])), null),
  known(POSITION_POLICY_POINT, (items) => items.flatMap((p) => (isFunction(p.groups) ? [] : [`position policy ${p.id} has no groups`])), null),
  known(BLOCK_TABLE_POINT, (items) => items.flatMap((t) => (isFunction(t.render) && t.title.trim() ? [] : [`block table ${t.kind} needs a title and render`])), null),
  known(FORM_SCHEDULE_POINT, (items) => items.flatMap((f) => (isFunction(f.evaluate) ? [] : [`form schedule ${f.kind} has no evaluate`])), null),
  known(SYSTEM_LABEL_POINT, (items) => items.flatMap((r) => (isFunction(r.label) ? [] : [`system words ${r.id} has no label`])), null),
  known(PIPE_RUN_CHECK_POINT, (items) => items.flatMap((c) => (isFunction(c.segment) || isFunction(c.fitting) ? [] : [`pipe run check ${c.id} needs segment or fitting`])), null),
  known(SERVES_RULE_POINT, (items) => items.flatMap((r) => (isFunction(r.served) && Number.isFinite(r.rank) ? [] : [`serves rule ${r.id} needs served and rank`])), null),
  known(CONNECTION_QUANTITY_CHECK_POINT, (items) => items.flatMap((c) => (isFunction(c.warning) && c.systemKinds.length > 0 ? [] : [`connection quantity check ${c.id} needs warning and systemKinds`])), null),
  known(STARTER_CONNECTION_TYPE_POINT, (items) => items.flatMap((e) => (e.type === "connection_type" && e.designator.trim() ? [] : [`starter connection type ${e.designator} isn't a connection type`])), null),
  known(
    LINT_RULE_POINT,
    (items, set, packId) => {
      // A first-party add-on's rules keep the built-in rule pack they always ran in (rulesets select by it).
      const manifest = set.pack(packId)?.manifest;
      const keepsRulePack = manifest !== undefined && keepsBareIds(manifest);
      return items.flatMap((rule) => {
        const out: string[] = [];
        if (!isFunction(rule.run)) out.push(`lint rule ${rule.id} has no run`);
        if (!Number.isInteger(rule.version) || rule.version < 1) out.push(`lint rule ${rule.id}: version must be a whole number from 1`);
        if (rule.pack !== packId && !(keepsRulePack && isKnownRulePack(rule.pack))) out.push(`lint rule ${rule.id}: pack must be "${packId}" (its rules run in the default and issue checks)`);
        if (!rule.title.trim()) out.push(`lint rule ${rule.id} has no title`);
        if (rule.reads !== undefined && rule.scope !== "element") out.push(`lint rule ${rule.id}: reads is for element rules (it re-runs them when a kind they read changes)`);
        if (rule.rank !== undefined && !Number.isFinite(rule.rank)) out.push(`lint rule ${rule.id}: rank must be a finite number`);
        return out;
      });
    },
    null,
  ),
  known(
    CALC_POINT,
    (items) => items.flatMap((calc) => (isFunction(calc.execute) && typeof calc.info?.version === "string" ? [] : [`calc ${calc.info?.id ?? "(no id)"} needs info and execute (build it with defineCalc)`])),
    (calc) => calcOwner(calc),
  ),
  known(
    PREVIEW_CALC_POINT,
    (items) => items.flatMap((calc) => (isFunction(calc.execute) && typeof calc.info?.version === "string" ? [] : [`preview calc ${calc.info?.id ?? "(no id)"} needs info and execute (build it with defineCalc)`])),
    null,
  ),
  known(SOURCE_SUPPLY_POINT, (items) => items.flatMap((r) => (isFunction(r.read) ? [] : [`source supply ${r.id} has no read`])), null),
  known(
    PART_TYPE_POINT,
    (items) =>
      items.flatMap((row) => {
        const def = row.entry?.definition;
        if (!def) return [`part type ${row.entry?.id ?? "(no id)"} has no definition`];
        return def.familyName.trim() && def.typeName.trim() ? [] : [`part type ${row.entry.id} needs a family and type name`];
      }),
    null,
  ),
  known(
    CODE_EDITION_POINT,
    (items) =>
      items.flatMap((def) => {
        const out: string[] = [];
        if (!isFunction(def.resolve)) out.push(`code family ${def.family} has no resolve`);
        if (def.editions.length === 0) out.push(`code family ${def.family} lists no editions`);
        return out;
      }),
    (def) => codeFamilyOwner(def),
  ),
  known(
    SPACE_USE_RATE_POINT,
    (items) => items.flatMap((t) => (t.quantity.trim() ? [] : [`space-use rate ${t.key} loads onto nothing (quantity is empty)`])),
    null,
  ),
  known(
    SPACE_USE_RATE_VALUE_POINT,
    (items, set) =>
      withPackSet(set, () =>
        items.flatMap((v) => {
          const target = spaceUseRateTarget(v.key);
          if (!target) return [`rate value ${v.key} for ${v.useId}: no rate key ${v.key} is defined`];
          return unitAllowed(target.kind, v.unit) ? [] : [`rate value ${v.key} for ${v.useId}: "${v.unit}" isn't a unit for ${target.label.toLowerCase()}`];
        }),
      ),
    null,
  ),
  known(
    SPACE_USE_POINT,
    (items, set) =>
      withPackSet(set, () =>
        items.flatMap((row) => {
          const parsed = spaceUseRowSchema.safeParse(row);
          const first = parsed.success ? null : parsed.error.issues[0];
          return first ? [`space use ${row.id}: ${first.path.join(".")} ${first.message}`] : [];
        }),
      ),
    null,
  ),
  known(
    AGENT_TOOL_POINT,
    (items, set, packId) => {
      const manifest = set.pack(packId)?.manifest;
      const firstParty = manifest ? keepsBareIds(manifest) : false;
      return items.flatMap((tool) => {
        const out: string[] = [];
        const name = agentToolNameProblem(packId, tool.name, firstParty);
        if (name) out.push(name);
        if (tool.input?.type !== "object") out.push(`agent tool ${tool.name}: input must be a JSON Schema object`);
        else {
          const reserved = reservedToolInputProblem(tool);
          if (reserved) out.push(reserved);
        }
        if (!tool.description.trim()) out.push(`agent tool ${tool.name} has no description`);
        if (tool.pack && !tool.pack.startsWith(ADDON_TOOL_PACK_PREFIX) && !bimPackCatalogue().some((p) => p.id === tool.pack) && !set.packItems(AGENT_TOOL_PACK_POINT).some((p) => p.id === tool.pack)) out.push(`agent tool ${tool.name} names pack "${tool.pack}", which no add-on declares`);
        return out;
      });
    },
    null,
  ),
  known(AGENT_TOOL_PACK_POINT, (items) => items.flatMap((p) => agentToolPackRowProblems(p)), null),
  known(COMMAND_BUILDER_POINT, (items) => items.flatMap((b) => (isFunction(b.build) ? [] : [`command builder ${b.id} has no build`])), null),
  // Contract 1.6.0 (round 8b).
  known(CHANGE_SIGNIFICANCE_POINT, (items) => items.flatMap((k) => changeKindProblems(k)), null),
  known(IDENTITY_PROVIDER_POINT, (items) => caught("Identity providers", () => new IdentityProviderRegistry(items)), null),
  known(QUESTION_OUTCOME_POINT, (items) => items.flatMap((o) => questionOutcomeProblems(o)), null),
  // Contract 1.9.0 (round 11 wave 1): copies, the problem list, stages, confidence, requirement anchors.
  known(LINEAGE_ROLE_POINT, (items) => items.flatMap((r) => lineageRoleProblems(r)), null),
  known(FINDING_SOURCE_POINT, (items) => findingSourceRowProblems(items), null),
  known(LIFECYCLE_STAGE_POINT, (items) => stageProblems(items), null),
  known(STAGE_SET_POINT, (items) => stageProblems([], items), null),
  known(BASIS_POINT, (items) => basisRowProblems(items), null),
  // Contract 1.9.0 (round 11 wave 2, C11): clearance purposes, file readers and writers, add-on quantity kinds.
  known(CLEARANCE_PURPOSE_POINT, (items) => clearancePurposeRowProblems(items), null),
  known(IMPORT_SOURCE_POINT, (items) => importSourceRowProblems(items), null),
  known(EXPORT_TARGET_POINT, (items) => exportTargetRowProblems(items), null),
  known(UNIT_KIND_POINT, (items) => unitKindRowProblems(items), null),
  known(
    GRAPH_ANCHOR_POINT,
    (items) =>
      items.flatMap((row) => [
        ...(GRAPH_OWN_ANCHOR_KINDS.has(row.anchor) ? [`anchor kind ${row.anchor} is one of the graph's own; an add-on registers an anchor kind of its own`] : []),
        ...(row.label.trim().length === 0 ? [`anchor kind ${row.anchor} has no label`] : []),
      ]),
    null,
  ),
  // Contract 1.10.0 (round 12 wave 0): catalog record types, diagram layouts, view graphics, rating kinds,
  // route constraints, fitting families, calculation sheets, design limit defaults and picture intake columns.
  known(CATALOG_ENTRY_POINT, (items) => catalogEntryRowProblems(items), null),
  known(DIAGRAM_LAYOUT_POINT, (items) => diagramLayoutRowProblems(items), null),
  known(VIEW_GRAPHICS_POINT, (items) => viewGraphicsRowProblems(items), null),
  known(RATING_KIND_POINT, (items) => ratingKindRowProblems(items), null),
  known(ROUTE_CONSTRAINT_POINT, (items) => routeConstraintRowProblems(items), null),
  known(FITTING_FAMILY_POINT, (items) => fittingFamilyRowProblems(items), null),
  known(CALC_SHEET_POINT, (items) => calcSheetRowProblems(items), null),
  known(DESIGN_LIMIT_DEFAULT_POINT, (items) => designLimitProblems(items), null),
  known(INTAKE_COLUMN_POINT, (items) => intakeColumnRowProblems(items), null),
  known(LOAD_SECTION_POINT, (items) => loadSectionRowProblems(items), null),
  known(DESIGN_LIMIT_MEASURE_POINT, (items) => designLimitMeasureProblems(items), null),
  // Contract 1.11.0 (round 13 wave 0): datums, line joins, host voids, bounding elements,
  // IFC relationships, connector faces, connection fields and gravity outfalls.
  known(DATUM_POINT, (items) => datumRowProblems(items), null),
  known(LINE_JOIN_POINT, (items) => lineJoinRowProblems(items), null),
  known(HOST_VOID_POINT, (items) => hostVoidRowProblems(items), null),
  known(BOUNDING_ELEMENT_POINT, (items) => boundingElementRowProblems(items), null),
  known(IFC_RELATION_POINT, (items) => ifcRelationRowProblems(items), null),
  known(CONNECTOR_FACE_POINT, (items) => connectorFaceRowProblems(items), null),
  known(CONNECTION_FIELD_POINT, (items) => connectionFieldRowProblems(items), null),
  known(GRAVITY_OUTFALL_POINT, (items) => gravityOutfallRowProblems(items), null),
  known(CLASS_PLAN_GRAPHICS_POINT, (items) => classPlanGraphicsRowProblems(items), null),
  // Contract 1.12.0 (round 14 wave 0): add-on library rows.
  known(LIBRARY_ROWS_POINT, (items) => libraryRowProblems(items), null),
  // Contract 1.13.0 (round 15): bodies by class.
  known(CLASS_SOLIDS_POINT, (items) => classSolidsRowProblems(items), null),
  // Round 16 (batch 16-A): how linked models' IFC categories show in plans.
  known(LINKED_PLAN_DISPLAY_POINT, (items) => linkedPlanDisplayRowProblems(items), null),
  // Architecture follow-ups: starter element types (no "No type" in a new model).
  known(STARTER_ELEMENT_TYPE_POINT, (items) => starterElementTypeRowProblems(items), null),
  // Batch 16-D: linked models' elements as snap, dimension, room-bound and envelope references.
  known(LINKED_REFERENCE_POINT, (items) => linkedReferenceRowProblems(items), null),
  // Wall tops and bases bound to surfaces: the faces a kind offers (slab, ceiling, an add-on's roof).
  known(SURFACE_FACE_POINT, (items) => surfaceFaceRowProblems(items), null),
];

export function knownPoint(id: string, declared: readonly KnownPoint[] = []): KnownPoint | null {
  return KNOWN_POINTS.find((p) => p.id === id) ?? declared.find((p) => p.id === id) ?? null;
}

