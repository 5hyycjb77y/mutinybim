/**
 * @jest-environment node
 *
 * Round 11 lane K11: a kernel command's case for a kind an add-on owns runs
 * in that add-on (`PackCommandDef.claims`). `slide_branch`, `resize_run` and
 * `move_equipment` keep their stored names and intents; their tap, duct and
 * unit cases now live in the Mechanical add-on, and any add-on can claim the
 * same commands for its own kinds with no kernel edit. A def that claims is
 * never a command of its own type, and two add-ons can't claim one case.
 *
 * Fails on round 10's code: `claims` didn't exist; the duct halves were
 * kernel switch cases, so a test add-on's kind was refused "is a k11vt.car,
 * expected equipment" and the Mechanical add-on claimed nothing.
 */
import { z } from "zod";
import {
  commandSchema,
  claimedCommandCase,
  elementsOfKind,
  executeCommand,
  freezeElements,
  recomputeDerived,
  type BimElement,
  type ExecuteResult,
  type ModelState,
  type PackCommand,
  type PackCommandDef,
} from "../src";
import { COMMAND_POINT, ELEMENT_KIND_POINT } from "../src";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";
import { MECHANICAL_LEGACY_COMMANDS } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const demo = (): ModelState => recomputeDerived(createDemoModel("k11-claims")).model;

function first(model: ModelState, kind: string): BimElement {
  const el = elementsOfKind(model.elements, kind as BimElement["kind"])[0];
  if (!el) throw new Error(`the demo model has no ${kind}`);
  return el;
}

/** A conveying add-on: its car moves through `move_equipment`, the kernel's own command. */
const seen: PackCommand[] = [];
const MOVE_CAR: PackCommandDef = {
  type: "move_equipment.k11vt_car",
  schema: z.object({ type: z.literal("move_equipment.k11vt_car"), equipmentId: z.string(), delta: z.object({ x: z.number(), y: z.number() }) }).strict(),
  claims: { command: "move_equipment", kinds: ["k11vt.car"] },
  execute(_model, command): ExecuteResult {
    seen.push(command);
    return { ok: false, error: { code: "invalid_value", message: `the car add-on ran ${command.type}`, elementIds: [] } };
  },
};
const CONVEYING = definePack({ id: "k11vt", name: "K11 conveying", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
  contribute(ELEMENT_KIND_POINT, [{ kind: "k11vt.car", label: "Elevator car", nature: "physical" }]),
  contribute(COMMAND_POINT, [MOVE_CAR]),
]);

function withCar(model: ModelState): ModelState {
  const car = { id: "CAR-1", version: 1, authoredRev: {}, kind: "k11vt.car", position: { x: 0, y: 0 } } as unknown as BimElement;
  return { ...model, elements: freezeElements({ ...model.elements, [car.id]: car }) };
}

describe("k11 PackCommandDef.claims", () => {
  it("the tap, duct and unit cases of the three round-1 commands are the Mechanical add-on's", () => {
    expect(claimedCommandCase("slide_branch", "tap")?.type).toBe("slide_branch.tap");
    expect(claimedCommandCase("resize_run", "duct_segment")?.type).toBe("resize_run.duct_segment");
    expect(claimedCommandCase("move_equipment", "equipment")?.type).toBe("move_equipment.equipment");
    expect(claimedCommandCase("slide_branch", "run_fitting")).toBeNull();
  });

  it("the kernel command runs the add-on's case, with the same answer as calling the case directly", () => {
    const m = demo();
    const tap = first(m, "tap");
    const seg = first(m, "duct_segment");
    const unit = first(m, "equipment");
    const commands = [
      { type: "slide_branch", tapId: tap.id, s: 1500 },
      { type: "resize_run", segmentId: seg.id, profile: { shape: "rect", width: 500, height: 300 } },
      { type: "move_equipment", equipmentId: unit.id, delta: { x: 0, y: 100 } },
    ] as const;
    commands.forEach((command, i) => {
      const viaKernel = executeCommand(m, command);
      const def = MECHANICAL_LEGACY_COMMANDS[i];
      if (!def) throw new Error("missing def");
      const direct = withPackSet(null, () => def.execute(m, command, {}));
      expect(JSON.stringify(viaKernel)).toBe(JSON.stringify(direct));
      expect(viaKernel.ok).toBe(true);
    });
  });

  it("an outside add-on claims a kernel command for its own kind with no kernel edit", () => {
    const m = withCar(demo());
    seen.length = 0;
    const r = withPackSet(PackSet.create([CONVEYING]), () => executeCommand(m, { type: "move_equipment", equipmentId: "CAR-1", delta: { x: 1, y: 2 } }));
    expect(r).toEqual({ ok: false, error: { code: "invalid_value", message: "the car add-on ran move_equipment", elementIds: [] } });
    expect(seen).toEqual([{ type: "move_equipment", equipmentId: "CAR-1", delta: { x: 1, y: 2 } }]);
    // Without its add-on the car is a kind no one handles the command for (Mechanical is loaded, so it isn't "not loaded").
    const without = executeCommand(m, { type: "move_equipment", equipmentId: "CAR-1", delta: { x: 1, y: 2 } });
    expect(without).toEqual({ ok: false, error: { code: "wrong_kind", message: "CAR-1 is a k11vt.car, and no add-on on this model handles move equipment for one", elementIds: ["CAR-1"] } });
  });

  it("a def that claims is never parsed under its own type, and the stored command keeps its kernel name", () => {
    expect(commandSchema.safeParse({ type: "slide_branch.tap", tapId: "T", s: 1 }).success).toBe(false);
    const m = demo();
    const tap = first(m, "tap");
    const parsed = commandSchema.safeParse({ type: "slide_branch", tapId: tap.id, s: 1500 });
    expect(parsed.success && parsed.data.type).toBe("slide_branch");
    // As a batch step too.
    const batch = executeCommand(m, { type: "batch_edits", commands: [{ type: "slide_branch", tapId: tap.id, s: 1500 }] });
    expect(batch.ok).toBe(true);
  });

  it("refuses, loudly, two add-ons claiming one case, a claim on a kernel kind and a claim on a command that can't be claimed", () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const m = demo();
      const tap = first(m, "tap");
      const pack = (id: string, def: PackCommandDef) => definePack({ id, name: id, version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(COMMAND_POINT, [def])]);
      const twice = pack("k11twice", { ...MOVE_CAR, type: "slide_branch.k11twice", schema: z.object({ type: z.literal("slide_branch.k11twice") }).strict(), claims: { command: "slide_branch", kinds: ["tap"] } });
      expect(() => withPackSet(PackSet.create([twice]), () => executeCommand(m, { type: "slide_branch", tapId: tap.id, s: 1500 }))).toThrow("pack commands slide_branch.tap and slide_branch.k11twice both claim slide_branch for tap");
      const wall = pack("k11wall", { ...MOVE_CAR, type: "move_equipment.k11wall", schema: z.object({ type: z.literal("move_equipment.k11wall") }).strict(), claims: { command: "move_equipment", kinds: ["wall"] } });
      expect(() => withPackSet(PackSet.create([wall]), () => executeCommand(m, { type: "slide_branch", tapId: tap.id, s: 1500 }))).toThrow("claims move_equipment for wall, one of the kernel's own kinds");
      const tag = pack("k11tag", { ...MOVE_CAR, type: "move_tag.k11tag", schema: z.object({ type: z.literal("move_tag.k11tag") }).strict(), claims: { command: "move_tag", kinds: ["k11vt.car"] } });
      expect(() => withPackSet(PackSet.create([tag]), () => executeCommand(m, { type: "slide_branch", tapId: tap.id, s: 1500 }))).toThrow('claims "move_tag", which isn\'t a kernel command an add-on may claim');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
