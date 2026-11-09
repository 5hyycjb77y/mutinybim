/**
 * @jest-environment node
 *
 * Round 6 lane E: the Electrical add-on carries the trade. Its manifest is
 * the kernel's first-party Electrical manifest, it contributes every row the
 * kernel used to hold (commands, adapter, zones, fields, diagrams, symbols,
 * blocks, forms, presets, positions, demand rules, calcs, part types, agent
 * tools) and it passes the conformance suite. Before: the package held only
 * agent-tool declarations and contributed nothing.
 */
import { CALC_POINT, PREVIEW_CALC_POINT, SOURCE_SUPPLY_POINT, builtinCalcRegistry } from "@permitzip/bim-calc";
import { ELECTRICAL_ADDON, FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";
import {
  BLOCK_DEPENDENCY_POINT,
  BLOCK_HOP_POINT,
  COMMAND_POINT,
  DERIVED_ZONE_RULE_POINT,
  DIAGRAM_GRAPH_POINT,
  FIELD_PROVIDER_POINT,
  FIELD_RESOLVER_POINT,
  FORM_SCHEDULE_POINT,
  NETWORK_ADAPTER_POINT,
  PART_TYPE_POINT,
  POSITION_POLICY_POINT,
  SYMBOL_POINT,
  TAG_STYLE_PRESET_POINT,
  builtinPartType,
  builtinPartTypes,
  supersededBuiltinPartTypes,
} from "@permitzip/bim-kernel";
import { AGENT_TOOL_POINT, ELECTRICAL_MANIFEST, PACK_READ_POINT, installedFirstPartyPacks, type ExtensionPoint } from "@permitzip/bim-kernel/packs";
import { runPackConformance } from "@permitzip/bim-pack";
import { declaredPoint } from "@permitzip/bim-pack/runtime";
import { LOAD_SECTION_POINT, loadSectionRowProblems } from "@permitzip/bim-kernel";
import {
  DEMAND_RULE_SET_POINT,
  ELECTRICAL_AGENT_TOOLS,
  ELECTRICAL_CALCS,
  ELECTRICAL_CONTRIBUTIONS,
  ELECTRICAL_PACK,
  ELECTRICAL_POINTS,
  LINK_TYPE_CATALOG_POINT,
  PREVIEW_ELECTRICAL_CALCS,
  electricalStarterTypes,
  supersededElectricalStarterTypes,
} from "@permitzip/bim-pack-electrical";

function itemsAt(point: Pick<ExtensionPoint<unknown>, "id">): readonly unknown[] {
  return ELECTRICAL_PACK.contributions.filter((c) => c.pointId === point.id).flatMap((c) => c.items);
}

describe("c6e: the Electrical add-on's contents", () => {
  it("is the first-party Electrical pack every host installs, first in first-party order", () => {
    expect(ELECTRICAL_PACK.manifest).toEqual(ELECTRICAL_MANIFEST);
    expect(ELECTRICAL_ADDON).toBe(ELECTRICAL_PACK);
    expect(FIRST_PARTY_ADDONS[0]).toBe(ELECTRICAL_PACK);
    expect(installedFirstPartyPacks()[0]).toBe(ELECTRICAL_PACK);
    expect(ELECTRICAL_PACK.contributions).toEqual(ELECTRICAL_CONTRIBUTIONS);
  });

  it("contributes at every point the kernel's electrical rows used to fill", () => {
    const counts = Object.fromEntries(
      [COMMAND_POINT, NETWORK_ADAPTER_POINT, DERIVED_ZONE_RULE_POINT, LINK_TYPE_CATALOG_POINT, FIELD_PROVIDER_POINT, DIAGRAM_GRAPH_POINT, SYMBOL_POINT, BLOCK_HOP_POINT, BLOCK_DEPENDENCY_POINT, FORM_SCHEDULE_POINT, FIELD_RESOLVER_POINT, TAG_STYLE_PRESET_POINT, POSITION_POLICY_POINT, DEMAND_RULE_SET_POINT, CALC_POINT, PREVIEW_CALC_POINT, SOURCE_SUPPLY_POINT, PART_TYPE_POINT, AGENT_TOOL_POINT, PACK_READ_POINT].map((p) => [p.id, itemsAt(p).length]),
    );
    for (const [id, n] of Object.entries(counts)) expect({ id, contributes: n > 0 }).toEqual({ id, contributes: true });
    expect(itemsAt(COMMAND_POINT).map((c) => (c as { type: string }).type)).toEqual(["place_service_layout"]);
    expect(itemsAt(DIAGRAM_GRAPH_POINT).map((d) => (d as { kind: string }).kind)).toEqual(["one_line", "electrical_riser"]);
    expect(itemsAt(CALC_POINT)).toEqual([...ELECTRICAL_CALCS]);
    expect(itemsAt(PREVIEW_CALC_POINT)).toEqual([...PREVIEW_ELECTRICAL_CALCS]);
    expect(itemsAt(AGENT_TOOL_POINT)).toEqual([...ELECTRICAL_AGENT_TOOLS]);
    expect(itemsAt(DEMAND_RULE_SET_POINT).map((r) => (r as { id: string }).id)).toEqual(expect.arrayContaining(["nec-2020", "nec-2023"]));
  });

  it("passes the conformance suite", () => {
    // Round 12: the kernel's load-section point is declared here until the coordinator lists it in KNOWN_POINTS (e12 notes).
    const loadSections = declaredPoint(LOAD_SECTION_POINT, (items) => loadSectionRowProblems(items));
    expect(runPackConformance(ELECTRICAL_PACK, { points: [...ELECTRICAL_POINTS, loadSections] })).toEqual({ ok: true, problems: [] });
  });

  it("serves its calcs from the calc registry, the preview only when asked for", () => {
    const listed = new Set(builtinCalcRegistry().list().map((c) => c.id));
    for (const calc of ELECTRICAL_CALCS) expect(listed.has(calc.info.id)).toBe(true);
    for (const calc of PREVIEW_ELECTRICAL_CALCS) {
      expect(builtinCalcRegistry().get(calc.info.id)).toBeNull();
      expect(builtinCalcRegistry({ preview: true }).get(calc.info.id)).toBe(calc);
    }
  });

  it("offers its starter part types right after the kernel's own, with the same ids, and keeps earlier versions readable", () => {
    const offered = builtinPartTypes().map((t) => t.id);
    const starters = electricalStarterTypes("v").map((t) => t.id);
    const at = offered.indexOf(starters[0] as string);
    expect(at).toBeGreaterThan(0);
    expect(offered.slice(at, at + starters.length)).toEqual(starters);
    // The kernel's own rows come first (the generic diffusers through the lavatory), exactly as the library listed them before.
    expect(offered.slice(0, at)).toEqual([
      "builtin:supply-diffuser-24@1",
      "builtin:return-grille-24@1",
      "builtin:exhaust-grille-12@1",
      "builtin:rtu-5-ton@2",
      "builtin:inline-fan-10@1",
      "builtin:inline-fan-oa-10@1",
      "builtin:vav-8@2",
      "builtin:duplex-receptacle@1",
      "builtin:junction-box-4sq@1",
      "builtin:panelboard-225@1",
      "builtin:troffer-2x4-led@1",
      "builtin:water-closet-floor@1",
      "builtin:lavatory-wall@1",
    ]);
    const superseded = supersededBuiltinPartTypes().map((t) => t.id);
    expect(superseded).toEqual(["builtin:rtu-5-ton@1", "builtin:vav-8@1", ...supersededElectricalStarterTypes("v").map((t) => t.id)]);
    for (const id of [...starters, ...superseded]) expect(builtinPartType(id)?.id).toBe(id);
  });
});
