/**
 * @jest-environment node
 *
 * Round 6 lane P: the Plumbing and gas add-on is one pack built through the
 * contract. Its manifest is the first-party one (id, name, version,
 * description unchanged), it carries every row the kernel used to hold for
 * this trade, it is the pack the host installs, and it passes conformance.
 * On the old tree the pack was the kernel's transitional one, with no calcs,
 * part types, starters, run checks, serves walk, system words or agent tools.
 */
import { AGENT_TOOL_POINT, PACK_READ_POINT, runPackConformance } from "@permitzip/bim-pack";
import { installedFirstPartyPacks, PLUMBING_GAS_MANIFEST } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_ADDON } from "@permitzip/bim-first-party";
import { PLUMBING_AGENT_TOOLS, PLUMBING_CALCS, PLUMBING_GAS_PACK, PLUMBING_STARTER_CONNECTION_TYPES } from "../src";

const byPoint = (id: string) => PLUMBING_GAS_PACK.contributions.filter((c) => c.pointId === id).flatMap((c) => c.items);

describe("the Plumbing and gas add-on", () => {
  it("keeps the first-party manifest", () => {
    expect(PLUMBING_GAS_PACK.manifest).toEqual(PLUMBING_GAS_MANIFEST);
    expect(PLUMBING_GAS_PACK.manifest).toMatchObject({ id: "plumbing_gas", name: "Plumbing and gas", firstParty: true });
  });

  it("is the pack every host installs", () => {
    expect(PLUMBING_GAS_ADDON).toBe(PLUMBING_GAS_PACK);
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).toEqual(["electrical", "plumbing_gas", "mechanical", "fire_protection", "architecture", "struct"]);
    expect(installedFirstPartyPacks()[1]).toBe(PLUMBING_GAS_PACK);
  });

  it("contributes every row of the trade", () => {
    const points = new Set(PLUMBING_GAS_PACK.contributions.map((c) => c.pointId));
    expect([...points].sort()).toEqual(
      [
        "calc.calc",
        "kernel.agent_tool",
        "kernel.block_table",
        "kernel.command",
        "kernel.connection_quantity_check",
        "kernel.connector_end_type",
        "kernel.diagram_graph",
        "kernel.discipline",
        "kernel.drawn_source",
        "kernel.field_provider",
        "kernel.field_resolver",
        "kernel.form_schedule",
        "kernel.gravity_outfall",
        "kernel.library_rows",
        "kernel.linked_plan_display",
        "kernel.measure_rule",
        "kernel.network_adapter",
        "kernel.network_coupling",
        "kernel.pack_read",
        "kernel.part_type",
        "kernel.pipe_product",
        "kernel.pipe_run_check",
        "kernel.serves_rule",
        "kernel.starter_connection_type",
        "kernel.system_label",
        "kernel.tag_style_preset",
        "lint.rule",
        // Round 12: calculation sheets, catalog rows (pipe types, plumbing settings), design limit defaults,
        // fitting families, load sections and service rows, each moved out of the kernel or new.
        "kernel.calc_sheet",
        "kernel.catalog_entry",
        "kernel.design_limit_default",
        "kernel.fitting_family",
        "kernel.load_section",
        "kernel.service",
        "kernel.view_graphics",
        // Round 14: the riser and isometric layouts, moved out of the kernel.
        "kernel.diagram_layout",
        // Round 14 P14: water velocity on the design-limit point; cleanouts proposed on a drain.
        "kernel.design_limit_measure",
        "kernel.proposer",
      ].sort(),
    );
    expect(byPoint("kernel.pipe_product").length).toBe(15);
    expect(byPoint("kernel.command").map((c) => (c as { type: string }).type)).toEqual(["name_stacks", "edit_stack", "delete_stacks", "set_stack_checks"]);
    expect(byPoint("kernel.diagram_graph").map((d) => (d as { kind: string }).kind)).toEqual(["plumbing_riser", "plumbing_isometric"]);
    expect(byPoint("kernel.diagram_layout").map((d) => (d as { kind: string }).kind)).toEqual(["plumbing_riser", "plumbing_isometric"]);
    expect(byPoint("kernel.form_schedule").map((f) => (f as { kind: string }).kind)).toEqual(["gas_equipment", "gas_connections"]);
    expect(byPoint("calc.calc")).toEqual([...PLUMBING_CALCS]);
    expect(byPoint("kernel.starter_connection_type")).toEqual([...PLUMBING_STARTER_CONNECTION_TYPES]);
    expect(byPoint(AGENT_TOOL_POINT.id)).toEqual([...PLUMBING_AGENT_TOOLS]);
    expect(byPoint(PACK_READ_POINT.id).length).toBeGreaterThan(0);
    expect(byPoint("kernel.part_type").length).toBeGreaterThan(0);
  });

  it("passes conformance", () => {
    expect(runPackConformance(PLUMBING_GAS_PACK)).toEqual({ ok: true, problems: [] });
  });
});
