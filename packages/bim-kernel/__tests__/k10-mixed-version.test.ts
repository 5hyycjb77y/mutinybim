/**
 * @jest-environment node
 *
 * Round 10 lane K10: `kinds:addon_shapes`. A peer that doesn't read
 * add-on-declared shapes and ends never receives a record of a new such kind:
 * creating one is refused in the "older server" words until every peer
 * advertises the feature (tolerant readers, strict writers). A writer never
 * stores a record of a shaped kind without its shape. The five kinds every
 * peer has stored since round 1 are unaffected: an edit with an older peer
 * connected writes them exactly as round 9 did (no new field, no stamp).
 *
 * Fails on round 9's code: the feature, the `upgrade` and `shape` faces and
 * the strict shape check don't exist.
 */
import {
  COMMAND_POINT,
  ELEMENT_KIND_POINT,
  KINDS_ADDON_OWNED_FEATURE,
  KINDS_ADDON_SHAPES_FEATURE,
  TrackedReader,
  asElementId,
  draftElements,
  executeCommand,
  finish,
  guard,
  recomputeDerived,
  upgradeFeatureOf,
  withUpgradePolicy,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type PackCommandDef,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, bindModelPacks, contribute, definePack, PACK_CONTRACT_VERSION, unbindModelPacks } from "../src/packs";
import { z } from "zod";

const demo = (): ModelState => recomputeDerived(createDemoModel("k10-mixed")).model;
const olderShapes = (feature: string) => feature !== KINDS_ADDON_SHAPES_FEATURE;
const everyone = () => true;

const CAR: ElementKindItem = {
  kind: "k10mv.car",
  label: "Elevator car",
  shape: { fields: [{ name: "position", form: "point" }, { name: "depth", form: "number", optional: true }] },
  connectorEnds: { root: true, ends: [{ end: "rope", role: "downstream" }] },
  upgrade: { newForOlderPeers: true },
};

const ADD_CAR: PackCommandDef = {
  type: "k10mv_add_car",
  schema: z.object({ type: z.literal("k10mv_add_car"), id: z.string(), withShape: z.boolean() }).strict(),
  execute: (model, command) =>
    guard(() => {
      const reader = new TrackedReader(model);
      const working = draftElements(model.elements);
      const id = asElementId(String(command.id));
      const raw: Record<string, unknown> = { id, version: 1, authoredRev: {}, kind: "k10mv.car" };
      if (command.withShape === true) raw.position = { x: 0, y: 0 };
      working[id] = raw as unknown as BimElement;
      return finish(reader, working, [id], [], () => []);
    }),
};

const VT = definePack({ id: "k10mv", name: "Vertical transport (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [CAR]), contribute(COMMAND_POINT, [ADD_CAR])]);

function bound<R>(model: ModelState, fn: () => R): R {
  bindModelPacks(model.modelId, PackSet.create([VT]));
  try {
    return fn();
  } finally {
    unbindModelPacks(model.modelId);
  }
}

describe("k10-mixed-version", () => {
  it("a kind with a shape or ends waits for kinds:addon_shapes; one with only values for kinds:addon_owned; a row may name its own", () => {
    expect(upgradeFeatureOf(CAR)).toBe(KINDS_ADDON_SHAPES_FEATURE);
    expect(upgradeFeatureOf({ kind: "k10mv.v", label: "V", values: [] })).toBe(KINDS_ADDON_OWNED_FEATURE);
    expect(upgradeFeatureOf({ ...CAR, upgrade: { newForOlderPeers: true, feature: "k10mv:cars" } })).toBe("k10mv:cars");
  });

  it("a new car is refused in the older-server words while a peer lacks kinds:addon_shapes, and saved once every peer reads it", () => {
    const model = demo();
    bound(model, () => {
      const refused = withUpgradePolicy(olderShapes, () => executeCommand(model, { type: "k10mv_add_car", id: "car-1", withShape: true }));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toBe("Elevator car can't be saved yet: the model server this model is open on is an older version that doesn't store elevator car records. Try again once the server is updated. Nothing changed");
      const saved = withUpgradePolicy(everyone, () => executeCommand(model, { type: "k10mv_add_car", id: "car-1", withShape: true }));
      if (!saved.ok) throw new Error(saved.error.message);
    });
  });

  it("strict writer: a car without its position is refused in words, even when every peer reads the feature", () => {
    const model = demo();
    bound(model, () => {
      const r = withUpgradePolicy(everyone, () => executeCommand(model, { type: "k10mv_add_car", id: "car-1", withShape: false }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe("This elevator car is missing part of its shape (it needs position). Nothing changed");
    });
  });

  it("tolerant reader: a stored car missing its shape is kept, and an unrelated edit leaves it alone", () => {
    const base = demo();
    const raw: Record<string, unknown> = { id: "car-1", version: 1, authoredRev: {}, kind: "k10mv.car" };
    const model: ModelState = { ...base, elements: { ...base.elements, "car-1": raw as unknown as BimElement } };
    bound(model, () => {
      const r = withUpgradePolicy(everyone, () => executeCommand(model, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 }));
      if (!r.ok) throw new Error(r.error.message);
      expect(JSON.stringify(r.model.elements["car-1"])).toBe(JSON.stringify(raw));
    });
  });

  it("with an older peer connected, edits on the five round-1 kinds write exactly what round 9 wrote (no new field, no stamp)", () => {
    const head = demo();
    for (const command of [
      { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 },
      { type: "move_equipment", equipmentId: "ahu-1", delta: { x: 100, y: 0 } },
    ]) {
      const r = withUpgradePolicy((f) => f !== KINDS_ADDON_SHAPES_FEATURE && f !== KINDS_ADDON_OWNED_FEATURE, () => executeCommand(head, command));
      if (!r.ok) throw new Error(r.error.message);
      for (const id of r.changedIds) {
        const before = head.elements[id];
        const after = r.model.elements[id];
        if (!before || !after) continue;
        expect([id, Object.keys(after).sort()]).toEqual([id, Object.keys(before).sort()]);
      }
    }
  });
});
