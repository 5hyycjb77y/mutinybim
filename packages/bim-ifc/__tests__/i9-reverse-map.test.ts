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
import { BUILTIN_CLASSES, CLASS_POINT, IFC_IMPORT_RULE_POINT, KERNEL_IMPORT_RULES, activeClassRegistry, builtinRegistry, reverseClassMap, type ImportRuleDef } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { readIfcSource } from "../src";
import { FIRE_PROTECTION_TEST_PACK, HEAD_CLASS, HEAD_RULE } from "./fixtures/i9-fire-protection-pack";
import { IfcText } from "./i9-fixtures";

/** A trade add-on that wants its own behaviour for one fitting entity: a class homed on that entity, with its own rule. */
const OWN_FITTING_CLASS = "tdf.fitting";
const OWN_FITTING_RULE = "tdf.fitting_rule";
const ownFittingRule: ImportRuleDef = { id: OWN_FITTING_RULE, label: "Test fittings", convert: () => ({ ok: false, reason: "a test rule" }) };
const OWN_FITTING_TEST_PACK = definePack({ id: "tdf", name: "Test duct fittings", version: "1.0.0", kernel: "^1.4.0" }, [
  contribute(CLASS_POINT, [{ id: OWN_FITTING_CLASS, label: "Test fittings", discipline: "mechanical", ifc: { entity: "IfcDuctFitting", import: { rule: OWN_FITTING_RULE } }, recognize: { elementKinds: ["run_fitting"], where: [{ path: "classId", op: "equals", value: OWN_FITTING_CLASS }] } }]),
  contribute(IFC_IMPORT_RULE_POINT, [ownFittingRule]),
]);

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

  it("a class homed on a general entity takes a product of a more specific one when the reader says it is one (#59)", () => {
    const map = reverseClassMap(builtinRegistry(), KERNEL_IMPORT_RULES);
    // One class covers a fitting on any run; the writer picks the duct, pipe or cable carrier fitting.
    const bare = { entity: "IfcDuctFitting", predefinedType: "BEND", objectType: null };
    expect(map.candidates(bare)).toEqual([]);
    expect(map.choose(bare)).toEqual({ ok: false, cls: null, reason: "no class in this model takes it" });
    for (const entity of ["IfcDuctFitting", "IfcPipeFitting", "IfcCableCarrierFitting"]) {
      const fitting = map.choose({ ...bare, entity, generalEntities: ["IfcFlowFitting"] });
      expect(fitting.ok && fitting.choice.cls.id).toBe("mep.run_fitting");
      expect(fitting.ok && fitting.choice.rule.id).toBe("kernel.run_fitting");
    }
    // A class that names the product's own entity still wins over one that names a general entity.
    const segment = map.choose({ entity: "IfcDuctSegment", predefinedType: null, objectType: null, generalEntities: ["IfcFlowFitting"] });
    expect(segment.ok && segment.choice.cls.id).toBe("mep.duct");
    // The reader says so for the fitting entities the writer writes, and for nothing else.
    const read = (entity: string) => {
      const t = IfcText.start();
      t.storey("Level 1", 0);
      t.product("Level 1", entity, "X", [0, 0, 0], t.body([t.extrude(t.rect(100, 100), 100)]));
      return readIfcSource(t.text(), { sourceId: "s", label: "S", disciplines: [] }).products[0]?.generalEntities;
    };
    expect(read("IFCDUCTFITTING")).toEqual(["IfcFlowFitting"]);
    expect(read("IFCPIPEFITTING")).toEqual(["IfcFlowFitting"]);
    expect(read("IFCCABLECARRIERFITTING")).toEqual(["IfcFlowFitting"]);
    expect(read("IFCDUCTSEGMENT")).toBeUndefined();
    expect(read("IFCWALL")).toBeUndefined();
  });

  it("an add-on's class homed on the specific fitting entity wins over the general fallback; other fittings still fall back (#135)", () => {
    const set = PackSet.create([OWN_FITTING_TEST_PACK]);
    withPackSet(set, () => {
      const map = reverseClassMap(activeClassRegistry(), set.items(IFC_IMPORT_RULE_POINT));
      const duct = map.choose({ entity: "IfcDuctFitting", predefinedType: "BEND", objectType: null, generalEntities: ["IfcFlowFitting"] });
      expect(duct.ok && duct.choice.cls.id).toBe(OWN_FITTING_CLASS);
      expect(duct.ok && duct.choice.rule.id).toBe(OWN_FITTING_RULE);
      // The add-on said nothing about pipe fittings, so those still come in through the one general class.
      const pipe = map.choose({ entity: "IfcPipeFitting", predefinedType: "BEND", objectType: null, generalEntities: ["IfcFlowFitting"] });
      expect(pipe.ok && pipe.choice.cls.id).toBe("mep.run_fitting");
      expect(pipe.ok && pipe.choice.rule.id).toBe("kernel.run_fitting");
    });
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
