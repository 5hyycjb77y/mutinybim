/**
 * @jest-environment node
 *
 * Round 10 lane K10 (FOUNDATION-REVIEW §4.1): the element-kind row admits
 * records that are never drawn. A test site add-on registers a site
 * constraint (`nature: "intent"`, one value, no shape, no ends, no anchor):
 * the row passes conformance, a pack command saves one, the store, the
 * network index, validation and the derived pass keep it, and an older peer
 * (a set without the add-on) keeps it byte for byte through an unrelated
 * edit. The faces are checked: only a physical kind has ends, a nature is
 * one the kernel names or namespaced.
 *
 * Fails on round 9's code: the row has no `nature`, and its conformance has
 * no face checks (a record kind with connector ends, or a nature like
 * "Building", passed).
 */
import {
  COMMAND_POINT,
  ELEMENT_KIND_POINT,
  KERNEL_ELEMENT_KINDS,
  TrackedReader,
  anchorOf,
  asElementId,
  draftElements,
  elementKindRowProblems,
  elementKindTable,
  executeCommand,
  findDisconnected,
  finish,
  guard,
  kindNatureOf,
  kindValue,
  recomputeDerived,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type ElementKindItem,
  type ModelState,
  type PackCommandDef,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, bindModelPacks, contribute, definePack, PACK_CONTRACT_VERSION, unbindModelPacks, withPackSet } from "../src/packs";
import { networkOf } from "../src/network";
import { z } from "zod";

const SETBACK: ElementKindItem = {
  kind: "k10site.constraint",
  label: "Site constraint",
  nature: "intent",
  values: [{ key: "k10site.setback", label: "Setback", unit: "ft", authored: true, min: 0 }],
};

const ADD_CONSTRAINT: PackCommandDef = {
  type: "k10site_add_constraint",
  schema: z.object({ type: z.literal("k10site_add_constraint"), id: z.string(), setback: z.number() }).strict(),
  execute: (model, command) =>
    guard(() => {
      const reader = new TrackedReader(model);
      const working = draftElements(model.elements);
      const id = asElementId(String(command.id));
      const raw: Record<string, unknown> = { id, version: 1, authoredRev: {}, kind: "k10site.constraint", values: { "k10site.setback": Number(command.setback) } };
      working[id] = raw as unknown as BimElement;
      return finish(reader, working, [id], [], () => []);
    }),
};

const SITE = definePack({ id: "k10site", name: "Site (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [SETBACK]), contribute(COMMAND_POINT, [ADD_CONSTRAINT])]);
const KERNEL = new Set<string>(KERNEL_ELEMENT_KINDS);
const everyone = () => true;

function demo(): ModelState {
  return recomputeDerived(createDemoModel("k10-record")).model;
}

describe("k10-record-kind-row", () => {
  it("a shape-less, end-less, anchor-less intent row passes conformance and reads as an intent", () => {
    expect(elementKindRowProblems([SETBACK], KERNEL)).toEqual([]);
    expect(kindNatureOf(SETBACK)).toBe("intent");
    expect(kindNatureOf({})).toBe("physical");
    for (const nature of ["record", "document", "k10site.parcel"]) expect(elementKindRowProblems([{ ...SETBACK, nature }], KERNEL)).toEqual([]);
  });

  it("conformance checks the faces: ends only on a physical kind, a known or namespaced nature, one upstream end", () => {
    expect(elementKindRowProblems([{ ...SETBACK, connectorEnds: { ends: [{ end: "in", role: "upstream" }] } }], KERNEL)).toEqual(["element kind k10site.constraint is an intent kind; only a physical kind has connector ends"]);
    expect(elementKindRowProblems([{ ...SETBACK, nature: "Building" }], KERNEL)).toEqual(['element kind k10site.constraint: nature "Building" must be physical, intent, record, document or "<pack>.<name>"']);
    const twoUp: ElementKindItem = { kind: "k10site.pipe", label: "Pipe", connectorEnds: { ends: [{ end: "a", role: "upstream" }, { end: "b", role: "upstream" }] } };
    expect(elementKindRowProblems([twoUp], KERNEL)).toEqual(["element kind k10site.pipe has 2 upstream ends; a kind has at most one"]);
    const rootWithUp: ElementKindItem = { kind: "k10site.src", label: "Source", connectorEnds: { root: true, ends: [{ end: "a", role: "upstream" }] } };
    expect(elementKindRowProblems([rootWithUp], KERNEL)).toEqual(["element kind k10site.src starts a tree, so it has no upstream end"]);
  });

  it("a pack command saves one; the store, the index, validation and the derived pass keep it", () => {
    const model = demo();
    bindModelPacks(model.modelId, PackSet.create([SITE]));
    try {
      const saved = withUpgradePolicy(everyone, () => executeCommand(model, { type: "k10site_add_constraint", id: "sc-1", setback: 25 }));
      if (!saved.ok) throw new Error(saved.error.message);
      const sc = saved.model.elements["sc-1"];
      if (!sc) throw new Error("not saved");
      withPackSet(PackSet.create([SITE]), () => {
        expect(elementKindTable().row("k10site.constraint")?.nature).toBe("intent");
        expect(kindValue(sc, "k10site.setback")).toBe(25);
        expect(anchorOf(sc)).toBeNull();
        expect(networkOf(saved.model).children("sc-1")).toEqual([]);
        expect(findDisconnected(saved.model)).not.toContain("sc-1");
        expect(validateModel(saved.model).filter((i) => i.elementIds.includes(asElementId("sc-1")))).toEqual([]);
        expect(recomputeDerived(saved.model).changedIds).toEqual([]);
      });
    } finally {
      unbindModelPacks(model.modelId);
    }
  });

  it("an older peer without the add-on keeps the record byte for byte through an unrelated edit", () => {
    const base = demo();
    const raw: Record<string, unknown> = { id: "sc-1", version: 1, authoredRev: {}, kind: "k10site.constraint", values: { "k10site.setback": 25 } };
    const stored = JSON.stringify(raw);
    const model: ModelState = { ...base, elements: { ...base.elements, "sc-1": raw as unknown as BimElement } };
    const r = withPackSet(PackSet.create([]), () => executeCommand(model, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 410 }));
    if (!r.ok) throw new Error(r.error.message);
    expect(JSON.stringify(r.model.elements["sc-1"])).toBe(stored);
    expect(r.changedIds).not.toContain("sc-1");
  });
});
