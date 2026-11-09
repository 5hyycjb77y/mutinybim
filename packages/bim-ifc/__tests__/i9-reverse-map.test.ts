/**
 * @jest-environment node
 *
 * i9-reverse-map: what a linked IFC product becomes is read from the class
 * registry's `ifc` homes, never from a list in the importer. Every built-in
 * class with a home maps back to itself; a pack's class (fire-protection
 * heads, which no built-in class takes) maps back with zero kernel or
 * importer edits, through its own import rule.
 *
 * Fails on round 8b's code: there is no reverse class map, no import rule
 * point and no import at all (`reverseClassMap`, `IFC_IMPORT_RULE_POINT`).
 */
import { BUILTIN_CLASSES, IFC_IMPORT_RULE_POINT, KERNEL_IMPORT_RULES, activeClassRegistry, builtinRegistry, reverseClassMap } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { FIRE_PROTECTION_TEST_PACK, HEAD_CLASS, HEAD_RULE } from "./fixtures/i9-fire-protection-pack";

describe("i9-reverse-map", () => {
  it("maps every built-in class with an IFC home back to itself", () => {
    const registry = builtinRegistry();
    const map = reverseClassMap(registry, KERNEL_IMPORT_RULES);
    const homed = BUILTIN_CLASSES.filter((c) => c.ifc && !c.abstract);
    expect(homed.length).toBeGreaterThan(20);
    for (const cls of homed) {
      const hint = cls.ifc;
      if (!hint) continue;
      const candidates = map.candidates({ entity: hint.entity, predefinedType: hint.predefinedType ?? null, objectType: hint.objectType ?? null }).map((c) => c.id);
      expect({ cls: cls.id, found: candidates.includes(cls.id) }).toEqual({ cls: cls.id, found: true });
    }
  });

  it("picks the class whose predefined type matches, and never one whose type differs", () => {
    const map = reverseClassMap(builtinRegistry(), KERNEL_IMPORT_RULES);
    expect(map.candidates({ entity: "IFCSPACE", predefinedType: "INTERNAL", objectType: null }).map((c) => c.id)).toEqual(["arch.room"]);
    expect(map.candidates({ entity: "IfcSpace", predefinedType: "SPACE", objectType: null }).map((c) => c.id)).toEqual(["gen.space"]);
    const either = map.candidates({ entity: "IfcSpace", predefinedType: "NOTDEFINED", objectType: null }).map((c) => c.id);
    expect(new Set(either)).toEqual(new Set(["arch.room", "gen.space"]));
    // Only one of the two has a rule, so an unspecified space comes in as a room.
    const chosen = map.choose({ entity: "IfcSpace", predefinedType: null, objectType: null });
    expect(chosen.ok && chosen.choice.cls.id).toBe("arch.room");
  });

  it("a class's recognition picks the kernel rule for its kind, and its fixed fields ride along", () => {
    const map = reverseClassMap(builtinRegistry(), KERNEL_IMPORT_RULES);
    const door = map.choose({ entity: "IfcDoor", predefinedType: "DOOR", objectType: null });
    expect(door.ok && door.choice.rule.id).toBe("kernel.opening");
    expect(door.ok && door.choice.fields).toEqual({ openingType: "door" });
    const segment = map.choose({ entity: "IfcDuctSegment", predefinedType: "RIGIDSEGMENT", objectType: null });
    expect(segment.ok && segment.choice.rule.id).toBe("kernel.run_segment");
    expect(segment.ok && segment.choice.fields).toEqual({ domain: "duct" });
    const part = map.choose({ entity: "IfcAirTerminal", predefinedType: "DIFFUSER", objectType: null });
    expect(part.ok && part.choice.rule.id).toBe("kernel.part");
  });

  it("a pack's class with a home imports through its own rule, with zero kernel edits", () => {
    const product = { entity: "IfcFireSuppressionTerminal", predefinedType: "SPRINKLER", objectType: null };
    const without = reverseClassMap(builtinRegistry(), KERNEL_IMPORT_RULES).choose(product);
    expect(without).toEqual({ ok: false, cls: null, reason: "no class in this model takes it" });
    const set = PackSet.create([FIRE_PROTECTION_TEST_PACK]);
    const withPack = withPackSet(set, () => reverseClassMap(activeClassRegistry(), set.items(IFC_IMPORT_RULE_POINT)).choose(product));
    expect(withPack.ok && withPack.choice.cls.id).toBe(HEAD_CLASS);
    expect(withPack.ok && withPack.choice.rule.id).toBe(HEAD_RULE);
    // The kernel's own rules are still there beside the pack's.
    expect(set.items(IFC_IMPORT_RULE_POINT).map((r) => r.id)).toEqual(expect.arrayContaining(["kernel.wall", HEAD_RULE]));
  });
});
