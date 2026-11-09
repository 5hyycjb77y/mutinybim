/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 6 lane P: a process that has the kernel but not the Plumbing and gas
 * add-on (no host installed it) refuses this trade's stored content in plain
 * words, naming the add-on, instead of dropping it: a stack command, a gas
 * schedule, a plumbing riser. Nothing here imports the add-on. On the old
 * tree the kernel installed the plumbing rows itself, so the command ran
 * and nothing named a missing add-on.
 */
import { builtinFormTemplate, commandSchema, DEFAULT_SETTINGS, evaluateFormSchedule, executeCommand, starterConnectionType, type ModelState, type PackCommand } from "@permitzip/bim-kernel";
import { firstPartyStoredOwner, installedFirstPartyPacks, packNotLoadedMessage } from "@permitzip/bim-kernel/packs";

const REFUSAL = "This model uses Plumbing and gas, which isn't loaded here";
const empty: ModelState = { modelId: "bare", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

describe("without the Plumbing and gas add-on", () => {
  it("is not installed in this process", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("plumbing_gas");
    expect(packNotLoadedMessage("plumbing_gas")).toBe(REFUSAL);
  });

  it("refuses a stack command by name, as a check and as an edit", () => {
    const parsed = commandSchema.safeParse({ type: "delete_stacks", stackIds: ["stack-1"] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.message)).toContain(REFUSAL);
    const command: PackCommand = { type: "set_stack_checks", baseClearanceDiameters: 3 };
    const r = executeCommand(empty, command);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe(REFUSAL);
  });

  it("prints a gas schedule as the refusal, not as an empty list", () => {
    // A stored schedule carries its own copy of the template (round 15: the built-in one is the add-on's).
    const stored = { name: "Gas equipment", title: "GAS EQUIPMENT SCHEDULE", header: { columns: 1, fields: [] }, body: { layout: "rows" as const, columns: [{ heading: "ID", value: "{gas_id}" }] }, notes: [] };
    const form = evaluateFormSchedule(empty, { kind: "gas_equipment", template: stored });
    expect(JSON.stringify(form)).toContain(REFUSAL);
  });

  it("a new gas schedule can't start from a built-in template: the add-on that has it says it is off", () => {
    expect(() => builtinFormTemplate("gas_equipment")).toThrow(REFUSAL);
  });

  it("still knows which add-on owns the trade's stored names", () => {
    expect(firstPartyStoredOwner("diagram", "plumbing_riser")).toBe("plumbing_gas");
    expect(firstPartyStoredOwner("form", "gas_connections")).toBe("plumbing_gas");
    expect(starterConnectionType("WC-FT")).toBeNull();
  });
});
