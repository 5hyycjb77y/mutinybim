/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 6 lane E: a process without the Electrical add-on refuses electrical
 * content in words instead of dropping it. A stored `place_service_layout`
 * edit, alone or as a batch step, is refused with "This model uses
 * Electrical, which isn't loaded here"; the starter electrical types aren't
 * offered; once the add-on is installed the same bytes parse and run. Before
 * the move the kernel carried electrical itself, so a bare kernel accepted it.
 */
import { builtinPartType, builtinPartTypes, commandSchema, executeCommand } from "@permitzip/bim-kernel";
import { installFirstPartyPacks, installedFirstPartyPacks, packNotLoadedMessage } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK, electricalStarterTypes, planServiceLayout } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const NOT_LOADED = "This model uses Electrical, which isn't loaded here";

// A stored edit as a model's history keeps it (written by a process that had the add-on).
const STORED = JSON.stringify({
  type: "place_service_layout",
  label: "Service layout: 400A 120/208 V 3-phase 4-wire, MDP",
  levelId: "lvl-1",
  partTypes: [],
  equipment: [{ partId: "svc-mdp", typeId: "builtin:panelboard-225@1", position: { x: 0, y: 0 }, values: { panel_name: "MDP" } }],
  feeders: [],
});

function messages(raw: unknown): string[] {
  const r = commandSchema.safeParse(raw);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("c6e: without the Electrical add-on", () => {
  it("starts with no first-party add-on in this process", () => {
    expect(installedFirstPartyPacks()).toEqual([]);
    expect(packNotLoadedMessage("electrical")).toBe(NOT_LOADED);
  });

  it("refuses a stored service layout in words, alone and as a batch step", () => {
    expect(messages(JSON.parse(STORED))).toEqual([NOT_LOADED]);
    expect(messages({ type: "batch_edits", label: "Service", commands: [JSON.parse(STORED)] })).toEqual([NOT_LOADED]);
  });

  it("offers no starter electrical types", () => {
    const ids = electricalStarterTypes("v").map((t) => t.id);
    expect(builtinPartTypes().some((t) => ids.includes(t.id))).toBe(false);
    expect(builtinPartType(ids[0] as string)).toBeUndefined();
  });

  it("parses and runs the same bytes once the add-on is installed", () => {
    installFirstPartyPacks([ELECTRICAL_PACK]);
    const r = commandSchema.safeParse(JSON.parse(STORED));
    expect(r.success).toBe(true);
    expect(r.success ? JSON.stringify(r.data) : null).toBe(STORED);
    expect(builtinPartType(electricalStarterTypes("v")[0]?.id as string)).toBeDefined();
    const b = new Building();
    const plan = planServiceLayout(b.head, { levelId: "lvl-1", serviceA: 400, system: "208Y/120", equipment: [{ kind: "panel", name: "L1", fedFrom: "MDP", busA: 225 }] });
    if (!plan.ok) throw new Error(plan.reason);
    expect(executeCommand(b.head, plan.command).ok).toBe(true);
  });
});
