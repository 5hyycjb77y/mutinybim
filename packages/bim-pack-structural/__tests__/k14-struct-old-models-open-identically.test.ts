/**
 * @jest-environment node
 *
 * Round 14 lane K14 step 3: Structural becomes first-party and its four
 * classes leave the kernel. A model stored with Structural switched on (the
 * two-bay frame: steel beams and columns, pad footings, a roof deck), and
 * records stored with the kernel's `struct.column` / `struct.beam` as their
 * explicit class, reopen with the same classes in a model that pins nothing,
 * and opening rewrites no stored byte. A stored Structural pin or switch is
 * not reported as an add-on this host lacks.
 *
 * Fails on round 13's code: Structural was a per-model add-on, so in a model
 * that pins nothing `struct.beam_steel` and the other frame classes were
 * unknown, and with Structural left off the host list its pin was missing.
 */
import { canonicalJson, DEFAULT_SETTINGS, pinnedPacks, recomputeDerived, resolveModelSetup, type ModelState } from "@permitzip/bim-kernel";
import { installedFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { activeClassRegistry, buildClassIndex } from "@permitzip/bim-kernel/registry";
import { asElementId, type BimElement } from "@permitzip/bim-kernel/types";
import { STRUCT_PACK_ID, STRUCT_PACK_VERSION } from "../src";
import { twoBayFrame } from "./two-bay-frame";

const classIdOf = (el: BimElement | undefined): string | undefined => (el && "classId" in el && typeof el.classId === "string" ? el.classId : undefined);

/** The frame as round 13 stored it, plus a column and a beam stored with the kernel's own structural classes. */
function storedFrame(): ModelState {
  const frame = twoBayFrame();
  const column = frame.elements[asElementId("C1A")];
  const beam = frame.elements[asElementId("B1")];
  if (!column || !beam) throw new Error("fixture changed");
  const plainColumn = { ...column, id: asElementId("C-plain"), classId: "struct.column" } as BimElement;
  const plainBeam = { ...beam, id: asElementId("B-plain"), classId: "struct.beam" } as BimElement;
  return { ...frame, settings: { ...DEFAULT_SETTINGS }, elements: { ...frame.elements, [plainColumn.id]: plainColumn, [plainBeam.id]: plainBeam } };
}

describe("k14 old Structural models open identically", () => {
  it("Structural is installed in this process, so a model that pins nothing has it", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).toContain(STRUCT_PACK_ID);
  });

  it("every stored structural class id still names a class, and each record is in its class", () => {
    const head = storedFrame();
    const registry = activeClassRegistry();
    const index = buildClassIndex(registry, head);
    const expected: Record<string, string> = { B2: "struct.beam_steel", C2A: "struct.column_steel", F2A: "struct.footing_pad", "DECK-1": "struct.roof_deck", "C-plain": "struct.column", "B-plain": "struct.beam" };
    for (const [id, cls] of Object.entries(expected)) {
      expect([id, classIdOf(head.elements[asElementId(id)])]).toEqual([id, cls]);
      expect([id, registry.getClass(cls)?.id]).toEqual([id, cls]);
      expect([id, index.classesOf(asElementId(id)).includes(cls)]).toEqual([id, true]);
    }
    expect(registry.ancestors("struct.beam_steel")).toEqual(expect.arrayContaining(["struct.beam_steel", "struct.beam"]));
    expect(registry.ancestors("struct.footing_pad")).toEqual(expect.arrayContaining(["struct.footing_pad", "struct.footing"]));
  });

  it("opening rewrites no stored record", () => {
    const head = storedFrame();
    const before = Object.fromEntries(Object.keys(head.elements).map((id) => [id, canonicalJson(head.elements[id])]));
    const opened = recomputeDerived(head).model;
    const after = Object.fromEntries(Object.keys(head.elements).map((id) => [id, canonicalJson(opened.elements[id])]));
    expect(after).toEqual(before);
  });

  it("a stored Structural pin is not an add-on this host lacks", () => {
    const pin = { id: STRUCT_PACK_ID, version: STRUCT_PACK_VERSION };
    expect(STRUCT_PACK_VERSION).toBe("0.1.0");
    expect(pinnedPacks([pin], []).missing).toEqual([]);
    expect(resolveModelSetup({ hasEntries: true, pins: [pin], firmDisciplines: [], key: "k14" }, []).missing).toEqual([]);
    expect(pinnedPacks([{ id: "civil", version: "0.1.0" }], []).missing).toEqual([{ id: "civil", version: "0.1.0" }]);
  });
});
