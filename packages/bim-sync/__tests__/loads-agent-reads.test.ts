/**
 * @jest-environment node
 *
 * The agent reads a multi-trade connection type per trade ("by_trade"), so it
 * sees the fryer's power, gas and drainage as three needs of one item. A
 * single-trade record reads exactly as before (no new key). On the old code
 * the fryer row has no `by_trade`.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { queryElements } from "../src";

function model(commands: readonly Command[]): ModelState {
  let head: ModelState = { modelId: "reads", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  commands.forEach((command, i) => {
    const d = planCommit(head, [], { idempotencyKey: `reads-${i}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-27T21:00:00.000Z", []);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    head = d.model;
  });
  return head;
}

describe("agent reads: connection types per trade", () => {
  it("the fryer reads Electrical, Gas and Drainage; a receptacle reads as before", () => {
    const m = model([
      { type: "save_connection_type", entry: { designator: "K07", trade: "gas", description: "Fryer", loadVa: 1800, loadClass: "kitchen", quantities: { mbh: 80, dfu: 1 } } },
      { type: "save_connection_type", entry: { designator: "E.05", description: "Receptacle", loadVa: 180 } },
    ]);
    const rows = queryElements(m, { kinds: ["service_catalog"] }).rows;
    const fryer = rows.find((r) => r.facts.what === "connection type K07");
    const rec = rows.find((r) => r.facts.what === "connection type E.05");
    expect(fryer?.facts.by_trade).toBe("Electrical: 120 V, 1 pole, 1,800 VA; Gas: 80 MBH; Drainage: 1 DFU");
    expect(rec?.facts).not.toHaveProperty("by_trade");
  });
});
