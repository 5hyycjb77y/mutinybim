/**
 * @jest-environment node
 *
 * Round 9 lane A9: `kinds:addon_owned`. A peer without it never receives the
 * parameter form: an edit on a model whose peers don't all read it keeps the
 * flat field exactly as round 8b wrote it; once they do, the edited record is
 * lifted into `values` and stamped. A kind no older peer stores at all is
 * refused in the "older server" words. Fails on round 8b's code: the feature,
 * the lift step and the refusal don't exist.
 */
import {
  COMMAND_POINT,
  ELEMENT_KIND_POINT,
  KINDS_ADDON_OWNED_FEATURE,
  executeCommand,
  gatedRecordFeatures,
  guard,
  finish,
  draftElements,
  recomputeDerived,
  withUpgradePolicy,
  withoutUpgrades,
  TrackedReader,
  asElementId,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type PackCommandDef,
} from "@permitzip/bim-kernel";
import { PackSet, bindModelPacks, contribute, definePack, PACK_CONTRACT_VERSION, unbindModelPacks } from "../src/packs";
import { AIRFLOW_KEY, airflowOf } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { clientProtocol, serverProtocol } from "@permitzip/bim-sync";
import { z } from "zod";

const demo = (): ModelState => recomputeDerived(createDemoModel("a9-mixed")).model;
const older = (feature: string) => feature !== KINDS_ADDON_OWNED_FEATURE;
const everyone = () => true;

describe("a9 mixed-version peers", () => {
  it("every client and server of this release advertises kinds:addon_owned", () => {
    expect(gatedRecordFeatures()).toContain(KINDS_ADDON_OWNED_FEATURE);
    expect(clientProtocol().features).toContain(KINDS_ADDON_OWNED_FEATURE);
    expect(serverProtocol().features).toContain(KINDS_ADDON_OWNED_FEATURE);
  });

  it("an older peer connected: the edited terminal keeps its flat cfm, and no record gains values or a stamp", () => {
    const head = demo();
    const r = withUpgradePolicy(older, () => executeCommand(head, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }));
    if (!r.ok) throw new Error(r.error.message);
    for (const id of r.changedIds) {
      const el = r.model.elements[id];
      if (!el) continue;
      expect([id, "values" in el, "schemaVersion" in el]).toEqual([id, false, false]);
      expect(Object.keys(el).sort()).toEqual(Object.keys(head.elements[id] ?? {}).sort());
    }
    const sd1 = r.model.elements["sd-1"];
    expect(sd1 && "cfm" in sd1 ? sd1.cfm : null).toBe(410);
    expect(airflowOf(r.model.elements["ahu-1"] as BimElement)).toBe(710);
  });

  it("every peer reads it: the edited terminal is lifted into the parameter and stamped; the totals are the same", () => {
    const head = demo();
    const r = withUpgradePolicy(everyone, () => executeCommand(head, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }));
    if (!r.ok) throw new Error(r.error.message);
    const sd1 = r.model.elements["sd-1"];
    if (!sd1 || sd1.kind !== "terminal") throw new Error("sd-1");
    expect(sd1.values).toEqual({ [AIRFLOW_KEY]: 410 });
    expect("cfm" in sd1).toBe(false);
    expect(sd1.schemaVersion).toBe(2);
    expect(airflowOf(sd1)).toBe(410);
    expect(airflowOf(r.model.elements["ahu-1"] as BimElement)).toBe(710);
    // An untouched terminal stays as stored.
    expect(r.model.elements["sd-2"]).toEqual(head.elements["sd-2"]);
  });

  it("undo restores the stored record exactly (no upgrade inside undo)", () => {
    const head = demo();
    const r = withoutUpgrades(() => executeCommand(head, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }));
    if (!r.ok) throw new Error(r.error.message);
    expect("values" in (r.model.elements["sd-1"] ?? {})).toBe(false);
  });

  describe("a kind no older peer stores", () => {
    const CAR: ElementKindItem = { kind: "a9mv.car", label: "Elevator car", newForOlderPeers: true };
    const ADD_CAR: PackCommandDef = {
      type: "a9mv_add_car",
      schema: z.object({ type: z.literal("a9mv_add_car"), id: z.string() }).strict(),
      execute: (model, command) =>
        guard(() => {
          const reader = new TrackedReader(model);
          const working = draftElements(model.elements);
          const id = asElementId(String(command.id));
          const record: Record<string, unknown> = { id, version: 1, authoredRev: {}, kind: "a9mv.car" };
          working[id] = record as unknown as BimElement;
          return finish(reader, working, [id], [], () => []);
        }),
    };
    const pack = definePack({ id: "a9mv", name: "Vertical transport (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [CAR]), contribute(COMMAND_POINT, [ADD_CAR])]);

    it("is refused in the older-server words while a peer lacks kinds:addon_owned, and saved once every peer reads it", () => {
      const model = demo();
      bindModelPacks(model.modelId, PackSet.create([pack]));
      try {
        const refused = withUpgradePolicy(older, () => executeCommand(model, { type: "a9mv_add_car", id: "car-1" }));
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.message).toBe("Elevator car can't be saved yet: the model server this model is open on is an older version that doesn't store elevator car records. Try again once the server is updated. Nothing changed");
        const saved = withUpgradePolicy(everyone, () => executeCommand(model, { type: "a9mv_add_car", id: "car-1" }));
        expect(saved.ok).toBe(true);
      } finally {
        unbindModelPacks(model.modelId);
      }
    });
  });
});
