/**
 * @jest-environment node
 *
 * Round 14 P14: tank water heaters are loads. The gas tank heater's starter
 * connection type carries its input (199 MBH at 0.25 psi minimum inlet), and
 * a new electric tank heater carries 4,500 VA at 240 V (the connection
 * fields Electrical reads), so a placed heater counts on the gas or
 * electrical side the way the tankless ones already did.
 *
 * Fails on round 13: WH-T had sizes only (no MBH) and there was no electric
 * tank heater.
 */
import { DEFAULT_SETTINGS, connectionFieldValue, executeCommand, partConnectionTypeLoad, planCommit, starterConnectionType, type Command, type ModelState } from "@permitzip/bim-kernel";
import { plumbingStarterTypes } from "../src";

const NOW = () => "2026-11-04T12:00:00.000Z";

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `p14t-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "rowan", name: "Rowan", kind: "human" }, command }, NOW, []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const typeOf = (slug: string) => {
  const e = plumbingStarterTypes("test").find((t) => t.id === `builtin:plumbing-${slug}@1`);
  if (!e) throw new Error(`no ${slug}`);
  return e;
};

describe("p14-tank-heater-load", () => {
  it("the gas tank heater's starter carries its input", () => {
    const wh = starterConnectionType("WH-T");
    expect(wh?.trade).toBe("gas");
    expect(wh?.quantities?.mbh).toBe(199);
    expect(wh?.quantities?.min_inlet_pressure).toBe(0.25);
  });

  it("the electric tank heater carries 4,500 VA at 240 V, continuous", () => {
    const wh = starterConnectionType("WH-E");
    if (!wh) throw new Error("no WH-E");
    const rec = wh as unknown as Record<string, unknown>;
    expect([connectionFieldValue(rec, "loadVa"), connectionFieldValue(rec, "voltage"), connectionFieldValue(rec, "poles"), connectionFieldValue(rec, "continuous")]).toEqual([4500, 240, 2, true]);
    const part = typeOf("water-heater-electric-tank").definition;
    expect(part.typeValues.heater_kind).toBe("tank");
    expect(part.connectors.map((c) => c.id)).toEqual(["cw", "hw", "power"]);
  });

  it("a placed gas tank heater counts 199 MBH on its gas connector at once: placing it adds its starter type (SC15)", () => {
    let m: ModelState = { modelId: "wh", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const tank = typeOf("water-heater-tank");
    m = commit(m, { type: "place_part", partId: "wh-1", typeId: tank.id, partType: tank.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "WH-1" });
    const part = m.elements["wh-1"];
    if (part?.kind !== "part") throw new Error("not placed");
    expect(partConnectionTypeLoad(m.elements, part, "natural_gas")).toBe(199);
    // Saving the same starter type again (Connection types) keeps the figure.
    const wh = starterConnectionType("WH-T");
    if (!wh) throw new Error("no WH-T");
    const saved = executeCommand(m, { type: "save_connection_type", entry: wh } as Command);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(partConnectionTypeLoad(saved.model.elements, part, "natural_gas")).toBe(199);
  });
});
