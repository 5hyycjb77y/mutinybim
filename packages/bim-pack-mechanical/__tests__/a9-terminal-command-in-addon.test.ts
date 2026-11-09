/**
 * @jest-environment node
 *
 * @mutinybim-bare-kernel: the test setup must not install the first-party
 * add-ons; this file proves what a host without Mechanical says, then
 * installs it.
 *
 * Round 9 lane A9: `set_terminal_cfm`, its `field_equals cfm` intent and the
 * batched terminal runs are the Mechanical add-on's command (same stored
 * name). Without the add-on the kernel refuses it naming Mechanical, knows
 * no airflow, totals nothing and runs no duct check; with it, everything
 * reads as before. Fails on round 8b's code: the command was a kernel
 * command (it ran with no add-on) and the duct checks were kernel code.
 */
import { commandSchema, executeCommand, recomputeDerived, validateModel, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { type DuctSegment } from "@permitzip/bim-pack-mechanical";
import { installFirstPartyPacks, installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK, airflowOf } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const NOT_LOADED = "This model uses Mechanical, which isn't loaded here";

function demoWithShortDuct(): ModelState {
  const demo = createDemoModel("a9-bare");
  const run = demo.elements["seg-run-1"] as DuctSegment;
  // A diagonal 100 mm duct: shorter than the 150 mm minimum, and not orthogonal.
  const short: BimElement = { ...run, end: { x: run.start.x + 70, y: run.start.y + 70 } };
  return { ...demo, elements: { ...demo.elements, [short.id]: short } };
}

describe("a9 the terminal airflow command lives in the Mechanical add-on", () => {
  it("bare kernel: the command is no kernel command, and is refused naming the add-on", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("mechanical");
    const kernelTypes: readonly string[] = commandSchema.options.map((o) => o.shape.type.value);
    expect(kernelTypes).not.toContain("set_terminal_cfm");
    const parsed = commandSchema.safeParse({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([NOT_LOADED]);
    const r = executeCommand(createDemoModel("a9-bare-exec"), { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe(NOT_LOADED);
  });

  it("bare kernel: no airflow is totalled and no duct check runs", () => {
    const model = demoWithShortDuct();
    expect(recomputeDerived(model).changedIds).not.toContain("ahu-1");
    const codes = validateModel(model).filter((i) => i.elementIds.includes(model.elements["seg-run-1"]?.id as BimElement["id"])).map((i) => i.code);
    expect(codes).not.toContain("min_straight_length");
    expect(codes).not.toContain("unsupported_geometry");
  });

  it("with Mechanical: the command runs (alone and batched), the totals sum and the duct checks run", () => {
    installFirstPartyPacks([MECHANICAL_PACK]);
    const head = recomputeDerived(createDemoModel("a9-mech")).model;
    expect(airflowOf(head.elements["ahu-1"] as BimElement)).toBe(650);
    const one = executeCommand(head, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 });
    if (!one.ok) throw new Error(one.error.message);
    expect(airflowOf(one.model.elements["ahu-1"] as BimElement)).toBe(700);
    expect(one.intents).toEqual([{ kind: "field_equals", elementId: "sd-1", field: "cfm", value: 400 }]);
    expect(one.authored).toEqual([{ elementId: "sd-1", field: "cfm", value: 400 }]);
    const batch = executeCommand(head, { type: "batch_edits", commands: [{ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }, { type: "set_terminal_cfm", terminalId: "sd-2", cfm: 310 }] });
    if (!batch.ok) throw new Error(batch.error.message);
    expect(airflowOf(batch.model.elements["ahu-1"] as BimElement)).toBe(720);
    const refused = executeCommand(head, { type: "batch_edits", commands: [{ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }, { type: "set_terminal_cfm", terminalId: "nope", cfm: 310 }] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/^Step 2 of 2 \(set terminal cfm\): /);
    const model = demoWithShortDuct();
    const codes = validateModel(model).filter((i) => i.elementIds.includes(model.elements["seg-run-1"]?.id as BimElement["id"])).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["min_straight_length", "unsupported_geometry"]));
  });
});
