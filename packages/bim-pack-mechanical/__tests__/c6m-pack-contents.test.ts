/**
 * @jest-environment node
 *
 * The Mechanical add-on (round 6, lane M) carries everything the kernel,
 * `bim-calc`, `bim-lint` and `bim-first-party` used to hold for this trade,
 * as rows of the contract's points, and passes the add-on conformance suite.
 * Before the move the package was an empty `export {}`: every count below was
 * zero and there was no `MECHANICAL_PACK` to check.
 */
import {
  AGENT_TOOL_POINT,
  BLOCK_TABLE_POINT,
  CALC_POINT,
  COMMAND_POINT,
  FIELD_PROVIDER_POINT,
  LINT_RULE_POINT,
  NETWORK_ADAPTER_POINT,
  OUTDOOR_AIR_READER_POINT,
  PACK_READ_POINT,
  PRESSURE_TARGET_POINT,
  TAG_STYLE_PRESET_POINT,
  runPackConformance,
  type ExtensionPoint,
} from "@permitzip/bim-pack";
import { DIAGRAM_GRAPH_POINT, DIAGRAM_LAYOUT_POINT } from "@permitzip/bim-kernel";
import { MECHANICAL_MANIFEST } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_ADDON } from "@permitzip/bim-first-party";
import { MECHANICAL_PACK } from "../src";

function count<T>(point: ExtensionPoint<T>): number {
  return MECHANICAL_PACK.contributions.filter((c) => c.pointId === point.id).reduce((n, c) => n + c.items.length, 0);
}

describe("the Mechanical add-on", () => {
  it("is the kernel's Mechanical manifest, and the one the first-party list installs", () => {
    expect(MECHANICAL_PACK.manifest).toEqual(MECHANICAL_MANIFEST);
    expect(MECHANICAL_ADDON).toBe(MECHANICAL_PACK);
  });

  it("contributes the trade's network adapter, fields, tag presets, commands, tables, outdoor-air engine, pressure targets, calcs and lint rules", () => {
    expect(count(NETWORK_ADAPTER_POINT)).toBe(1);
    expect(count(FIELD_PROVIDER_POINT)).toBe(2);
    expect(count(TAG_STYLE_PRESET_POINT)).toBe(4);
    // Round 9 A9: `set_terminal_cfm` came with the terminal kind (its stored name unchanged). Round 11 K11: the three
    // round-1 commands' cases for its kinds (`claims`), which are never parsed under their own type.
    expect(count(COMMAND_POINT)).toBe(6);
    expect(count(BLOCK_TABLE_POINT)).toBe(2);
    expect(count(OUTDOOR_AIR_READER_POINT)).toBe(1);
    expect(count(PRESSURE_TARGET_POINT)).toBe(1);
    expect(count(CALC_POINT)).toBeGreaterThanOrEqual(4);
    // Round 14 M14: the rated-crossing and ceiling-clearance route checks join the four balance rules.
    expect(count(LINT_RULE_POINT)).toBe(6);
    // Round 14 M14: the air schematic is drawn from Mechanical's own graph and layout rows.
    expect(count(DIAGRAM_GRAPH_POINT)).toBe(1);
    expect(count(DIAGRAM_LAYOUT_POINT)).toBe(1);
    // Declared by lane T: none yet (the duct and airflow tools are generic host tools).
    expect(count(AGENT_TOOL_POINT)).toBe(0);
    // Round 13 (K13 step 1.4): the duct schedule's velocity and friction read (`run_performance`).
    // Nov 7: duct size advice for scripts (`mechanical.duct_size`).
    expect(count(PACK_READ_POINT)).toBe(2);
  });

  it("keeps the frozen stored names: command types and block table kinds", () => {
    const rows = MECHANICAL_PACK.contributions.filter((c) => c.pointId === COMMAND_POINT.id).flatMap((c) => c.items);
    const typeOf = (r: unknown) => (typeof r === "object" && r !== null && "type" in r ? r.type : null);
    const claimOf = (r: unknown) => (typeof r === "object" && r !== null && "claims" in r ? r.claims : undefined);
    expect(rows.filter((r) => claimOf(r) === undefined).map(typeOf)).toEqual(["set_run_insulation", "set_pipe_insulation", "set_terminal_cfm"]);
    // The kernel's stored command names stay the kernel's; the add-on claims their cases for its kinds.
    expect(rows.flatMap((r) => (claimOf(r) === undefined ? [] : [claimOf(r)]))).toEqual([
      { command: "slide_branch", kinds: ["tap"] },
      { command: "resize_run", kinds: ["duct_segment"] },
      { command: "move_equipment", kinds: ["equipment"] },
    ]);
    const tables = MECHANICAL_PACK.contributions.filter((c) => c.pointId === BLOCK_TABLE_POINT.id).flatMap((c) => c.items);
    expect(tables.map((t) => (typeof t === "object" && t !== null && "kind" in t ? t.kind : null))).toEqual(["ventilation", "pressurization"]);
  });

  it("passes the add-on conformance suite", () => {
    const r = runPackConformance(MECHANICAL_PACK);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
